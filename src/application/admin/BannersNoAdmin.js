import { randomUUID } from 'node:crypto';
import { AppError } from '../../domain/errors/AppError.js';
import { camposDoBanner, decimal, documentoRest, inteiro, medirImagem, referencia } from '../loja/BannersDaLoja.js';
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

// "Leva para" (cola B57-07, item 6): nada, os produtos (products) ou a categoria (category) do banner,
// como o app gerenciador grava (BannerProductAdapter e BannerCategoryAdapter do mobile_core) e o app do
// cliente le (main_variant_1_page.dart:229-236).
// Cola B57-10, item B2: "Ofertas" grava destino: 'ofertas' (com products vazio e category nula); os
// outros destinos apagam o campo destino. O app do cliente le esse campo, com esse nome.
export const MAXIMO_DE_PRODUTOS_DO_BANNER = 100;
export const DESTINO_OFERTAS = 'ofertas';
export function destinoDoBanner(banner) {
  if (banner.destino === DESTINO_OFERTAS) return { tipo: 'ofertas' };
  const produtos = Array.isArray(banner.products) ? banner.products : [];
  if (produtos.length) return { tipo: 'produtos', quantos: produtos.length, ids: produtos.map((produto) => String(produto?.id || '')).filter(Boolean) };
  if (banner.category && typeof banner.category === 'object') {
    return { tipo: 'categoria', id: String(banner.category.id || ''), nome: String(banner.category.name || '') };
  }
  return { tipo: 'nada' };
}

// O produto como o app le (BannerProductAdapter.fromMap): name e barCode textos, itemPrice e
// previewPrice decimais, images com fileName texto e itsFromPlatform booleano. Campo faltando vira o
// vazio do tipo: um campo nulo onde o app espera texto derruba a lista de banners da loja.
const texto = (valor) => (typeof valor === 'string' ? valor : (valor === null || valor === undefined ? '' : String(valor)));
const numero = (valor) => (Number.isFinite(Number(valor)) ? Number(valor) : 0);
// Como o app gerenciador (BannerProductAdapter.fromCompanyProduct, mobile_core, e PromotionValidityMixin):
// itemPrice e o preco efetivo (o promocional, se a promocao vale agora; senao o atual) e previewPrice e o
// riscado (o atual, durante a promocao), senao o previewPrice do produto, senao o efetivo. As fotos como
// ProductImageAdapter.fromMapItems: endereco solto vira foto de "produtosMobile"; foto sem fileName fica
// de fora (o app pula).
const dataDe = (valor) => (typeof valor?.toDate === "function" ? valor.toDate() : (valor ? new Date(valor) : null));
export function precosDoProduto(produto, agora = Date.now()) {
  const atual = numero(produto.currentPrice ?? produto.price);
  const promocional = Number(produto.promotionalPrice);
  const inicio = dataDe(produto.promotionStartAt);
  const fim = dataDe(produto.promotionEndAt);
  const promocao = Number.isFinite(promocional) && promocional > 0 && promocional < atual
    && !(inicio && inicio.getTime() > agora) && !(fim && fim.getTime() < agora);
  const efetivo = promocao ? promocional : atual;
  const riscado = promocao ? atual : null;
  const deAntes = Number.isFinite(Number(produto.previewPrice)) && produto.previewPrice !== null ? Number(produto.previewPrice) : null;
  return { itemPrice: efetivo, previewPrice: riscado ?? deAntes ?? efetivo };
}
function fotosDoProduto(imagens) {
  return (Array.isArray(imagens) ? imagens : []).flatMap((imagem) => {
    if (typeof imagem === "string") {
      const url = imagem.trim();
      return url ? [{ fileName: url.split("/").pop(), fileUrl: url, folderPath: "produtosMobile", quality: null, itsFromPlatform: false, reference: null }] : [];
    }
    if (!imagem || typeof imagem !== "object" || typeof imagem.fileName !== "string") return [];
    return [{
      fileName: imagem.fileName,
      fileUrl: typeof imagem.fileUrl === "string" ? imagem.fileUrl : null,
      folderPath: typeof imagem.folderPath === "string" ? imagem.folderPath : "produtosMobile",
      quality: Number.isFinite(Number(imagem.quality)) && imagem.quality !== null ? inteiro(imagem.quality) : null,
      itsFromPlatform: imagem.itsFromPlatform === true,
      reference: typeof imagem.reference === "string" ? imagem.reference : null,
    }];
  });
}
export function produtoDoBanner(lojaId, id, produto, agora = Date.now()) {
  const { itemPrice, previewPrice } = precosDoProduto(produto, agora);
  return {
    id,
    name: texto(produto.name),
    barCode: texto(produto.barCode),
    reference: referencia(`estabelecimentos/${lojaId}/Products/${id}`),
    companyRef: referencia(`estabelecimentos/${lojaId}`),
    images: fotosDoProduto(produto.images),
    externalId: typeof produto.externalId === "string" ? produto.externalId : null,
    itemPrice: decimal(itemPrice),
    previewPrice: decimal(previewPrice),
  };
}

export function categoriaDoBanner(lojaId, id, categoria) {
  return {
    id,
    name: texto(categoria.name),
    reference: referencia(`estabelecimentos/${lojaId}/ProductCategories/${id}`),
    icon: texto(categoria.icon),
  };
}

// Cola B57-10, item B1: o "Leva para" so oferece destino com conteudo. Produto a venda como o app do
// cliente mostra (e como isForSale de functions/productImageFileCheck.js): ativo, fora da lixeira, preco
// maior que zero e estoque sem campo ou maior que zero.
export function produtoAVenda(produto = {}) {
  const estoque = produto.quantityInStock;
  return produto.isActive === true && produto.isTrashed !== true
    && typeof produto.currentPrice === 'number' && produto.currentPrice > 0
    && (estoque === null || estoque === undefined || (typeof estoque === 'number' && estoque > 0));
}
// array-contains-any aceita ate 30 valores por consulta.
export const PRATELEIRAS_POR_CONSULTA = 30;

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
      levaPara: destinoDoBanner(banner),
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

  // B5.a e B5.b: banner novo de um tipo, dentro do limite do tipo. Cola B57-07 (tela Loja): com
  // `noLimite: 'desligar'`, o tipo no limite nao recusa; o banner nasce desligado ("Criar novo" fica
  // sempre a vista e o limite so bloqueia o "Ligado").
  // Cola B57-10, item B3: com `exigirDestino` (so a tela Loja), o banner sem "Leva para" nasce desligado.
  async criar(lojaId, tipo, conteudo, tipoArquivo, { inicio, fim }, { noLimite = 'recusar', exigirDestino = false } = {}) {
    const loja = await this.loja(lojaId);
    const regra = this.tipoValido(tipo);
    const datas = this.periodo({ inicio, fim });
    const agora = this.agora();
    const existentes = (await loja.ref.collection('Banners').get()).docs.map((documento) => documento.data() || {});
    const ocupados = existentes.filter((banner) => (banner.type || 'principal') === tipo && ocupaVaga(banner, agora)).length;
    const noLimiteDoTipo = ocupados >= regra.limite;
    if (noLimiteDoTipo && noLimite !== 'desligar') {
      throw recusa(`Este tipo já tem ${ocupados} de ${regra.limite} banners. Apague ou desligue um antes de enviar outro.`, 'banner_limite', 409, { ocupados, limite: regra.limite });
    }
    const imagem = await this.conferirImagem(tipo, conteudo, tipoArquivo);
    const gravado = await this.gravarImagem(loja.id, conteudo, imagem);
    const id = this.novoId();
    let ligacao = datas.inicio.getTime() > agora ? AGUARDANDO : null;
    if (noLimiteDoTipo) ligacao = DESLIGADO;
    if (exigirDestino) ligacao = DESLIGADO; // o banner novo nasce sem destino (products vazio, category nula)
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
  // Cola B57-10, item B3: com `exigirDestino` (so a tela Loja), o banner sem "Leva para" nao liga.
  async alterar(lojaId, bannerId, { inicio, fim, ligado, contador } = {}, { exigirDestino = false } = {}) {
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
        if (!estavaLigado && exigirDestino && destinoDoBanner(dados).tipo === 'nada') throw recusa('Escolha para onde o banner leva.', 'banner_sem_destino', 409);
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

  // Cola B57-07, item 6: "Leva para". `levaPara`: { tipo: 'nada' }, { tipo: 'produtos', ids } (so
  // produtos desta loja, lidos do banco) ou { tipo: 'categoria', id } (categoria desta loja). Grava
  // products e category juntos: um apaga o outro, como no app gerenciador.
  // Cola B57-11, item A6: com `exigirDestino` (so a tela Loja), tirar o destino ({ tipo: 'nada' }) e
  // recusado como o ligar sem destino (409, banner_sem_destino), e o produto que nao esta a venda
  // (produtoAVenda) e recusado com a recusa de produto nao encontrado.
  async mudarDestino(lojaId, bannerId, levaPara = {}, { exigirDestino = false } = {}) {
    const atual = await this.banner(lojaId, bannerId);
    const dados = atual.data() || {};
    if (exigirDestino && levaPara.tipo === 'nada') throw recusa('Escolha para onde o banner leva.', 'banner_sem_destino', 409);
    const loja = this.firestore.collection('estabelecimentos').doc(lojaId);
    let products = [];
    let category = null;
    if (levaPara.tipo === 'produtos') {
      const ids = [...new Set((levaPara.ids || []).map(String).filter((id) => /^[^/]{1,120}$/.test(id)))];
      // Cola B57-11c, item 6: pela tela Loja, a lista vazia descarta os gravados quando nenhum deles
      // esta a venda (conferido aqui, no banco). Com algum a venda, continua recusada.
      if (!ids.length && !(exigirDestino && await this.soTemForaDeVenda(loja, dados))) {
        throw recusa('Escolha pelo menos um produto.', 'banner_sem_produtos');
      }
      if (ids.length > MAXIMO_DE_PRODUTOS_DO_BANNER) throw recusa(`Escolha até ${MAXIMO_DE_PRODUTOS_DO_BANNER} produtos.`, 'banner_produtos_demais');
      const lidos = await Promise.all(ids.map((id) => loja.collection('Products').doc(id).get()));
      const faltando = lidos.filter((produto) => !produto.exists || (exigirDestino && !produtoAVenda(produto.data() || {}))).map((produto) => produto.id);
      if (faltando.length) throw recusa('Produto não encontrado nesta loja.', 'banner_produto_nao_encontrado', 404, { ids: faltando });
      products = lidos.map((produto) => produtoDoBanner(lojaId, produto.id, produto.data() || {}, this.agora()));
    } else if (levaPara.tipo === 'categoria') {
      const id = String(levaPara.id || '');
      if (!/^[^/]{1,120}$/.test(id)) throw recusa('Categoria não encontrada nesta loja.', 'banner_categoria_nao_encontrada', 404);
      const lida = await loja.collection('ProductCategories').doc(id).get();
      if (!lida.exists) throw recusa('Categoria não encontrada nesta loja.', 'banner_categoria_nao_encontrada', 404);
      // Cola B57-10, item B1: categoria que o app nao mostra, ou sem produto a venda, nao vira destino.
      if (!(await this.categoriasComConteudo(lojaId, { soEstas: [lida.id] })).includes(lida.id)) {
        throw recusa('Categoria não encontrada nesta loja.', 'banner_categoria_nao_encontrada', 404);
      }
      category = categoriaDoBanner(lojaId, lida.id, lida.data() || {});
    } else if (levaPara.tipo !== 'nada' && levaPara.tipo !== 'ofertas') {
      throw recusa('Escolha para onde o banner leva.', 'banner_destino_invalido');
    }
    // Cola B57-10, item B2: destino na mascara sempre; so "Ofertas" manda o campo, e nos outros ele sai
    // do documento (campo na mascara e fora do corpo e apagado pela API REST do Firestore).
    const campos = levaPara.tipo === 'ofertas' ? { products, category, destino: DESTINO_OFERTAS } : { products, category };
    await this.rest.gravar(this.caminho(lojaId, bannerId), documentoRest(campos, this.rest.projectId), { mascara: ['products', 'category', 'destino'] });
    return { banner: await this.ler(lojaId, bannerId), antes: { levaPara: destinoDoBanner(dados) } };
  }

  // Cola B57-11c, item 6: o banner tem produtos gravados e nenhum esta a venda (produtoAVenda; o que
  // nao existe mais tambem nao esta). Produto gravado sem id nao da para conferir: nao descarta.
  async soTemForaDeVenda(loja, dados) {
    const destino = destinoDoBanner(dados);
    if (destino.tipo !== 'produtos' || destino.ids.length !== destino.quantos) return false;
    if (!destino.ids.every((id) => /^[^/]{1,120}$/.test(id))) return false;
    const lidos = await Promise.all(destino.ids.map((id) => loja.collection('Products').doc(id).get()));
    return lidos.every((produto) => !produto.exists || !produtoAVenda(produto.data() || {}));
  }

  // Cola B57-10, item B1: as categorias que o app do cliente mostra (getProductCategories do
  // mobile_firebase_api: categoria ativa com produto ativo, fora da lixeira, numa prateleira
  // `${categoria}_${subcategoria}` de subcategoria ativa dela) e com pelo menos um produto a venda,
  // para a categoria tambem abrir com produto. A consulta dos produtos e a do indice de Products
  // (shelvesIds CONTAINS, isActive, isTrashed), de 30 em 30 prateleiras, so com os campos da conta;
  // a categoria ja achada sai das proximas consultas. `soEstas`: so essas categorias.
  async categoriasComConteudo(lojaId, { soEstas = null } = {}) {
    const loja = this.firestore.collection('estabelecimentos').doc(String(lojaId || ''));
    const [categorias, subcategorias] = await Promise.all([
      loja.collection('ProductCategories').where('isActive', '==', true).get(),
      loja.collection('ProductSubcategories').where('isActive', '==', true).get(),
    ]);
    const ativas = new Set(categorias.docs.map((documento) => documento.id).filter((id) => !soEstas || soEstas.includes(id)));
    const categoriaDaPrateleira = new Map();
    subcategorias.docs.forEach((documento) => {
      const categoria = String(documento.data()?.categoryId || '');
      if (ativas.has(categoria)) categoriaDaPrateleira.set(`${categoria}_${documento.id}`, categoria);
    });
    const comConteudo = new Set();
    let pendentes = [...categoriaDaPrateleira.keys()];
    while (pendentes.length) {
      const lote = pendentes.slice(0, PRATELEIRAS_POR_CONSULTA);
      const produtos = await loja.collection('Products')
        .where('shelvesIds', 'array-contains-any', lote)
        .where('isActive', '==', true)
        .where('isTrashed', '==', false)
        .select('isActive', 'isTrashed', 'currentPrice', 'quantityInStock', 'shelvesIds')
        .get();
      produtos.docs.forEach((documento) => {
        const produto = documento.data() || {};
        if (!produtoAVenda(produto)) return;
        (Array.isArray(produto.shelvesIds) ? produto.shelvesIds : []).forEach((prateleira) => {
          const categoria = categoriaDaPrateleira.get(String(prateleira ?? ''));
          if (categoria) comConteudo.add(categoria);
        });
      });
      pendentes = pendentes.slice(PRATELEIRAS_POR_CONSULTA).filter((prateleira) => !comConteudo.has(categoriaDaPrateleira.get(prateleira)));
    }
    return [...comConteudo].sort();
  }

  // Cola B57-07b, item 13 (parte C): os encerrados da loja, do que terminou por ultimo para o mais antigo.
  async encerrados(lojaId) {
    const loja = await this.loja(lojaId);
    const agora = this.agora();
    const snapshot = await loja.ref.collection('Banners').get();
    return snapshot.docs
      .map((documento) => this.paraATela(documento.id, documento.data() || {}, agora))
      .filter((banner) => banner.situacao === 'encerrado')
      .sort((a, b) => String(b.fim).localeCompare(String(a.fim)));
  }

  // "Usar de novo": o encerrado volta para o tipo dele, desligado, com o periodo de um banner novo (de
  // agora ate o fim do dia de Brasilia daqui a 30 dias, como o "Criar novo"); a tela abre a faixa de
  // edicao para o lojista acertar o "Quando" e ligar. Desligado nao ocupa vaga, entao nao passa do limite.
  async usarDeNovo(lojaId, bannerId) {
    const atual = await this.banner(lojaId, bannerId);
    const dados = atual.data() || {};
    const agora = this.agora();
    if (situacaoDoBanner(dados, agora) !== 'encerrado') throw recusa('Este banner não está encerrado.', 'banner_nao_encerrado', 409);
    const daqui30 = new Date(agora + 30 * 86400000 - 3 * 3600000);
    const fim = new Date(Date.UTC(daqui30.getUTCFullYear(), daqui30.getUTCMonth(), daqui30.getUTCDate(), 23, 59, 59) + 3 * 3600000);
    const campos = { startAt: new Date(agora), endAt: fim, ...DESLIGADO };
    await this.rest.gravar(this.caminho(lojaId, bannerId), documentoRest(campos), { mascara: Object.keys(campos) });
    return { banner: await this.ler(lojaId, bannerId), antes: { inicio: data(dados.startAt)?.toISOString() || null, fim: data(dados.endAt)?.toISOString() || null } };
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
