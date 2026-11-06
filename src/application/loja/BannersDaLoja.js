import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { AppError } from '../../domain/errors/AppError.js';
import { erroDeImagem, LIMITE_ENTRADA_BYTES, LIMITE_PIXELS, MENSAGEM_ACIMA_DO_LIMITE, umaPorVez } from '../cadastro/ImagensDaLoja.js';
import situacaoDoBannerModulo from '../../../functions/situacaoDoBanner.js';

// A situacao do banner (No app, Agendado, Pausado, Encerrado) mora em functions/situacaoDoBanner.js,
// num arquivo puro que os dois lados importam: este servico e o gatilho e a rotina das functions.
const { camposDaAcao, situacaoDoBanner } = situacaoDoBannerModulo;

// Banner com inicio no futuro: fora do app ate a data (o app do cliente nao olha startAt).
const AGUARDANDO_INICIO = Object.freeze({ status: false, started: false, aguardandoInicio: true });
const LIGADO = Object.freeze({ status: true, started: true, aguardandoInicio: false });

// Banners da loja gravados como o app Móbile Gerenciador grava (rodada de 13/10/2026). O app do cliente
// le image.size.width e height como decimal (mobile_core banner_image_adapter.dart:16): numero
// inteiro derruba a lista de banners da loja. O Admin SDK grava 1080 como inteiro, entao o documento
// vai pela API REST do Firestore com doubleValue explicito, e e lido de volta para conferir.
//
// Tamanho exigido pelo app gerenciador (banner_create_controller.dart:183-204): principal e
// posVertical 1080x500; o painel recorta nesse tamanho antes de enviar.
export const TAMANHO_DO_BANNER = Object.freeze({ largura: 1080, altura: 500 });

function valorFirestore(valor) {
  if (valor === null || valor === undefined) return { nullValue: null };
  if (valor instanceof Date) return { timestampValue: valor.toISOString() };
  if (typeof valor === 'boolean') return { booleanValue: valor };
  if (typeof valor === 'string') return { stringValue: valor };
  if (Array.isArray(valor)) return { arrayValue: valor.length ? { values: valor.map(valorFirestore) } : {} };
  if (typeof valor === 'object' && valor.__double !== undefined) return { doubleValue: Number(valor.__double) };
  if (typeof valor === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(valor).map(([chave, item]) => [chave, valorFirestore(item)])) } };
  throw new Error(`tipo sem conversao: ${typeof valor}`);
}

export const decimal = (numero) => ({ __double: numero });

// status e started so na criacao (novo: true); a edicao deixa os dois como estao. `ligacao` (status,
// started e aguardandoInicio) troca os dois quando o agendamento pede (7.1 e 7.2).
export function camposDoBanner({ id, path, storageRef, largura, altura, inicio, fim, tipo, products, novo = false, ligacao = null }) {
  return {
    id,
    image: { path, storageRef, size: { width: decimal(largura), height: decimal(altura) } },
    ...(products !== undefined ? { products } : {}),
    startAt: inicio,
    endAt: fim,
    ...(novo ? { started: true, status: true } : {}),
    ...(ligacao || {}),
    type: tipo,
  };
}

export function documentoRest(campos) {
  return { fields: Object.fromEntries(Object.entries(campos).map(([chave, valor]) => [chave, valorFirestore(valor)])) };
}

// Le a largura e a altura reais da foto (ja recortada pelo painel). Sem tamanho, recusa: nunca {0,0}.
export function medirImagem(conteudo) {
  return umaPorVez(async () => {
    try {
      const { width, height } = await sharp(conteudo, { failOn: 'none', limitInputPixels: LIMITE_PIXELS }).metadata();
      if (!(width > 0) || !(height > 0)) throw new Error('sem tamanho');
      return { largura: width, altura: height };
    } catch (error) {
      if (/pixel limit/i.test(String(error?.message))) throw erroDeImagem(error);
      throw new AppError('Não deu para ler o tamanho da imagem. Envie a foto em JPG, PNG ou WEBP.', {
        statusCode: 400,
        code: 'banner_sem_tamanho',
      });
    }
  });
}

export class BannersDaLoja {
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

  periodo({ inicio, fim }) {
    const comeco = new Date(inicio);
    const termino = new Date(fim);
    if (Number.isNaN(comeco.getTime()) || Number.isNaN(termino.getTime())) {
      throw new AppError('Informe o início e o fim do banner.', { statusCode: 400, code: 'banner_sem_periodo' });
    }
    if (termino <= comeco) {
      throw new AppError('O fim do banner precisa ser depois do início.', { statusCode: 400, code: 'banner_periodo_invalido' });
    }
    return { inicio: comeco, fim: termino };
  }

  async enviarImagem(lojaId, conteudo) {
    if (!conteudo?.length) throw new AppError('Envie a imagem do banner.', { statusCode: 400, code: 'imagem_vazia' });
    if (conteudo.length > LIMITE_ENTRADA_BYTES) throw new AppError(MENSAGEM_ACIMA_DO_LIMITE, { statusCode: 413, code: 'imagem_acima_do_limite' });
    const { largura, altura } = await this.medir(conteudo);
    if (largura !== TAMANHO_DO_BANNER.largura || altura !== TAMANHO_DO_BANNER.altura) {
      throw new AppError(`O banner precisa ter ${TAMANHO_DO_BANNER.largura} x ${TAMANHO_DO_BANNER.altura} pixels. Recorte a imagem no painel antes de enviar.`, {
        statusCode: 400,
        code: 'banner_tamanho_errado',
        details: { largura, altura },
      });
    }
    if (!this.bucket) throw new AppError('Armazenamento de imagens não configurado.', { statusCode: 503, code: 'imagem_sem_bucket' });
    // Mesmo lugar dos banners de hoje (painel e app gerenciador).
    const storageRef = `estabelecimentos/${lojaId}/banners/${this.agora()}.jpg`;
    const token = randomUUID();
    await this.bucket.file(storageRef).save(conteudo, {
      contentType: 'image/jpeg',
      metadata: { metadata: { firebaseStorageDownloadTokens: token } },
    });
    const path = `https://firebasestorage.googleapis.com/v0/b/${this.bucket.name}/o/${encodeURIComponent(storageRef)}?alt=media&token=${token}`;
    return { path, storageRef, largura, altura };
  }

  caminho(lojaId, bannerId) {
    return `estabelecimentos/${lojaId}/Banners/${bannerId}`;
  }

  // Criar: documento novo com todos os campos do app gerenciador (BannerAdapter). Inicio no futuro grava
  // status false, started false e aguardandoInicio true; inicio ja passado grava como hoje (status e started true).
  async criar(lojaId, conteudo, { inicio, fim }) {
    const datas = this.periodo({ inicio, fim });
    const imagem = await this.enviarImagem(lojaId, conteudo);
    const id = this.novoId();
    const ligacao = datas.inicio.getTime() > this.agora() ? AGUARDANDO_INICIO : null;
    const campos = camposDoBanner({ id, ...imagem, ...datas, tipo: 'principal', products: [], novo: true, ligacao });
    await this.rest.gravar(this.caminho(lojaId, id), documentoRest(campos), { criar: true });
    return this.conferir(lojaId, id);
  }

  // Editar: troca a imagem e o periodo; produtos e tipo ficam como estao. O arquivo antigo sai. Status e
  // started ficam como estao, menos no agendamento: estava no app ou aguardando e o novo inicio ficou no
  // futuro, passa a aguardar; estava aguardando e o novo inicio ja passou, liga. Pausado continua pausado.
  async editar(lojaId, bannerId, conteudo, { inicio, fim }) {
    const atual = await this.firestore.doc(this.caminho(lojaId, bannerId)).get();
    if (!atual.exists) throw new AppError('Banner não encontrado.', { statusCode: 404, code: 'banner_nao_encontrado' });
    const datas = this.periodo({ inicio, fim });
    const imagem = await this.enviarImagem(lojaId, conteudo);
    const dados = atual.data() || {};
    const agora = this.agora();
    const antes = situacaoDoBanner(dados, agora);
    const inicioNoFuturo = datas.inicio.getTime() > agora;
    let ligacao = null;
    if (inicioNoFuturo && (antes === 'noApp' || antes === 'agendado')) ligacao = AGUARDANDO_INICIO;
    else if (!inicioNoFuturo && dados.aguardandoInicio === true) ligacao = LIGADO;
    const campos = camposDoBanner({
      id: bannerId, ...imagem, ...datas, tipo: dados.type || 'principal', products: Array.isArray(dados.products) ? undefined : [], ligacao,
    });
    await this.rest.gravar(this.caminho(lojaId, bannerId), documentoRest(campos), { mascara: Object.keys(campos) });
    const antigo = dados.image?.storageRef;
    if (antigo && antigo !== imagem.storageRef && this.bucket) {
      this.bucket.file(antigo).delete().catch(() => {});
    }
    return this.conferir(lojaId, bannerId);
  }

  // Pausar e Retomar (7.6): so status, started e aguardandoInicio, pela regra de camposDaAcao. Banner
  // encerrado nao tem Pausar nem Retomar.
  async mudarSituacao(lojaId, bannerId, acao) {
    const atual = await this.firestore.doc(this.caminho(lojaId, bannerId)).get();
    if (!atual.exists) throw new AppError('Banner não encontrado.', { statusCode: 404, code: 'banner_nao_encontrado' });
    const dados = atual.data() || {};
    const agora = this.agora();
    const campos = camposDaAcao(dados, acao, agora);
    if (!campos) {
      throw new AppError('Banner encerrado não tem Pausar nem Retomar.', { statusCode: 409, code: 'banner_encerrado' });
    }
    await this.rest.gravar(this.caminho(lojaId, bannerId), documentoRest(campos), { mascara: Object.keys(campos) });
    return { id: bannerId, situacao: situacaoDoBanner({ ...dados, ...campos }, agora) };
  }

  // Le de volta pelo REST: largura e altura precisam vir como doubleValue.
  async conferir(lojaId, bannerId) {
    const documento = await this.rest.ler(this.caminho(lojaId, bannerId));
    const tamanho = documento?.fields?.image?.mapValue?.fields?.size?.mapValue?.fields || {};
    if (tamanho.width?.doubleValue === undefined || tamanho.height?.doubleValue === undefined) {
      throw new AppError('O banner foi gravado sem o tamanho em decimal. Avise o suporte.', { statusCode: 500, code: 'banner_tamanho_nao_decimal' });
    }
    return {
      id: bannerId,
      largura: Number(tamanho.width.doubleValue),
      altura: Number(tamanho.height.doubleValue),
      tipos: { width: 'doubleValue', height: 'doubleValue' },
    };
  }
}
