import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { AppError } from '../../domain/errors/AppError.js';

// Imagens da loja (decisao do Thay de 13/10/2026): o app e o painel mandam a foto como sai do
// celular, ate 20 MB; o servidor gira pela orientacao da camera, reduz e compacta para WEBP
// de ate 300 KB. Foto de produto nao passa por aqui (continua com a regra de 40 KB).
export const LIMITE_ENTRADA_BYTES = 20 * 1024 * 1024;
export const LIMITE_SAIDA_BYTES = 300 * 1024;
export const TIPOS_DE_IMAGEM = Object.freeze({
  logo: { campo: 'chatProfileImageUrl', largura: 512, altura: 512 },
  fachada: { campo: 'coverImageUrl', largura: 1600, altura: 1200 },
  splash: { campo: 'splashImageUrl', largura: 1080, altura: 1920 },
  loading: { campo: 'loadingImageUrl', largura: 512, altura: 512 },
});

export const MENSAGEM_ACIMA_DO_LIMITE = 'A foto passa de 20 MB. Tire a foto de novo com resolução menor ou envie uma captura de tela dela.';
// Teto de pixels por foto (50 milhoes): acima disso o sharp nem decodifica, para nao estourar a
// memoria da instancia (512 MB) com uma imagem enorme e pequena em bytes.
export const LIMITE_PIXELS = 50_000_000;
const OPCOES_DE_ENTRADA = Object.freeze({ failOn: 'none', limitInputPixels: LIMITE_PIXELS });

// Uma imagem por vez por instancia: a proxima so comeca quando a anterior termina.
let fila = Promise.resolve();
export function umaPorVez(trabalho) {
  const vez = fila.then(trabalho, trabalho);
  fila = vez.catch(() => {});
  return vez;
}

export function erroDeImagem(error) {
  if (error instanceof AppError) return error;
  if (/pixel limit/i.test(String(error?.message))) {
    return new AppError('A foto tem resolução alta demais (mais de 50 megapixels). Reduza a foto ou envie uma captura de tela dela.', {
      statusCode: 400,
      code: 'imagem_pixels_demais',
    });
  }
  return new AppError('Não deu para abrir esta foto. Envie uma foto em JPG, PNG ou WEBP.', {
    statusCode: 400,
    code: 'imagem_ilegivel',
  });
}

export function tipoDeImagem(tipo) {
  const config = TIPOS_DE_IMAGEM[tipo];
  if (!config) {
    throw new AppError('Tipo de imagem inválido.', { statusCode: 400, code: 'imagem_tipo_invalido' });
  }
  return config;
}

// Reduz ate caber: primeiro baixa a qualidade, depois o tamanho, ate 300 KB.
export function converterParaWebp(conteudo, medidas) {
  return umaPorVez(() => converter(conteudo, medidas));
}

async function converter(conteudo, { largura, altura }) {
  if (!conteudo?.length) {
    throw new AppError('Envie uma foto.', { statusCode: 400, code: 'imagem_vazia' });
  }
  if (conteudo.length > LIMITE_ENTRADA_BYTES) {
    throw new AppError(MENSAGEM_ACIMA_DO_LIMITE, { statusCode: 413, code: 'imagem_acima_do_limite' });
  }
  let escala = 1;
  try {
    for (let rodada = 0; rodada < 8; rodada += 1) {
      for (const qualidade of [82, 70, 58, 46]) {
        const saida = await sharp(conteudo, OPCOES_DE_ENTRADA)
          .rotate()
          .resize({
            width: Math.round(largura * escala),
            height: Math.round(altura * escala),
            fit: 'inside',
            withoutEnlargement: true,
          })
          .webp({ quality: qualidade })
          .toBuffer();
        if (saida.length <= LIMITE_SAIDA_BYTES) return saida;
      }
      escala *= 0.8;
    }
  } catch (error) {
    throw erroDeImagem(error);
  }
  throw new AppError('Não deu para reduzir esta foto. Envie outra.', { statusCode: 400, code: 'imagem_nao_reduziu' });
}

export class ImagensDaLoja {
  constructor({ firestore, bucket, converter = converterParaWebp, agora = () => Date.now() }) {
    this.firestore = firestore;
    this.bucket = bucket;
    this.converter = converter;
    this.agora = agora;
  }

  // Grava no Storage (mesma pasta das imagens da loja de hoje) e devolve o campo e a URL.
  async salvar(lojaId, tipo, conteudo) {
    const config = tipoDeImagem(tipo);
    if (!this.bucket) {
      throw new AppError('Armazenamento de imagens não configurado.', { statusCode: 503, code: 'imagem_sem_bucket' });
    }
    const webp = await this.converter(conteudo, config);
    const caminho = `appMobile/companyImages/${lojaId}/${tipo}_${this.agora()}.webp`;
    const token = randomUUID();
    await this.bucket.file(caminho).save(webp, {
      contentType: 'image/webp',
      metadata: { metadata: { firebaseStorageDownloadTokens: token } },
    });
    const url = `https://firebasestorage.googleapis.com/v0/b/${this.bucket.name}/o/${encodeURIComponent(caminho)}?alt=media&token=${token}`;
    return { campo: config.campo, url, bytes: webp.length };
  }

  // Salva e grava o campo no documento da loja.
  async trocar(lojaId, tipo, conteudo, extras = {}) {
    const { campo, url, bytes } = await this.salvar(lojaId, tipo, conteudo);
    await this.firestore.collection('estabelecimentos').doc(lojaId).update({ [campo]: url, ...extras });
    return { campo, url, bytes };
  }
}
