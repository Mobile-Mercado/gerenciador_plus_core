import { AppError } from '../../domain/errors/AppError.js';
import { ICONE_DO_CONJUNTO_MAX_BYTES } from '../../domain/loja/aparencias.js';
import { custoDeImagemUsd } from '../../domain/ai/precosIa.js';

// Criador de icones com IA na aba Icones do Admin (Thay, 27/11): gera o icone de UMA categoria e
// devolve a imagem para a previa. Nada e gravado no conjunto aqui: o Admin manda o arquivo pela
// rota de troca de icone so no "Salvar conjunto". GPT Image 2.5 flare: a linha 2.x com fundo
// transparente suportado (na 2.6 a documentacao nao garante o transparente).
export const MODELO_DE_ICONE = 'gpt-image-2.5-flare';
export const ESTILOS_DE_ICONE = Object.freeze({
  '3d': 'ilustração 3D realista, volumes suaves, luz de estúdio suave, cores vivas e naturais',
  linha: 'ícone de linha fina, traço uniforme cinza-escuro, sem preenchimento, minimalista',
  plano: 'ilustração plana colorida, formas simples, sem sombras, cores alegres',
  aquarela: 'ilustração em aquarela, bordas suaves, tons claros e transparentes',
});
export const QUALIDADES_DE_ICONE = Object.freeze(['low', 'medium', 'high']);
const LADO_DO_ICONE = 256;
const MAX_REFERENCIAS = 4;

function recusa(mensagem, code, statusCode = 400) {
  return new AppError(mensagem, { statusCode, code });
}

export function pedidoDoIcone({ categoria, estilo, detalhes = '', comReferencia = false }) {
  const partes = [
    `Ícone para a categoria "${categoria}" de um aplicativo de supermercado.`,
    'Um único objeto ou grupo de produtos típicos da categoria, centralizado, ocupando cerca de 80% do quadro.',
    'Sem texto, sem letras, sem marcas, sem moldura e sem fundo.',
  ];
  if (comReferencia) partes.push('Siga exatamente o mesmo estilo, traço, iluminação e paleta das imagens de referência.');
  else partes.push(`Estilo: ${ESTILOS_DE_ICONE[estilo] || ESTILOS_DE_ICONE['3d']}.`);
  const extra = String(detalhes || '').trim();
  if (extra) partes.push(`Detalhes: ${extra}`);
  return partes.join(' ');
}

// Reduz para 256 x 256 e WEBP dentro do limite do icone de conjunto (20 KB).
// sharp carregado na hora, como nos outros arquivos de imagem (aqui so quando gera).
export async function iconeNoLimite(conteudo) {
  const { default: sharp } = await import('sharp');
  const base = sharp(conteudo, { failOn: 'none' }).resize(LADO_DO_ICONE, LADO_DO_ICONE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } });
  for (const quality of [90, 80, 70, 60, 50, 40, 30]) {
    const saida = await base.clone().webp({ quality, alphaQuality: 90 }).toBuffer();
    if (saida.length <= ICONE_DO_CONJUNTO_MAX_BYTES) return saida;
  }
  throw recusa('A imagem gerada ficou acima de 20 KB. Tente de novo ou na qualidade Rápida.', 'icone_ia_grande');
}

export class IconesComIa {
  constructor({ apiKey, conjuntosDeIcones = null, usoIaAdmin = null, fetcher = globalThis.fetch, reduzir = iconeNoLimite }) {
    this.apiKey = apiKey;
    this.reduzir = reduzir;
    this.conjuntosDeIcones = conjuntosDeIcones;
    this.usoIaAdmin = usoIaAdmin;
    this.fetcher = fetcher;
  }

  // Ate 4 icones do conjunto de referencia, menos o da propria categoria.
  async referencias(conjuntoId, categoriaId) {
    if (!conjuntoId || !this.conjuntosDeIcones) return [];
    const conjunto = await this.conjuntosDeIcones.ler(conjuntoId);
    const urls = Object.entries(conjunto.icones || {})
      .filter(([id, icone]) => id !== categoriaId && icone?.url)
      .slice(0, MAX_REFERENCIAS)
      .map(([, icone]) => icone.url);
    const imagens = [];
    for (const url of urls) {
      const resposta = await this.fetcher(url);
      if (!resposta.ok) continue;
      const bruto = Buffer.from(await resposta.arrayBuffer());
      const { default: sharp } = await import('sharp');
      imagens.push(await sharp(bruto, { failOn: 'none' }).resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer());
    }
    return imagens;
  }

  async chamar({ pedido, qualidade, transparente, referencias }) {
    const comum = { model: MODELO_DE_ICONE, prompt: pedido, size: '1024x1024', quality: qualidade, output_format: 'png', background: transparente ? 'transparent' : 'opaque', n: 1 };
    let resposta;
    if (referencias.length) {
      const corpo = new FormData();
      Object.entries(comum).forEach(([chave, valor]) => corpo.append(chave, String(valor)));
      referencias.forEach((imagem, indice) => corpo.append('image[]', new Blob([imagem], { type: 'image/png' }), `referencia-${indice + 1}.png`));
      resposta = await this.fetcher('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}` }, body: corpo });
    } else {
      resposta = await this.fetcher('https://api.openai.com/v1/images/generations', {
        method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(comum),
      });
    }
    const json = await resposta.json().catch(() => ({}));
    if (!resposta.ok) {
      const motivo = json?.error?.message ? ` (${String(json.error.message).slice(0, 160)})` : '';
      throw recusa(`A OpenAI não gerou o ícone${motivo}.`, 'icone_ia_falhou', 502);
    }
    const base64 = json?.data?.[0]?.b64_json;
    if (!base64) throw recusa('A OpenAI não devolveu a imagem.', 'icone_ia_vazio', 502);
    return { imagem: Buffer.from(base64, 'base64'), uso: json.usage || null };
  }

  async gerar({ categoriaId, categoria, estilo = '3d', detalhes = '', qualidade = 'medium', transparente = true, referenciaConjuntoId = null, conjuntoId = null }, ator = {}) {
    if (!this.apiKey) throw recusa('A chave da OpenAI não está configurada no Core.', 'icone_ia_sem_chave', 503);
    if (!QUALIDADES_DE_ICONE.includes(qualidade)) throw recusa('Qualidade inválida.', 'icone_ia_qualidade');
    const referencias = await this.referencias(referenciaConjuntoId, categoriaId);
    const pedido = pedidoDoIcone({ categoria, estilo, detalhes, comReferencia: referencias.length > 0 });
    const { imagem, uso } = await this.chamar({ pedido, qualidade, transparente, referencias });
    const icone = await this.reduzir(imagem);
    const custoUsd = custoDeImagemUsd(MODELO_DE_ICONE, uso);
    if (this.usoIaAdmin) {
      await this.usoIaAdmin.registrar({
        tipo: 'icone_de_categoria', modelo: MODELO_DE_ICONE, qualidade, categoriaId: categoriaId || null, conjuntoId: conjuntoId || null,
        referenciaConjuntoId: referencias.length ? referenciaConjuntoId : null, uso, custoUsd, por: ator.email || ator.uid || null,
      }).catch(() => {});
    }
    return { conteudoBase64: icone.toString('base64'), tipoArquivo: 'image/webp', custoUsd, modelo: MODELO_DE_ICONE };
  }
}
