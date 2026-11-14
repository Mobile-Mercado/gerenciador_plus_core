import { randomUUID } from 'node:crypto';
import { AppError } from '../../domain/errors/AppError.js';
import { camposDoBanner, documentoRest, medirImagem } from '../loja/BannersDaLoja.js';
import situacaoDoBannerModulo from '../../../functions/situacaoDoBanner.js';

const { situacaoDoBanner } = situacaoDoBannerModulo;

// Banners da loja pelo Admin (cola B56-08, B5), no mesmo lugar e com os mesmos campos que o app
// Mobile Gerenciador usa: estabelecimentos/{loja}/Banners/{id} com type, image { path, storageRef,
// size em decimal }, startAt, endAt, status, started, products, category e showTimer (o contador,
// banner_adapter.dart:19 e :38). Limites, medidas e peso do app (B56-08, A3): principal 5, vertical
// 10, posVertical 5 e popup 1, contando os ligados e ainda nao encerrados (inclusive os agendados);
// principal e posVertical 1080 x 500, vertical 400 x 700, popup sem medida; ate 1 MB em todos. O
// contador so vale em principal e posVertical. O banner capa continua sendo o coverImageUrl da loja.
export const TIPOS_DE_BANNER = Object.freeze({
  principal: Object.freeze({ limite: 5, largura: 1080, altura: 500, contador: true }),
  vertical: Object.freeze({ limite: 10, largura: 400, altura: 700, contador: false }),
  posVertical: Object.freeze({ limite: 5, largura: 1080, altura: 500, contador: true }),
  popup: Object.freeze({ limite: 1, largura: null, altura: null, contador: false }),
});
export const PESO_MAXIMO_DO_BANNER = 1024 * 1024;
const EXTENSOES = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' });

const LIGADO = Object.freeze({ status: true, started: true, aguardandoInicio: false });
const AGUARDANDO = Object.freeze({ status: false, started: false, aguardandoInicio: true });
const DESLIGADO = Object.freeze({ status: false, started: false, aguardandoInicio: false });

function recusa(mensagem, code, statusCode = 400, details) {
  return new AppError(mensagem, { statusCode, code, details });
}

const data = (valor) => {
  const quando = typeof valor?.toDate === 'function' ? valor.toDate() : (valor ? new Date(valor) : null);
  return quando && !Number.isNaN(quando.getTime()) ? quando : null;
};

// Conta para o limite: ligado (ou aguardando o inicio) e ainda nao encerrado.
export function ocupaVaga(banner, agora) {
  const fim = data(banner.endAt);
  if (!fim || fim.getTime() <= agora) return false;
  return banner.status === true || banner.aguardandoInicio === true;
}

export class BannersNoAdmin {
  constructor({
    firestore, bucket, restFirestore, medir = medirImagem, agora = () => Date.now(), novoId = () => randomUUID().replace(/-/g, '').slice(0, 20),
  }) {
    this.firestore = firestore;
    this.bucket = bucket;
    this.rest = restFirestore;
    this.medir = medir;
    this.agora = agora;
    this.novoId = novoId;
  }

  caminho(lojaId, bannerId) {
    return `estabelecimentos/${lojaId}/Banners/${bannerId}`;
  }

  async loja(lojaId) {
    const loja = await this.firestore.collection('estabelecimentos').doc(String(lojaId || '')).get();
    if (!loja.exists) throw recusa('Loja não encontrada.', 'loja_nao_encontrada', 404);
    return loja;
  }

  tipoValido(tipo) {
    if (!TIPOS_DE_BANNER[tipo]) throw recusa('Tipo de banner inválido.', 'banner_tipo_invalido');
    return TIPOS_DE_BANNER[tipo];
  }

  periodo({ inicio, fim }) {
    const comeco = new Date(inicio);
    const termino = new Date(fim);
    if (Number.isNaN(comeco.getTime()) || Number.isNaN(termino.getTime())) throw recusa('Informe o início e o fim do banner.', 'banner_sem_periodo');
    if (termino <= comeco) throw recusa('O fim do banner precisa ser depois do início.', 'banner_periodo_invalido');
    return { inicio: comeco, fim: termino };
  }

  paraATela(id, banner, agora) {
    const tipo = banner.type || 'principal';
    return {
      id,
      tipo,
      imagemUrl: banner.image?.path || null,
      largura: Number(banner.image?.size?.width) || null,
      altura: Number(banner.image?.size?.height) || null,
      inicio: data(banner.startAt)?.toISOString() || null,
      fim: data(banner.endAt)?.toISOString() || null,
      ligado: banner.status === true || banner.aguardandoInicio === true,
      contador: banner.showTimer === true,
      situacao: situacaoDoBanner(banner, agora),
      ocupaVaga: ocupaVaga(banner, agora),
    };
  }

  // B5.a: os banners da loja por tipo, com a contagem das vagas, e o banner capa.
  async listar(lojaId) {
    const loja = await this.loja(lojaId);
    const agora = this.agora();
    const snapshot = await loja.ref.collection('Banners').get();
    const banners = snapshot.docs.map((documento) => this.paraATela(documento.id, documento.data() || {}, agora));
    const porTipo = Object.fromEntries(Object.entries(TIPOS_DE_BANNER).map(([tipo, regra]) => {
      const doTipo = banners.filter((banner) => banner.tipo === tipo && banner.situacao !== 'encerrado')
        .sort((a, b) => String(a.inicio).localeCompare(String(b.inicio)));
      return [tipo, { ...regra, ocupados: doTipo.filter((banner) => banner.ocupaVaga).length, banners: doTipo }];
    }));
    return { lojaId: loja.id, tipos: porTipo, capaUrl: loja.data()?.coverImageUrl || null };
  }

  async conferirImagem(tipo, conteudo, tipoArquivo) {
    const regra = this.tipoValido(tipo);
    if (!conteudo?.length) throw recusa('Envie a imagem do banner.', 'imagem_vazia');
    const extensao = EXTENSOES[String(tipoArquivo || '').split(';')[0].trim()];
    if (!extensao) throw recusa('Envie o banner em JPG, PNG ou WEBP.', 'banner_formato');
    if (conteudo.length > PESO_MAXIMO_DO_BANNER) {
      throw recusa(`O banner tem ${Math.ceil(conteudo.length / 1024)} KB. O limite é 1 MB: reduza a imagem e envie de novo.`, 'banner_peso');
    }
    const { largura, altura } = await this.medir(conteudo);
    if (regra.largura && (largura !== regra.largura || altura !== regra.altura)) {
      throw recusa(`Este banner precisa ter ${regra.largura} x ${regra.altura} pixels (este tem ${largura} x ${altura}).`, 'banner_tamanho_errado', 400, { largura, altura });
    }
    return { largura, altura, extensao, contentType: String(tipoArquivo).split(';')[0].trim() };
  }

  async gravarImagem(lojaId, conteudo, { extensao, contentType }) {
    if (!this.bucket) throw recusa('Armazenamento de imagens não configurado.', 'imagem_sem_bucket', 503);
    // Mesmo lugar dos banners do app gerenciador e do painel.
    const storageRef = `estabelecimentos/${lojaId}/banners/${this.agora()}.${extensao}`;
    const token = randomUUID();
    await this.bucket.file(storageRef).save(conteudo, { contentType, metadata: { metadata: { firebaseStorageDownloadTokens: token } } });
    const path = `https://firebasestorage.googleapis.com/v0/b/${this.bucket.name}/o/${encodeURIComponent(storageRef)}?alt=media&token=${token}`;
    return { path, storageRef };
  }

  async banner(lojaId, bannerId) {
    if (!/^[^/]{1,120}$/.test(String(bannerId || ''))) throw recusa('Banner não encontrado.', 'banner_nao_encontrado', 404);
    const atual = await this.firestore.doc(this.caminho(lojaId, bannerId)).get();
    if (!atual.exists) throw recusa('Banner não encontrado.', 'banner_nao_encontrado', 404);
    return atual;
  }

  // B5.a e B5.b: banner novo de um tipo, dentro do limite do tipo.
  async criar(lojaId, tipo, conteudo, tipoArquivo, { inicio, fim }) {
    const loja = await this.loja(lojaId);
    const regra = this.tipoValido(tipo);
    const datas = this.periodo({ inicio, fim });
    const agora = this.agora();
    const existentes = (await loja.ref.collection('Banners').get()).docs.map((documento) => documento.data() || {});
    const ocupados = existentes.filter((banner) => (banner.type || 'principal') === tipo && ocupaVaga(banner, agora)).length;
    if (ocupados >= regra.limite) {
      throw recusa(`Este tipo já tem ${ocupados} de ${regra.limite} banners. Apague ou desligue um antes de enviar outro.`, 'banner_limite', 409, { ocupados, limite: regra.limite });
    }
    const imagem = await this.conferirImagem(tipo, conteudo, tipoArquivo);
    const gravado = await this.gravarImagem(loja.id, conteudo, imagem);
    const id = this.novoId();
    const ligacao = datas.inicio.getTime() > agora ? AGUARDANDO : null;
    const campos = {
      ...camposDoBanner({ id, ...gravado, largura: imagem.largura, altura: imagem.altura, ...datas, tipo, products: [], novo: true, ligacao }),
      category: null,
      showTimer: false,
    };
    await this.rest.gravar(this.caminho(loja.id, id), documentoRest(campos), { criar: true });
    return this.ler(loja.id, id);
  }

  async ler(lojaId, bannerId) {
    const atual = await this.banner(lojaId, bannerId);
    return this.paraATela(atual.id, atual.data() || {}, this.agora());
  }

  // Troca a imagem (mesma medida do tipo); o arquivo antigo sai do Storage.
  async trocarImagem(lojaId, bannerId, conteudo, tipoArquivo) {
    const atual = await this.banner(lojaId, bannerId);
    const dados = atual.data() || {};
    const imagem = await this.conferirImagem(dados.type || 'principal', conteudo, tipoArquivo);
    const gravado = await this.gravarImagem(lojaId, conteudo, imagem);
    const campos = { image: camposDoBanner({ ...gravado, largura: imagem.largura, altura: imagem.altura }).image };
    await this.rest.gravar(this.caminho(lojaId, bannerId), documentoRest(campos), { mascara: ['image'] });
    const antigo = dados.image?.storageRef;
    if (antigo && antigo !== gravado.storageRef && this.bucket) this.bucket.file(antigo).delete().catch(() => {});
    return { banner: await this.ler(lojaId, bannerId), antes: { imagem: antigo || null } };
  }

  // Datas, ligar/desligar e contador, so os enviados. Ligar com inicio no futuro fica aguardando.
  async alterar(lojaId, bannerId, { inicio, fim, ligado, contador } = {}) {
    const atual = await this.banner(lojaId, bannerId);
    const dados = atual.data() || {};
    const tipo = dados.type || 'principal';
    const agora = this.agora();
    const campos = {};
    const antes = {};
    if (inicio !== undefined || fim !== undefined) {
      const datas = this.periodo({ inicio: inicio ?? data(dados.startAt), fim: fim ?? data(dados.endAt) });
      campos.startAt = datas.inicio;
      campos.endAt = datas.fim;
      antes.inicio = data(dados.startAt)?.toISOString() || null;
      antes.fim = data(dados.endAt)?.toISOString() || null;
    }
    const inicioFinal = campos.startAt || data(dados.startAt);
    const fimFinal = campos.endAt || data(dados.endAt);
    const estavaLigado = dados.status === true || dados.aguardandoInicio === true;
    const ligar = ligado === undefined ? estavaLigado : ligado;
    if (ligado !== undefined) antes.ligado = estavaLigado;
    if (ligado !== undefined || campos.startAt) {
      if (ligar) {
        if (!fimFinal || fimFinal.getTime() <= agora) throw recusa('Banner encerrado não liga: mude o fim antes.', 'banner_encerrado', 409);
        if (!estavaLigado) {
          const outros = (await this.firestore.collection('estabelecimentos').doc(lojaId).collection('Banners').get()).docs
            .filter((documento) => documento.id !== atual.id && (documento.data()?.type || 'principal') === tipo && ocupaVaga(documento.data() || {}, agora)).length;
          if (outros >= TIPOS_DE_BANNER[tipo].limite) {
            throw recusa(`Este tipo já tem ${outros} de ${TIPOS_DE_BANNER[tipo].limite} banners ligados.`, 'banner_limite', 409);
          }
        }
        Object.assign(campos, inicioFinal && inicioFinal.getTime() > agora ? AGUARDANDO : LIGADO);
      } else {
        Object.assign(campos, DESLIGADO);
      }
    }
    if (contador !== undefined) {
      if (!TIPOS_DE_BANNER[tipo]?.contador) throw recusa('O contador só vale nos banners Principal e Abaixo do vertical.', 'banner_sem_contador');
      campos.showTimer = contador === true;
      antes.contador = dados.showTimer === true;
    }
    if (!Object.keys(campos).length) throw recusa('Nada para gravar.', 'banner_sem_mudancas');
    await this.rest.gravar(this.caminho(lojaId, bannerId), documentoRest(campos), { mascara: Object.keys(campos) });
    return { banner: await this.ler(lojaId, bannerId), antes, campos: Object.keys(campos) };
  }

  // Apaga o documento e o arquivo.
  async apagar(lojaId, bannerId) {
    const atual = await this.banner(lojaId, bannerId);
    const dados = atual.data() || {};
    await atual.ref.delete();
    if (dados.image?.storageRef && this.bucket) this.bucket.file(dados.image.storageRef).delete().catch(() => {});
    return { id: bannerId, apagado: true, antes: { tipo: dados.type || null, imagem: dados.image?.storageRef || null } };
  }
}
