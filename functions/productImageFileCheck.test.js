const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REASONS,
  StorageListingError,
  configuredEstablishmentIds,
  createStorageIndex,
  createUrlChecker,
  evaluateProduct,
  hasBrokenSearch,
  hasCategory,
  hasTags,
  imageUrlOf,
  isForSale,
  listBucketNames,
  openImageUrl,
  reasonFromStatus,
  runEstablishmentPass,
  salesFromOrders,
  shelfStatusOf,
  splitIds,
  stockBandOf,
  summarizeSales,
  validShelfKeys,
  storageFolderOf,
  storageObjectOf,
  writeSummary,
} = require('./productImageFileCheck');

const STORAGE_URL = 'https://firebasestorage.googleapis.com/v0/b/bucket/o/produtosMobile%2F789.webp?alt=media&token=t';

function storageUrl(path, token = 't') {
  return `https://firebasestorage.googleapis.com/v0/b/bucket/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}

function listingOf(namesByPrefix) {
  return async (bucket, prefix) => namesByPrefix[prefix] || [];
}

// Sem a chave: produto completo e a venda. Com a chave valendo undefined: campo ausente.
// categories e subcategories: [{ id, ...campos }] das colecoes de prateleira.
function fakeStoreRef(products, { categories = [], subcategories = [] } = {}) {
  const defaults = [['tags', ['tag']], ['categoriesIds', ['cat']], ['isActive', true], ['currentPrice', 10]];
  const docs = products
    .map((product) => {
      const data = { images: product.url === undefined ? [] : [{ fileUrl: product.url }] };
      for (const [field, filled] of [...defaults, ['quantityInStock', undefined]]) {
        if (!(field in product)) {
          if (filled !== undefined) data[field] = filled;
        } else if (product[field] !== undefined) {
          data[field] = product[field];
        }
      }
      for (const [field, value] of Object.entries(product)) {
        if (field !== 'id' && field !== 'url' && !(field in data) && value !== undefined) data[field] = value;
      }
      return { id: product.id, data: () => data };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const build = (state) => ({
    where: () => build(state),
    orderBy: () => build(state),
    select: () => build(state),
    limit: (size) => build({ ...state, size }),
    startAfter: (doc) => build({ ...state, after: doc.id }),
    get: async () => {
      const from = state.after ? docs.findIndex((doc) => doc.id === state.after) + 1 : 0;
      const page = docs.slice(from, from + state.size);
      return { empty: page.length === 0, size: page.length, docs: page };
    },
  });
  const staticCollection = (entries) => ({
    get: async () => ({ docs: entries.map(({ id, ...data }) => ({ id, data: () => data })) }),
  });
  return {
    collection: (name) => {
      if (name === 'ProductCategories') return staticCollection(categories);
      if (name === 'ProductSubcategories') return staticCollection(subcategories);
      return build({ size: Infinity });
    },
  };
}

// previousPageCounts: pageCount ja gravado em cada lista, por nome da lista.
function fakeSummaryStore(previousPageCounts = {}) {
  const operations = [];
  const listsRef = {
    doc: (id) => ({
      get: async () => ({ get: (field) => (field === 'pageCount' ? previousPageCounts[id] : undefined) }),
      set: async (data) => { operations.push(['set', `lists/${id}`, data]); },
      delete: async () => { operations.push(['delete', `lists/${id}`]); },
    }),
  };
  const summaryRef = {
    collection: () => listsRef,
    set: async (data) => { operations.push(['set', 'imageFileCheck', data]); },
  };
  return {
    operations,
    storeRef: { collection: () => ({ doc: () => summaryRef }) },
  };
}

function ids(count, prefix = 'id') {
  return Array.from({ length: count }, (_, index) => `${prefix}${String(index).padStart(6, '0')}`);
}

test('reads the recorded URL from images[0].fileUrl', () => {
  assert.equal(imageUrlOf({ images: [{ fileUrl: `  ${STORAGE_URL} ` }] }), STORAGE_URL);
  assert.equal(imageUrlOf({ images: [] }), '');
  assert.equal(imageUrlOf({}), '');
});

test('maps HTTP status to a reason and leaves the rest as temporary failure', () => {
  assert.equal(reasonFromStatus(200), REASONS.ok);
  assert.equal(reasonFromStatus(206), REASONS.ok);
  assert.equal(reasonFromStatus(404), REASONS.missingFile);
  assert.equal(reasonFromStatus(403), REASONS.accessDenied);
  assert.equal(reasonFromStatus(401), REASONS.accessDenied);
  assert.equal(reasonFromStatus(429), null);
  assert.equal(reasonFromStatus(503), null);
});

test('reports the first Storage folder of the object', () => {
  assert.equal(storageFolderOf(STORAGE_URL), 'produtosMobile');
  assert.equal(storageFolderOf('https://example.com/foto.jpg'), 'outro');
});

test('extracts bucket and object path only from Firebase Storage URLs', () => {
  assert.deepEqual(storageObjectOf(STORAGE_URL), { bucket: 'bucket', path: 'produtosMobile/789.webp' });
  assert.equal(storageObjectOf('https://example.com/produtosMobile/789.webp'), null);
  assert.equal(storageObjectOf('nao e url'), null);
});

test('products without a usable URL are classified without opening anything', async () => {
  let opened = 0;
  const checker = createUrlChecker({ open: async () => { opened += 1; return { status: 200, reason: REASONS.ok }; } });

  assert.equal((await evaluateProduct({ images: [] }, checker)).reason, REASONS.noUrl);
  assert.equal((await evaluateProduct({ images: [{ fileUrl: 'produtosMobile/789.webp' }] }, checker)).reason, REASONS.invalidUrl);
  assert.equal(opened, 0);
});

test('each URL is opened once and concurrency is respected', async () => {
  let active = 0;
  let maxActive = 0;
  let opened = 0;
  const open = async () => {
    opened += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return { status: 206, reason: REASONS.ok };
  };
  const checker = createUrlChecker({ concurrency: 2, open });
  const urls = ['a', 'b', 'c', 'a', 'b', 'd'].map((suffix) => `${STORAGE_URL}${suffix}`);

  await Promise.all(urls.map((url) => checker.check(url)));

  assert.equal(opened, 4);
  assert.equal(maxActive, 2);
  assert.deepEqual(checker.stats(), { uniqueUrls: 4, requests: 4 });
});

test('asks only for the first byte and discards the body', async () => {
  let request;
  let cancelled = false;
  const fetchImpl = async (url, options) => {
    request = options;
    return { status: 206, body: { cancel: async () => { cancelled = true; } } };
  };

  const result = await openImageUrl(STORAGE_URL, { fetchImpl });

  assert.deepEqual(result, { status: 206, reason: REASONS.ok });
  assert.equal(request.headers.Range, 'bytes=0-0');
  assert.equal(cancelled, true);
});

test('a timeout is a temporary failure, not a missing photo', async () => {
  const fetchImpl = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });

  const result = await openImageUrl(STORAGE_URL, { fetchImpl, timeoutMs: 10 });

  assert.deepEqual(result, { status: null, reason: null, error: 'timeout' });
});

test('lists object names page by page', async () => {
  const pages = [
    [[{ name: 'Products/a.webp' }, { name: 'Products/b.webp' }], { pageToken: 'p2' }],
    [[{ name: 'Products/c.webp' }], null],
  ];
  const queries = [];
  const bucket = { getFiles: async (query) => { queries.push(query); return pages.shift(); } };

  assert.deepEqual(await listBucketNames(bucket, 'Products/'), ['Products/a.webp', 'Products/b.webp', 'Products/c.webp']);
  assert.equal(queries[0].prefix, 'Products/');
  assert.equal(queries[0].autoPaginate, false);
});

test('each folder is listed once and the access key is ignored', async () => {
  let listings = 0;
  const index = createStorageIndex({
    listNames: async (bucket, prefix) => {
      listings += 1;
      return prefix === 'produtosMobile/' ? ['produtosMobile/1.webp'] : [];
    },
  });

  assert.equal(await index.exists(storageUrl('produtosMobile/1.webp', 'outra-chave')), true);
  assert.equal(await index.exists(storageUrl('produtosMobile/2.webp')), false);
  assert.equal(await index.exists(storageUrl('outraPasta/1.webp')), null);
  assert.equal(await index.exists('https://example.com/foto.jpg'), null);
  assert.equal(listings, 1);
  assert.deepEqual(index.stats(), { listedFolders: 1, listedObjects: 1 });
});

test('a listing failure stops the pass instead of counting photos as missing', async () => {
  const index = createStorageIndex({ listNames: async () => { throw new Error('sem permissao'); } });
  await assert.rejects(index.exists(storageUrl('Products/a.webp')), StorageListingError);
});

test('classifies by listing, opens unlisted URLs and keeps the method when the sample agrees', async () => {
  const opened = [];
  const checker = createUrlChecker({
    open: async (url) => {
      opened.push(url);
      if (url.includes('ausente')) return { status: 404, reason: REASONS.missingFile };
      return { status: 206, reason: REASONS.ok };
    },
  });
  const index = createStorageIndex({ listNames: listingOf({ 'produtosMobile/': ['produtosMobile/ok.webp'] }) });
  const storeRef = fakeStoreRef([
    { id: 'p3', url: storageUrl('produtosMobile/ausente.webp'), tags: [] },
    { id: 'p1', url: storageUrl('produtosMobile/ok.webp'), tags: undefined, categoriesIds: [''] },
    { id: 'p2' },
    { id: 'p4', url: 'https://example.com/foto.jpg', categoriesIds: undefined },
  ]);

  const summary = await runEstablishmentPass({ storeRef, index, checker, sampleSize: 30, queryPageSize: 2 });

  assert.equal(summary.metodo, 'listagem');
  assert.equal(summary.produtosAtivos, 4);
  assert.equal(summary.semFoto, 2);
  assert.deepEqual(summary.idsSemFoto, ['p2', 'p3']);
  assert.equal(summary.semTag, 2);
  assert.deepEqual(summary.idsSemTag, ['p1', 'p3']);
  assert.equal(summary.semCategoria, 2);
  assert.deepEqual(summary.idsSemCategoria, ['p1', 'p4']);
  assert.deepEqual(summary.porMotivo, { ok: 2, arquivo_ausente: 1, acesso_negado: 0, sem_url: 1, url_invalida: 0 });
  assert.equal(summary.amostra, 2);
  assert.equal(summary.divergenciasAmostra, 0);
  assert.ok(opened.includes('https://example.com/foto.jpg'));
});

test('falls back to opening every URL when the sample disagrees with the listing', async () => {
  const checker = createUrlChecker({ open: async () => ({ status: 403, reason: REASONS.accessDenied }) });
  const index = createStorageIndex({ listNames: listingOf({ 'Products/': ['Products/a.webp', 'Products/b.webp'] }) });
  const storeRef = fakeStoreRef([
    { id: 'a', url: storageUrl('Products/a.webp') },
    { id: 'b', url: storageUrl('Products/b.webp') },
  ]);

  const summary = await runEstablishmentPass({ storeRef, index, checker, sampleSize: 1 });

  assert.equal(summary.metodo, 'abertura');
  assert.equal(summary.divergenciasAmostra, 1);
  assert.equal(summary.porMotivo.acesso_negado, 2);
  assert.deepEqual(summary.idsSemFoto, ['a', 'b']);
});

test('tag and category count as empty when missing, not a list, empty or only blank text', () => {
  assert.equal(hasTags({ tags: ['arroz'] }), true);
  assert.equal(hasTags({}), false);
  assert.equal(hasTags({ tags: [] }), false);
  assert.equal(hasTags({ tags: ['', '  '] }), false);
  assert.equal(hasTags({ tags: 'arroz' }), false);
  assert.equal(hasCategory({ categoriesIds: ['cat1'] }), true);
  assert.equal(hasCategory({}), false);
  assert.equal(hasCategory({ categoriesIds: [''] }), false);
  assert.equal(hasCategory({ categoriesIds: null }), false);
});

test('for sale follows the app rule: active, price above zero, stock missing or above zero', () => {
  const forSale = { isActive: true, currentPrice: 10 };
  assert.equal(isForSale(forSale), true);
  assert.equal(isForSale({ ...forSale, quantityInStock: 3 }), true);
  assert.equal(isForSale({ ...forSale, quantityInStock: null }), true);
  assert.equal(isForSale({ ...forSale, quantityInStock: 0 }), false);
  assert.equal(isForSale({ ...forSale, quantityInStock: -2 }), false);
  assert.equal(isForSale({ ...forSale, currentPrice: 0 }), false);
  assert.equal(isForSale({ ...forSale, currentPrice: '10' }), false);
  assert.equal(isForSale({ ...forSale, isActive: false }), false);
  assert.equal(isForSale({ currentPrice: 10 }), false);
});

test('splits the stock of a product in four bands', () => {
  assert.equal(stockBandOf({}), 'semCampo');
  assert.equal(stockBandOf({ quantityInStock: null }), 'semCampo');
  assert.equal(stockBandOf({ quantityInStock: 1 }), 'ate10');
  assert.equal(stockBandOf({ quantityInStock: 10 }), 'ate10');
  assert.equal(stockBandOf({ quantityInStock: 11 }), 'de11a20');
  assert.equal(stockBandOf({ quantityInStock: 20 }), 'de11a20');
  assert.equal(stockBandOf({ quantityInStock: 21 }), 'acima20');
});

test('counts what is for sale inside each set without changing the id lists', async () => {
  const checker = createUrlChecker({ open: async () => ({ status: 404, reason: REASONS.missingFile }) });
  const index = createStorageIndex({ listNames: listingOf({ 'produtosMobile/': [] }) });
  const storeRef = fakeStoreRef([
    // sem foto e a venda, sem estoque cadastrado
    { id: 'a', url: storageUrl('produtosMobile/1.webp'), tags: [] },
    // sem foto, fora de venda por estoque zerado
    { id: 'b', url: storageUrl('produtosMobile/2.webp'), quantityInStock: 0 },
    // completo e a venda, estoque na faixa de 11 a 20
    { id: 'c', url: storageUrl('produtosMobile/3.webp'), quantityInStock: 15 },
    // sem categoria, fora de venda por preco zerado
    { id: 'd', url: storageUrl('produtosMobile/4.webp'), currentPrice: 0, categoriesIds: [] },
  ]);

  const summary = await runEstablishmentPass({ storeRef, index, checker, sampleSize: 0 });

  assert.equal(summary.semFoto, 4);
  assert.deepEqual(summary.idsSemFoto, ['a', 'b', 'c', 'd']);
  assert.equal(summary.produtosAVenda, 2);
  assert.equal(summary.semFotoAVenda, 2);
  assert.equal(summary.semTag, 1);
  assert.equal(summary.semTagAVenda, 1);
  assert.equal(summary.semCategoria, 1);
  assert.equal(summary.semCategoriaAVenda, 0);
  assert.deepEqual(summary.estoqueDosAVenda, { ate10: 0, de11a20: 1, acima20: 0, semCampo: 1 });

  // Recortes gravados como listas: semFotoAVenda dentro de semFoto, e
  // aVenda + foraDeVenda dividindo o catalogo ativo sem sobreposicao.
  assert.deepEqual(summary.idsSemFotoAVenda, ['a', 'c']);
  assert.equal(summary.idsSemFotoAVenda.length, summary.semFotoAVenda);
  assert.ok(summary.idsSemFotoAVenda.every((id) => summary.idsSemFoto.includes(id)));
  assert.deepEqual(summary.idsAVenda, ['a', 'c']);
  assert.deepEqual(summary.idsForaDeVenda, ['b', 'd']);
  assert.equal(summary.idsAVenda.length, summary.produtosAVenda);
  assert.equal(summary.idsAVenda.length + summary.idsForaDeVenda.length, summary.produtosAtivos);
  assert.ok(summary.idsAVenda.every((id) => !summary.idsForaDeVenda.includes(id)));
});

test('search is broken when some word of the name has no canonical key stored', () => {
  assert.equal(hasBrokenSearch({ name: 'Maionese Hellmanns', wordKeys: ['ma', 'maionese'], searchIndex: ['hellmanns'] }), true);
  assert.equal(hasBrokenSearch({ name: 'Maçã', wordKeys: ['maçã'], searchIndex: ['7891050004604'] }), true);
  assert.equal(hasBrokenSearch({ name: 'Suco Lua Nova', wordKeys: ['CACH', 'CACHA', 'CACHACA'] }), true);
  assert.equal(hasBrokenSearch({ name: 'Vodka', wordKeys: ['VODK', 'VODKA'], searchIndex: ['7891050004604'] }), false);
  assert.equal(hasBrokenSearch({ name: 'Vodka', wordKeys: ['vodka'], searchIndex: ['VODKA'] }), false);
  assert.equal(hasBrokenSearch({ name: 'Coca 2l', wordKeys: ['COCA', '2L'] }), false);
  assert.equal(hasBrokenSearch({ name: 'Coca 2l', wordKeys: ['COCA'] }), true);
  assert.equal(hasBrokenSearch({ name: 'Ruffles C/cebola', wordKeys: ['RUFFLES', 'CEBOLA'] }), false);
  assert.equal(hasBrokenSearch({ name: 'Ruffles C/cebola', wordKeys: ['RUFFLES', 'C/CEBOLA'] }), true);
  assert.equal(hasBrokenSearch({ name: '', wordKeys: ['7891050004604'] }), false);
  assert.equal(hasBrokenSearch({}), false);
});

test('a shelf is valid when its active subcategory belongs to an existing category', () => {
  const validKeys = validShelfKeys(
    [{ id: 'mercearia' }, { id: 'frios_e_laticinios' }],
    [
      { id: 'sub1', data: { categoryId: 'mercearia', isActive: true } },
      { id: 'sub2', data: { categoryId: 'mercearia', isActive: false } },
      { id: 'sub3', data: { categoryId: 'apagada', isActive: true } },
      { id: 'queijos', data: { categoryId: 'frios_e_laticinios', isActive: true } },
    ],
  );

  assert.deepEqual([...validKeys].sort(), ['frios_e_laticinios_queijos', 'mercearia_sub1']);
  assert.equal(shelfStatusOf({ shelvesIds: ['mercearia_sub1'] }, validKeys), 'ok');
  assert.equal(shelfStatusOf({ shelvesIds: ['frios_e_laticinios_queijos'] }, validKeys), 'ok');
  assert.equal(shelfStatusOf({ shelvesIds: ['mercearia_sub2', 'mercearia_sub1'] }, validKeys), 'ok');
  assert.equal(shelfStatusOf({ shelvesIds: ['mercearia_sub2'] }, validKeys), 'inexistente');
  assert.equal(shelfStatusOf({ shelvesIds: ['apagada_sub3'] }, validKeys), 'inexistente');
  assert.equal(shelfStatusOf({ shelvesIds: ['bebidas_vinhos'] }, validKeys), 'inexistente');
  assert.equal(shelfStatusOf({ shelvesIds: [] }, validKeys), 'semShelvesIds');
  assert.equal(shelfStatusOf({ shelvesIds: [' '] }, validKeys), 'semShelvesIds');
  assert.equal(shelfStatusOf({}, validKeys), 'semShelvesIds');
});

test('shelf, search and blocked-that-sold lists only take products that match their rule', async () => {
  const checker = createUrlChecker({ open: async () => ({ status: 206, reason: REASONS.ok }) });
  const index = createStorageIndex({ listNames: listingOf({ 'produtosMobile/': ['produtosMobile/1.webp'] }) });
  const url = storageUrl('produtosMobile/1.webp');
  const storeRef = fakeStoreRef([
    { id: 'a', url, name: 'Maionese', shelvesIds: ['mercearia_sub1'], wordKeys: ['MAIONESE'] },
    { id: 'b', url, name: 'Maionese', shelvesIds: [], wordKeys: ['maionese'] },
    { id: 'c', url, name: 'Batata', shelvesIds: ['mercearia_apagada'], searchIndex: ['batata'] },
    { id: 'd', url, name: 'Vodka', shelvesIds: [], wordKeys: ['vodka'], isActive: false },
  ], {
    categories: [{ id: 'mercearia' }],
    subcategories: [{ id: 'sub1', categoryId: 'mercearia', isActive: true }],
  });

  const summary = await runEstablishmentPass({
    storeRef,
    index,
    checker,
    sampleSize: 0,
    loadOrders: async () => [order({ dias: 40, itens: [item('d', 1, 12), item('a', 1, 5)] })],
  });

  assert.deepEqual(summary.idsSemPrateleiraAVenda, ['b', 'c']);
  assert.equal(summary.semPrateleiraAVenda, 2);
  assert.equal(summary.semShelvesIdsAVenda, 1);
  assert.equal(summary.prateleiraInexistenteAVenda, 1);
  assert.deepEqual(summary.idsBuscaQuebradaAVenda, ['b', 'c']);
  assert.equal(summary.buscaQuebradaAVenda, 2);
  assert.deepEqual(summary.idsBloqueadosQueVenderam90, ['d']);
  assert.equal(summary.idsBloqueadosQueVenderam90.length, summary.vendas90.bloqueadosQueVenderam);
  assert.equal(summary.vendas30.bloqueadosQueVenderam, 0);
});

function order({ status = 'PurchaseStatus.completed', dias = 1, itens = [] } = {}) {
  const date = new Date();
  date.setDate(date.getDate() - dias);
  return { currentPurchaseStatus: status, createdAt: { toDate: () => date }, productsCart: itens };
}

function item(id, quantity, price) {
  return { productRef: { id }, quantity, product: { price } };
}

test('sales come only from confirmed orders, split by window', () => {
  const sales = salesFromOrders([
    order({ dias: 1, itens: [item('a', 2, 10), item('b', 1, 5)] }),
    order({ status: 'PurchaseStatus.canceled', dias: 1, itens: [item('c', 5, 100)] }),
    order({ status: 'PurchaseStatus.accepted', dias: 45, itens: [item('a', 1, 10), item('d', 3, 2)] }),
    order({ dias: 200, itens: [item('e', 9, 9)] }),
  ]);

  assert.deepEqual(sales.confirmedOrders, { vendas30: 1, vendas90: 2 });
  assert.deepEqual([...sales.byProduct.keys()].sort(), ['a', 'b', 'd']);
  assert.deepEqual(sales.byProduct.get('a'), { vendas30: { unidades: 2, valor: 20 }, vendas90: { unidades: 3, valor: 30 } });
  assert.deepEqual(sales.byProduct.get('d').vendas30, { unidades: 0, valor: 0 });
  assert.deepEqual(sales.byProduct.get('d').vendas90, { unidades: 3, valor: 6 });
});

test('quantity defaults to one and the product id can come from the item itself', () => {
  const sales = salesFromOrders([
    order({ itens: [{ product: { id: 'x', price: 7 } }, { productId: 'y', quantity: 2, product: { currentPrice: 3 } }] }),
  ]);

  assert.deepEqual(sales.byProduct.get('x').vendas30, { unidades: 1, valor: 7 });
  assert.deepEqual(sales.byProduct.get('y').vendas30, { unidades: 2, valor: 6 });
});

test('counts products sold that nobody can buy today, with their revenue', () => {
  const sales = salesFromOrders([
    order({ dias: 1, itens: [item('a', 2, 10), item('b', 1, 5)] }),
    order({ status: 'PurchaseStatus.accepted', dias: 45, itens: [item('d', 3, 2)] }),
  ]);
  const products = [
    { id: 'a', product: { isActive: true, currentPrice: 10 } },
    { id: 'b', product: { isActive: false, currentPrice: 5 } },
    { id: 'd', product: { isActive: true, currentPrice: 0 } },
  ];

  assert.deepEqual(summarizeSales(sales, products), {
    vendas30: { pedidosConfirmados: 1, produtosVendidos: 2, bloqueadosQueVenderam: 1, faturamentoDosBloqueados: 5 },
    vendas90: { pedidosConfirmados: 2, produtosVendidos: 3, bloqueadosQueVenderam: 2, faturamentoDosBloqueados: 11 },
  });
});

test('the pass reports zeroed sales when no order is loaded', async () => {
  const checker = createUrlChecker({ open: async () => ({ status: 206, reason: REASONS.ok }) });
  const index = createStorageIndex({ listNames: listingOf({ 'produtosMobile/': ['produtosMobile/1.webp'] }) });
  const storeRef = fakeStoreRef([{ id: 'a', url: storageUrl('produtosMobile/1.webp') }]);

  const semPedidos = await runEstablishmentPass({ storeRef, index, checker, sampleSize: 0 });
  assert.deepEqual(semPedidos.vendas30, { pedidosConfirmados: 0, produtosVendidos: 0, bloqueadosQueVenderam: 0, faturamentoDosBloqueados: 0 });

  const comPedidos = await runEstablishmentPass({
    storeRef,
    index,
    checker,
    sampleSize: 0,
    loadOrders: async () => [order({ itens: [item('a', 4, 2)] })],
  });
  assert.equal(comPedidos.vendas30.produtosVendidos, 1);
  assert.equal(comPedidos.vendas30.pedidosConfirmados, 1);
  assert.equal(comPedidos.vendas30.bloqueadosQueVenderam, 0);
});

test('splits the id list in pages of 20000', () => {
  assert.deepEqual(splitIds(ids(45001)).map((page) => page.length), [20000, 20000, 5001]);
  assert.deepEqual(splitIds([]), [[]]);
});

test('writes every list, then the summary without ids, then removes leftover pages', async () => {
  const { operations, storeRef } = fakeSummaryStore({ semFoto: 1, semTag: 4, semCategoria: 1 });
  const passResult = {
    produtosAtivos: 30000,
    produtosAVenda: 12000,
    semFoto: 2,
    semFotoAVenda: 1,
    idsSemFoto: ['a', 'b'],
    semTag: 20001,
    semTagAVenda: 9000,
    idsSemTag: ids(20001),
    semCategoria: 0,
    semCategoriaAVenda: 0,
    idsSemCategoria: [],
    idsSemFotoAVenda: ['a'],
    idsAVenda: ['a', 'c'],
    idsForaDeVenda: ['b'],
    semPrateleiraAVenda: 1,
    semShelvesIdsAVenda: 0,
    prateleiraInexistenteAVenda: 1,
    idsSemPrateleiraAVenda: ['c'],
    buscaQuebradaAVenda: 2,
    idsBuscaQuebradaAVenda: ['a', 'c'],
    idsBloqueadosQueVenderam90: ['b'],
    estoqueDosAVenda: { ate10: 100, de11a20: 200, acima20: 300, semCampo: 11400 },
    vendas30: { pedidosConfirmados: 4, produtosVendidos: 48, bloqueadosQueVenderam: 1, faturamentoDosBloqueados: 8.58 },
    vendas90: { pedidosConfirmados: 18, produtosVendidos: 129, bloqueadosQueVenderam: 3, faturamentoDosBloqueados: 41.9 },
    porMotivo: { ok: 29998 },
    semFotoPorPasta: { produtosMobile: 2 },
    falhasTemporarias: 0,
    metodo: 'listagem',
    amostra: 30,
    divergenciasAmostra: 0,
  };

  const result = await writeSummary({ storeRef, summary: passResult, checkedAt: 'agora' });

  assert.deepEqual(result.pageCounts, {
    semFoto: 1,
    semTag: 2,
    semCategoria: 1,
    semFotoAVenda: 1,
    aVenda: 1,
    foraDeVenda: 1,
    semPrateleiraAVenda: 1,
    buscaQuebradaAVenda: 1,
    bloqueadosQueVenderam90: 1,
  });
  assert.deepEqual(operations.map(([kind, path]) => `${kind} ${path}`), [
    'set lists/semFoto',
    'set lists/semTag-2',
    'set lists/semTag',
    'set lists/semCategoria',
    'set lists/semFotoAVenda',
    'set lists/aVenda',
    'set lists/foraDeVenda',
    'set lists/semPrateleiraAVenda',
    'set lists/buscaQuebradaAVenda',
    'set lists/bloqueadosQueVenderam90',
    'set imageFileCheck',
    'delete lists/semTag-3',
    'delete lists/semTag-4',
  ]);

  const list = (path) => operations.find(([kind, target]) => kind === 'set' && target === path)[2];
  assert.deepEqual(list('lists/semFoto'), { ids: ['a', 'b'], total: 2, pageCount: 1 });
  assert.equal(list('lists/semTag').ids.length, 20000);
  assert.equal(list('lists/semTag').total, 20001);
  assert.equal(list('lists/semTag-2').ids.length, 1);
  assert.deepEqual(list('lists/semCategoria'), { ids: [], total: 0, pageCount: 1 });
  assert.deepEqual(list('lists/semFotoAVenda'), { ids: ['a'], total: 1, pageCount: 1 });
  assert.deepEqual(list('lists/aVenda'), { ids: ['a', 'c'], total: 2, pageCount: 1 });
  assert.deepEqual(list('lists/foraDeVenda'), { ids: ['b'], total: 1, pageCount: 1 });
  assert.deepEqual(list('lists/semPrateleiraAVenda'), { ids: ['c'], total: 1, pageCount: 1 });
  assert.deepEqual(list('lists/buscaQuebradaAVenda'), { ids: ['a', 'c'], total: 2, pageCount: 1 });
  assert.deepEqual(list('lists/bloqueadosQueVenderam90'), { ids: ['b'], total: 1, pageCount: 1 });

  const summary = list('imageFileCheck');
  assert.deepEqual(Object.keys(summary).sort(), [
    'amostra', 'buscaQuebradaAVenda', 'checkedAt', 'divergenciasAmostra', 'estoqueDosAVenda',
    'falhasTemporarias', 'metodo', 'porMotivo', 'prateleiraInexistenteAVenda', 'produtosAVenda',
    'produtosAtivos', 'semCategoria', 'semCategoriaAVenda', 'semFoto', 'semFotoAVenda',
    'semPrateleiraAVenda', 'semShelvesIdsAVenda', 'semTag', 'semTagAVenda',
    'vendas30', 'vendas90', 'version',
  ]);
  assert.equal(summary.falhasTemporarias, 0);
  assert.equal(summary.version, 7);
  assert.equal(summary.checkedAt, 'agora');
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 1024);
});

test('a store without previous lists deletes nothing', async () => {
  const { operations, storeRef } = fakeSummaryStore();

  await writeSummary({
    storeRef,
    summary: { semFoto: 1, idsSemFoto: ['x'], semTag: 0, idsSemTag: [], semCategoria: 0, idsSemCategoria: [] },
    checkedAt: 'agora',
  });

  assert.equal(operations.filter(([kind]) => kind === 'delete').length, 0);
  assert.equal(operations.at(-1)[1], 'imageFileCheck');
});

test('the store list comes only from the CoreJobs document', () => {
  assert.deepEqual(configuredEstablishmentIds({ enabled: true, establishmentIds: [' a ', 'b', 'a', '', 'x/y'] }), ['a', 'b']);
  assert.deepEqual(configuredEstablishmentIds({ enabled: false, establishmentIds: ['a'] }), []);
  assert.deepEqual(configuredEstablishmentIds({ establishmentIds: ['a'] }), []);
  assert.deepEqual(configuredEstablishmentIds(undefined), []);
});
