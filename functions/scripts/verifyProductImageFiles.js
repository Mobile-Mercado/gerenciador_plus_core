const admin = require('firebase-admin');
const { getStorage } = require('firebase-admin/storage');
const {
  CHECK_VERSION,
  DEFAULT_SAMPLE_SIZE,
  ID_LISTS,
  SALES_WINDOW_DAYS,
  createStorageIndex,
  createUrlChecker,
  listBucketNames,
  runEstablishmentPass,
  splitIds,
  testAccountIdsFor,
  windowStart,
  writeSummary,
} = require('../productImageFileCheck');

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function usage() {
  return [
    'Uso:',
    '  node scripts/verifyProductImageFiles.js --inventory',
    '  node scripts/verifyProductImageFiles.js --establishment ID [--concurrency 25] [--page-size 500]',
    '  node scripts/verifyProductImageFiles.js --establishment ID --apply',
    '',
    '--inventory      conta lojas, lojas ativas e produtos ativos de cada loja ativa. Nao grava.',
    '--establishment  confere foto, tag e categoria de cada produto ativo da loja; a foto pela',
    '                 listagem do Storage, abrindo uma amostra de URLs para validar. Sem --apply, nao grava.',
    '--apply          grava o resumo em estabelecimentos/{id}/Stats/imageFileCheck e as listas de',
    '                 ids em .../lists/{semFoto,semTag,semCategoria}. Nunca grava em produto.',
    '',
    'A rotina nao imprime nomes de produtos nem dados de clientes.',
  ].join('\n');
}

function progress(message) {
  process.stderr.write(`${message}\n`);
}

// Campos de nome da loja vistos nos documentos de estabelecimentos. Nomes de
// pessoas (nomeProprietario, responsibleName) ficam de fora.
const STORE_NAME_FIELDS = [
  'name',
  'nomeEstabelecimento',
  'fantasyName',
  'corporateName',
  'coorporativeName',
  'franquiaNome',
];

function storeNames(data) {
  return Object.fromEntries(STORE_NAME_FIELDS
    .map((field) => [field, typeof data[field] === 'string' ? data[field].trim() : ''])
    .filter(([, value]) => value));
}

async function runInventory(db) {
  const storesSnapshot = await db
    .collection('estabelecimentos')
    .select(...STORE_NAME_FIELDS, 'isActive')
    .get();

  const perStore = [];
  for (const storeDocument of storesSnapshot.docs) {
    const products = await storeDocument.ref
      .collection('Products')
      .where('isTrashed', '==', false)
      .count()
      .get();
    const data = storeDocument.data();
    perStore.push({
      establishmentId: storeDocument.id,
      nomes: storeNames(data),
      isActive: data.isActive === true,
      produtosAtivos: products.data().count,
    });
  }
  perStore.sort((a, b) => b.produtosAtivos - a.produtosAtivos);

  const activeStores = perStore.filter((store) => store.isActive);
  return {
    modo: 'inventario',
    lojas: perStore.length,
    lojasAtivas: activeStores.length,
    produtosAtivosNasLojasAtivas: activeStores.reduce((sum, store) => sum + store.produtosAtivos, 0),
    produtosAtivosEmTodasAsLojas: perStore.reduce((sum, store) => sum + store.produtosAtivos, 0),
    porLoja: perStore,
  };
}

async function loadStoreOrders(db, storeRef) {
  const since = new Date(windowStart(Math.max(...Object.values(SALES_WINDOW_DAYS))));
  const snapshot = await db
    .collection('PurchaseRequests')
    .where('companyReference', '==', storeRef)
    .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(since))
    .get();
  return snapshot.docs.map((orderDocument) => orderDocument.data());
}

async function runEstablishment(db, { establishmentId, apply, concurrency, pageSize }) {
  const storeRef = db.collection('estabelecimentos').doc(establishmentId);
  const storeSnapshot = await storeRef.get();
  if (!storeSnapshot.exists) throw new Error(`Loja ${establishmentId} nao encontrada.`);

  const index = createStorageIndex({
    listNames: (bucketName, prefix) => listBucketNames(getStorage().bucket(bucketName), prefix),
  });
  const checker = createUrlChecker({ concurrency });
  const startedAt = Date.now();

  const summary = await runEstablishmentPass({
    storeRef,
    documentIdPath: admin.firestore.FieldPath.documentId(),
    index,
    checker,
    sampleSize: DEFAULT_SAMPLE_SIZE,
    queryPageSize: pageSize,
    onPage: (count) => progress(`${count} produtos lidos`),
    loadOrders: () => loadStoreOrders(db, storeRef),
    loadTestAccountIds: (orders) => testAccountIdsFor(db, orders),
  });

  const pageCounts = apply
    ? (await writeSummary({
      storeRef,
      summary,
      checkedAt: admin.firestore.FieldValue.serverTimestamp(),
    })).pageCounts
    : Object.fromEntries(Object.entries(ID_LISTS)
      .map(([list, field]) => [list, splitIds(summary[field]).length]));

  const idFields = new Set(Object.values(ID_LISTS));
  const fields = Object.fromEntries(Object.entries(summary).filter(([key]) => !idFields.has(key)));
  return {
    modo: apply ? 'gravacao' : 'somente-leitura',
    establishmentId,
    version: CHECK_VERSION,
    ...fields,
    paginasPorLista: pageCounts,
    listagem: index.stats(),
    aberturas: checker.stats(),
    duracaoSegundos: Math.round((Date.now() - startedAt) / 1000),
  };
}

async function main() {
  const inventory = flag('inventory');
  const apply = flag('apply');
  const establishmentId = argument('establishment');
  const concurrency = Math.min(100, Math.max(1, Number(argument('concurrency')) || 25));
  const pageSize = Math.min(1000, Math.max(1, Number(argument('page-size')) || 500));
  const projectId = argument('project') || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;

  if (inventory === Boolean(establishmentId)) throw new Error(usage());
  if (apply && !establishmentId) throw new Error(`--apply exige --establishment.\n\n${usage()}`);

  admin.initializeApp(projectId ? { projectId } : undefined);
  const db = admin.firestore();

  const result = inventory
    ? await runInventory(db)
    : await runEstablishment(db, { establishmentId, apply, concurrency, pageSize });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
