const { isTestOrder, orderClientId } = require('./hourlySalesAggregation');

const CHECK_VERSION = 6;
const DEFAULT_TIMEOUT_MS = 15000;
const CLIENT_FETCH_CHUNK = 300;
const SALES_WINDOW_DAYS = Object.freeze({ vendas30: 30, vendas90: 90 });

// Mesma regua do hourlySalesAggregation: pedido que virou venda.
const CONFIRMED_ORDER_STATUSES = new Set([
  'accepted',
  'picking',
  'separatingorder',
  'waitingfordelivery',
  'waiting',
  'deliveryroute',
  'on_route',
  'completed',
  'delivered',
]);
const LISTED_PREFIXES = Object.freeze(['produtosMobile/', 'Products/']);
const SUMMARY_PAGE_SIZE = 20000;
const DEFAULT_SAMPLE_SIZE = 30;

// Documento da lista em Stats/imageFileCheck/lists -> campo de ids no resultado da passada.
const ID_LISTS = Object.freeze({
  semFoto: 'idsSemFoto',
  semTag: 'idsSemTag',
  semCategoria: 'idsSemCategoria',
  semFotoAVenda: 'idsSemFotoAVenda',
  aVenda: 'idsAVenda',
  foraDeVenda: 'idsForaDeVenda',
  semPrateleiraAVenda: 'idsSemPrateleiraAVenda',
  buscaQuebradaAVenda: 'idsBuscaQuebradaAVenda',
  bloqueadosQueVenderam90: 'idsBloqueadosQueVenderam90',
});

// O resumo, lido pela Home a cada carga, leva so numeros e metadados (alem de
// version e checkedAt). Menos de 1 KB em qualquer loja.
const SUMMARY_FIELDS = Object.freeze([
  'vendas30',
  'vendas90',
  'produtosAtivos',
  'produtosAVenda',
  'semFoto',
  'semFotoAVenda',
  'semTag',
  'semTagAVenda',
  'semCategoria',
  'semCategoriaAVenda',
  'semPrateleiraAVenda',
  'semShelvesIdsAVenda',
  'prateleiraInexistenteAVenda',
  'buscaQuebradaAVenda',
  'estoqueDosAVenda',
  'porMotivo',
  'falhasTemporarias',
  'metodo',
  'amostra',
  'divergenciasAmostra',
]);

const REASONS = Object.freeze({
  ok: 'ok',
  missingFile: 'arquivo_ausente',
  accessDenied: 'acesso_negado',
  noUrl: 'sem_url',
  invalidUrl: 'url_invalida',
});

class StorageListingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StorageListingError';
  }
}

function imageUrlOf(product = {}) {
  const image = Array.isArray(product.images) ? product.images[0] : null;
  return typeof image?.fileUrl === 'string' ? image.fileUrl.trim() : '';
}

// Campo ausente, que nao e lista, lista vazia ou so com textos vazios conta como vazio.
function hasFilledList(value) {
  return Array.isArray(value) && value.some((entry) => String(entry ?? '').trim());
}

function hasTags(product = {}) {
  return hasFilledList(product.tags);
}

function hasCategory(product = {}) {
  return hasFilledList(product.categoriesIds);
}

// Mesma regra do app do cliente (product_entity.dart: isAvailable).
function isForSale(product = {}) {
  const stock = product.quantityInStock;
  const withoutStock = stock === undefined || stock === null;
  return product.isActive === true
    && typeof product.currentPrice === 'number'
    && product.currentPrice > 0
    && (withoutStock || (typeof stock === 'number' && stock > 0));
}

// Prateleira valida: subcategoria ativa cuja categoria existe. O id em shelvesIds
// e `${categoryId}_${subcategoryId}`, comparado inteiro (categoria pode ter "_").
function validShelfKeys(categories = [], subcategories = []) {
  const categoryIds = new Set(categories.map(({ id }) => id));
  return new Set(subcategories
    .filter(({ data }) => data.isActive === true && categoryIds.has(data.categoryId))
    .map(({ id, data }) => `${data.categoryId}_${id}`));
}

// 'ok', 'semShelvesIds' (vazio ou so texto vazio) ou 'inexistente' (nenhum id
// aponta para prateleira valida).
function shelfStatusOf(product = {}, validKeys = new Set()) {
  if (!hasFilledList(product.shelvesIds)) return 'semShelvesIds';
  const ids = product.shelvesIds.map((id) => String(id ?? '').trim());
  return ids.some((id) => validKeys.has(id)) ? 'ok' : 'inexistente';
}

// A busca do app passa o termo para maiusculas e compara com arrayContainsAny
// em wordKeys e searchIndex. Se todas as chaves com letra estao em minusculas,
// o produto nunca casa. Chave sem letra (codigo de barras) nao entra na conta.
function hasBrokenSearch(product = {}) {
  const keys = [
    ...(Array.isArray(product.wordKeys) ? product.wordKeys : []),
    ...(Array.isArray(product.searchIndex) ? product.searchIndex : []),
  ].map((key) => String(key ?? ''))
    .filter((key) => /\p{L}/u.test(key));
  return keys.length > 0
    && keys.every((key) => key === key.toLowerCase() && key !== key.toUpperCase());
}

function stockBandOf(product = {}) {
  const stock = product.quantityInStock;
  if (typeof stock !== 'number') return 'semCampo';
  if (stock <= 10) return 'ate10';
  if (stock <= 20) return 'de11a20';
  return 'acima20';
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

// Primeira pasta do objeto numa URL de download do Firebase Storage
// (/v0/b/{bucket}/o/{caminho}). Serve so para o relatorio.
function storageFolderOf(url) {
  try {
    const match = new URL(url).pathname.match(/\/o\/(.+)$/);
    if (!match) return 'outro';
    return decodeURIComponent(match[1]).split('/')[0] || 'outro';
  } catch {
    return 'outro';
  }
}

function storageObjectOf(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'firebasestorage.googleapis.com') return null;
    const match = parsed.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/);
    if (!match) return null;
    return { bucket: match[1], path: decodeURIComponent(match[2]) };
  } catch {
    return null;
  }
}

// Status que nao entram aqui (429, 5xx, rede, timeout) sao falha temporaria:
// o produto fica fora da contagem nesta passada e a proxima tenta de novo.
function reasonFromStatus(status) {
  if (status === 200 || status === 206) return REASONS.ok;
  if (status === 404) return REASONS.missingFile;
  if (status === 401 || status === 403) return REASONS.accessDenied;
  return null;
}

function discardBody(response) {
  try {
    const pending = response?.body?.cancel?.();
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch {
    // corpo indisponivel ou ja consumido
  }
}

// Abre a URL gravada do mesmo jeito que o app, pedindo so o primeiro byte.
async function openImageUrl(url, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      redirect: 'follow',
      signal: controller.signal,
    });
    discardBody(response);
    return { status: response.status, reason: reasonFromStatus(response.status) };
  } catch (error) {
    return {
      status: null,
      reason: null,
      error: error?.name === 'AbortError' ? 'timeout' : 'rede',
    };
  } finally {
    clearTimeout(timer);
  }
}

// Cada URL e aberta uma vez por execucao, mesmo que varios produtos (ou lojas)
// apontem para ela, com no maximo `concurrency` requisicoes ao mesmo tempo.
function createUrlChecker({ concurrency = 25, open = openImageUrl, openOptions } = {}) {
  const results = new Map();
  const queue = [];
  let active = 0;
  let requests = 0;

  const pump = () => {
    while (active < concurrency && queue.length) {
      const { url, resolve } = queue.shift();
      active += 1;
      requests += 1;
      Promise.resolve()
        .then(() => open(url, openOptions))
        .catch(() => ({ status: null, reason: null, error: 'falha' }))
        .then(resolve)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };

  const check = (url) => {
    if (!results.has(url)) {
      results.set(url, new Promise((resolve) => {
        queue.push({ url, resolve });
        pump();
      }));
    }
    return results.get(url);
  };

  return {
    check,
    stats: () => ({ uniqueUrls: results.size, requests }),
  };
}

// So o nome dos objetos, pagina a pagina, para nao segurar os metadados na memoria.
async function listBucketNames(bucket, prefix) {
  const names = [];
  let query = { prefix, autoPaginate: false, maxResults: 1000 };
  while (query) {
    const [files, nextQuery] = await bucket.getFiles(query);
    files.forEach((file) => names.push(file.name));
    query = nextQuery || null;
  }
  return names;
}

// Cada pasta e listada uma vez por execucao e vale para todas as lojas.
// A chave de acesso da URL nao entra: as regras do bucket servem a foto sem ela.
function createStorageIndex({ listNames, prefixes = LISTED_PREFIXES }) {
  const listings = new Map();
  let listedFolders = 0;
  let listedObjects = 0;

  const namesFor = (bucket, prefix) => {
    const key = `${bucket}|${prefix}`;
    if (!listings.has(key)) {
      listings.set(key, Promise.resolve()
        .then(() => listNames(bucket, prefix))
        .then((names) => {
          listedFolders += 1;
          listedObjects += names.length;
          return new Set(names);
        })
        .catch((error) => {
          throw new StorageListingError(
            `Falha ao listar ${prefix} em ${bucket}: ${error?.message || error}`,
          );
        }));
    }
    return listings.get(key);
  };

  // true/false quando a pasta e listada; null quando a URL precisa ser aberta.
  const exists = async (url) => {
    const object = storageObjectOf(url);
    const prefix = object && prefixes.find((candidate) => object.path.startsWith(candidate));
    if (!prefix) return null;
    const names = await namesFor(object.bucket, prefix);
    return names.has(object.path);
  };

  const preload = async (bucket) => {
    await Promise.all(prefixes.map((prefix) => namesFor(bucket, prefix)));
  };

  return {
    exists,
    preload,
    stats: () => ({ listedFolders, listedObjects }),
  };
}

// Com `index`, a existencia vem da listagem; sem ele, ou fora das pastas
// listadas, a URL e aberta.
async function evaluateProduct(product, checker, { index } = {}) {
  const url = imageUrlOf(product);
  if (!url) return { url: '', reason: REASONS.noUrl, status: null, via: 'cadastro' };
  if (!isHttpUrl(url)) return { url, reason: REASONS.invalidUrl, status: null, via: 'cadastro' };
  if (index) {
    const found = await index.exists(url);
    if (found !== null) {
      return {
        url,
        reason: found ? REASONS.ok : REASONS.missingFile,
        status: null,
        via: 'listagem',
      };
    }
  }
  const result = await checker.check(url);
  return {
    url,
    reason: result.reason,
    status: result.status,
    error: result.error,
    via: 'abertura',
  };
}

function normalizeOrderStatus(value) {
  return String(value || '').replace(/^PurchaseStatus\./i, '').trim().toLowerCase();
}

function isConfirmedOrder(order = {}) {
  const status = order.currentPurchaseStatus || order.purchaseStatus || order.status;
  return CONFIRMED_ORDER_STATUSES.has(normalizeOrderStatus(status));
}

function orderMillis(order = {}) {
  const value = order.createdAt;
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (typeof value.seconds === 'number') return value.seconds * 1000;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

// Meia-noite de N dias atras, para a janela fechar em dia cheio.
function windowStart(days, now = Date.now()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - days);
  return start.getTime();
}

// Unidades e valor por produto em cada janela, a partir dos pedidos confirmados.
// O valor e quantity x product.price gravado no item, sem frete.
// Clientes dos pedidos marcados como conta de teste (Users/{id}.isTestAccount).
// Uma leitura por cliente distinto dos pedidos da janela.
async function testAccountIdsFor(firestore, orders = []) {
  const clientIds = [...new Set(orders.map((order) => orderClientId(order)).filter(Boolean))];
  const testAccountIds = new Set();
  for (let start = 0; start < clientIds.length; start += CLIENT_FETCH_CHUNK) {
    const references = clientIds
      .slice(start, start + CLIENT_FETCH_CHUNK)
      .map((clientId) => firestore.collection('Users').doc(clientId));
    const snapshots = await firestore.getAll(...references);
    snapshots.forEach((snapshot) => {
      if (snapshot.exists && snapshot.get('isTestAccount') === true) testAccountIds.add(snapshot.id);
    });
  }
  return testAccountIds;
}

function salesFromOrders(orders = [], { now = Date.now(), testAccountIds = new Set() } = {}) {
  const windows = Object.entries(SALES_WINDOW_DAYS)
    .map(([name, days]) => ({ name, start: windowStart(days, now) }));
  const byProduct = new Map();
  const confirmedOrders = Object.fromEntries(windows.map(({ name }) => [name, 0]));

  orders.forEach((order) => {
    if (isTestOrder(order, { testAccount: testAccountIds.has(orderClientId(order)) })) return;
    if (!isConfirmedOrder(order)) return;
    const millis = orderMillis(order);
    if (millis === null) return;
    const inWindows = windows.filter(({ start }) => millis >= start).map(({ name }) => name);
    if (!inWindows.length) return;
    inWindows.forEach((name) => { confirmedOrders[name] += 1; });

    const items = Array.isArray(order.productsCart)
      ? order.productsCart
      : (Array.isArray(order.items) ? order.items : []);
    items.forEach((item) => {
      const productId = item?.productRef?.id || item?.product?.id || item?.productId;
      if (!productId) return;
      const quantity = toNumber(item.quantity) || 1;
      const price = toNumber(item.product?.currentPrice ?? item.product?.price);
      const entry = byProduct.get(productId)
        || Object.fromEntries(windows.map(({ name }) => [name, { unidades: 0, valor: 0 }]));
      inWindows.forEach((name) => {
        entry[name].unidades += quantity;
        entry[name].valor += quantity * price;
      });
      byProduct.set(productId, entry);
    });
  });

  return { byProduct, confirmedOrders };
}

// Cruza as vendas com o catalogo lido na mesma passada. "Bloqueado" e o que o
// cliente nao consegue comprar hoje: a negacao de isForSale.
function summarizeSales(sales, products) {
  const blocked = new Set(products
    .filter(({ product }) => !isForSale(product))
    .map(({ id }) => id));

  return Object.fromEntries(Object.keys(SALES_WINDOW_DAYS).map((name) => {
    let produtosVendidos = 0;
    let bloqueadosQueVenderam = 0;
    let faturamentoDosBloqueados = 0;
    sales.byProduct.forEach((entry, productId) => {
      if (entry[name].unidades <= 0) return;
      produtosVendidos += 1;
      if (!blocked.has(productId)) return;
      bloqueadosQueVenderam += 1;
      faturamentoDosBloqueados += entry[name].valor;
    });
    return [name, {
      pedidosConfirmados: sales.confirmedOrders[name],
      produtosVendidos,
      bloqueadosQueVenderam,
      faturamentoDosBloqueados: Math.round(faturamentoDosBloqueados * 100) / 100,
    }];
  }));
}

function sampleOf(items, size, random = Math.random) {
  const pool = items.slice();
  const picked = [];
  while (picked.length < size && pool.length) {
    picked.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
  }
  return picked;
}

function summarizePass(results, { method, sampleSize, divergences }) {
  const byReason = Object.fromEntries(Object.values(REASONS).map((reason) => [reason, 0]));
  const missingByFolder = {};
  const ids = [];
  let transient = 0;

  results.forEach((result) => {
    if (!result.reason) {
      transient += 1;
      return;
    }
    byReason[result.reason] += 1;
    if (result.reason === REASONS.ok) return;
    ids.push(result.id);
    const folder = result.url ? storageFolderOf(result.url) : '(sem url)';
    missingByFolder[folder] = (missingByFolder[folder] || 0) + 1;
  });
  ids.sort();

  return {
    produtosAtivos: results.length,
    semFoto: ids.length,
    idsSemFoto: ids,
    porMotivo: byReason,
    semFotoPorPasta: missingByFolder,
    falhasTemporarias: transient,
    metodo: method,
    amostra: sampleSize,
    divergenciasAmostra: divergences,
  };
}

// Uma loja: le os produtos ativos, classifica a foto pela listagem, confere uma
// amostra abrindo as URLs e, se a amostra discordar, abre todas. Tag e
// categoria saem da mesma leitura, sem consulta a mais.
async function runEstablishmentPass({
  storeRef,
  documentIdPath,
  index,
  checker,
  sampleSize = DEFAULT_SAMPLE_SIZE,
  queryPageSize = 500,
  random,
  onPage,
  loadOrders,
  loadTestAccountIds,
  now,
}) {
  const products = [];
  let lastDocument = null;
  while (true) {
    let productsQuery = storeRef
      .collection('Products')
      .where('isTrashed', '==', false)
      .orderBy(documentIdPath)
      .select(
        'images',
        'tags',
        'categoriesIds',
        'isActive',
        'currentPrice',
        'quantityInStock',
        'shelvesIds',
        'wordKeys',
        'searchIndex',
      )
      .limit(queryPageSize);
    if (lastDocument) productsQuery = productsQuery.startAfter(lastDocument);

    const snapshot = await productsQuery.get();
    if (snapshot.empty) break;
    snapshot.docs.forEach((productDocument) => {
      // wordKeys e searchIndex sao os campos mais pesados: viram um booleano aqui
      // e nao ficam na memoria durante o resto da passada.
      const { wordKeys, searchIndex, ...product } = productDocument.data();
      products.push({
        id: productDocument.id,
        product,
        searchBroken: hasBrokenSearch({ wordKeys, searchIndex }),
      });
    });
    onPage?.(products.length);
    lastDocument = snapshot.docs.at(-1);
    if (snapshot.size < queryPageSize) break;
  }

  const classifyAll = (options) => Promise.all(products.map(async ({ id, product }) => ({
    id,
    ...(await evaluateProduct(product, checker, options)),
  })));

  let results = await classifyAll({ index });
  const sample = sampleOf(results.filter((result) => result.via === 'listagem'), sampleSize, random);
  const opened = await Promise.all(sample.map(async (result) => ({
    listed: result.reason,
    opened: (await checker.check(result.url)).reason,
  })));
  const divergences = opened.filter(({ listed, opened: reason }) => reason && reason !== listed).length;

  let method = 'listagem';
  if (divergences > 0) {
    results = await classifyAll({});
    method = 'abertura';
  }

  const idsWithout = (hasValue) => products
    .filter(({ product }) => !hasValue(product))
    .map(({ id }) => id)
    .sort();
  const idsSemTag = idsWithout(hasTags);
  const idsSemCategoria = idsWithout(hasCategory);

  // "A venda" e o recorte do que o cliente ve no app. semFoto, semTag e
  // semCategoria continuam com o conjunto inteiro; semFotoAVenda, aVenda e
  // foraDeVenda saem desta mesma classificacao.
  const forSale = new Map(products.map(({ id, product }) => [id, isForSale(product)]));
  const forSaleAmong = (ids) => ids.filter((id) => forSale.get(id)).length;
  const idsAVenda = products.filter(({ id }) => forSale.get(id)).map(({ id }) => id).sort();
  const idsForaDeVenda = products.filter(({ id }) => !forSale.get(id)).map(({ id }) => id).sort();

  const [categoriesSnapshot, subcategoriesSnapshot] = await Promise.all([
    storeRef.collection('ProductCategories').get(),
    storeRef.collection('ProductSubcategories').get(),
  ]);
  const toEntries = (snapshot) => snapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
  const validKeys = validShelfKeys(toEntries(categoriesSnapshot), toEntries(subcategoriesSnapshot));
  const shelfCauses = { semShelvesIds: 0, inexistente: 0 };
  const idsSemPrateleiraAVenda = [];
  const idsBuscaQuebradaAVenda = [];
  products.forEach(({ id, product, searchBroken }) => {
    if (!forSale.get(id)) return;
    const shelfStatus = shelfStatusOf(product, validKeys);
    if (shelfStatus !== 'ok') {
      shelfCauses[shelfStatus] += 1;
      idsSemPrateleiraAVenda.push(id);
    }
    if (searchBroken) idsBuscaQuebradaAVenda.push(id);
  });
  idsSemPrateleiraAVenda.sort();
  idsBuscaQuebradaAVenda.sort();
  const estoqueDosAVenda = { ate10: 0, de11a20: 0, acima20: 0, semCampo: 0 };
  products.forEach(({ id, product }) => {
    if (forSale.get(id)) estoqueDosAVenda[stockBandOf(product)] += 1;
  });

  const orders = loadOrders ? await loadOrders() : [];
  const testAccountIds = loadTestAccountIds ? await loadTestAccountIds(orders) : new Set();
  const sales = salesFromOrders(orders, { now, testAccountIds });
  // Mesmo criterio de vendas90.bloqueadosQueVenderam, com os ids para a tela abrir.
  const idsBloqueadosQueVenderam90 = products
    .filter(({ id }) => !forSale.get(id) && sales.byProduct.get(id)?.vendas90.unidades > 0)
    .map(({ id }) => id)
    .sort();

  const photos = summarizePass(results, { method, sampleSize: opened.length, divergences });
  const idsSemFotoAVenda = photos.idsSemFoto.filter((id) => forSale.get(id));
  return {
    ...photos,
    ...summarizeSales(sales, products),
    produtosAVenda: idsAVenda.length,
    idsAVenda,
    idsForaDeVenda,
    semFotoAVenda: idsSemFotoAVenda.length,
    idsSemFotoAVenda,
    semTag: idsSemTag.length,
    semTagAVenda: forSaleAmong(idsSemTag),
    idsSemTag,
    semCategoria: idsSemCategoria.length,
    semCategoriaAVenda: forSaleAmong(idsSemCategoria),
    idsSemCategoria,
    semPrateleiraAVenda: idsSemPrateleiraAVenda.length,
    semShelvesIdsAVenda: shelfCauses.semShelvesIds,
    prateleiraInexistenteAVenda: shelfCauses.inexistente,
    idsSemPrateleiraAVenda,
    buscaQuebradaAVenda: idsBuscaQuebradaAVenda.length,
    idsBuscaQuebradaAVenda,
    idsBloqueadosQueVenderam90,
    estoqueDosAVenda,
  };
}

function splitIds(ids, pageSize = SUMMARY_PAGE_SIZE) {
  const pages = [];
  for (let start = 0; start < ids.length; start += pageSize) {
    pages.push(ids.slice(start, start + pageSize));
  }
  return pages.length ? pages : [[]];
}

// Os ids ficam em Stats/imageFileCheck/lists/{lista} (e {lista}-2, -3... acima de
// 20.000); o resumo guarda so os numeros. Listas primeiro, resumo por ultimo e
// paginas que sobraram apagadas depois: o resumo nunca aponta para lista que nao existe.
async function writeSummary({ storeRef, summary, checkedAt }) {
  const summaryRef = storeRef.collection('Stats').doc('imageFileCheck');
  const listsRef = summaryRef.collection('lists');
  const pageCounts = {};
  const stalePages = [];

  for (const [list, field] of Object.entries(ID_LISTS)) {
    const ids = summary[field] || [];
    const [firstPage, ...otherPages] = splitIds(ids);
    const pageCount = otherPages.length + 1;
    const previous = await listsRef.doc(list).get();
    const previousPageCount = Number(previous.get('pageCount')) || 1;

    for (const [index, pageIds] of otherPages.entries()) {
      await listsRef.doc(`${list}-${index + 2}`).set({ ids: pageIds });
    }
    await listsRef.doc(list).set({ ids: firstPage, total: ids.length, pageCount });

    pageCounts[list] = pageCount;
    for (let page = pageCount + 1; page <= previousPageCount; page += 1) {
      stalePages.push(`${list}-${page}`);
    }
  }

  const fields = Object.fromEntries(SUMMARY_FIELDS.map((field) => [field, summary[field]]));
  await summaryRef.set({ version: CHECK_VERSION, ...fields, checkedAt });

  for (const page of stalePages) {
    await listsRef.doc(page).delete();
  }
  return { pageCounts };
}

function configuredEstablishmentIds(config) {
  if (!config || config.enabled !== true || !Array.isArray(config.establishmentIds)) return [];
  const ids = config.establishmentIds
    .map((id) => String(id || '').trim())
    .filter((id) => id && !id.includes('/'));
  return [...new Set(ids)];
}

module.exports = {
  CHECK_VERSION,
  DEFAULT_SAMPLE_SIZE,
  ID_LISTS,
  LISTED_PREFIXES,
  REASONS,
  SALES_WINDOW_DAYS,
  SUMMARY_FIELDS,
  SUMMARY_PAGE_SIZE,
  StorageListingError,
  configuredEstablishmentIds,
  createStorageIndex,
  createUrlChecker,
  evaluateProduct,
  hasBrokenSearch,
  hasCategory,
  hasTags,
  imageUrlOf,
  isConfirmedOrder,
  isForSale,
  isHttpUrl,
  listBucketNames,
  openImageUrl,
  reasonFromStatus,
  runEstablishmentPass,
  salesFromOrders,
  sampleOf,
  shelfStatusOf,
  splitIds,
  stockBandOf,
  storageFolderOf,
  storageObjectOf,
  summarizePass,
  summarizeSales,
  testAccountIdsFor,
  validShelfKeys,
  windowStart,
  writeSummary,
};
