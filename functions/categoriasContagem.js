// Contagem de produtos por categoria e por subcategoria de uma loja.
//
// Arquivo puro de proposito: nao requer firebase-admin nem firebase-functions e
// recebe as referencias por parametro, como hourlySalesAggregation.js. E por isso
// que o BFF, que publica so as dependencias da raiz, pode importa-lo.

const CONTAGEM_VERSION = 1;
const CONTAGEM_CONCURRENCY = 20;
const CONTAGEM_DOCUMENT = 'categoriasContagem';

// Fica gravado no documento: quem ler os numeros depois nao vai tratar a diferenca
// como erro de contagem.
const OBSERVACAO = 'A soma de porCategoria nao fecha com totalAtivos, e isso nao e '
  + 'erro: produto em duas categorias conta nas duas. Medido na Zero Grau em '
  + '29/09/2026: 7.062 somando as categorias contra 6.410 produtos ativos. O mesmo '
  + 'vale para porSubcategoria.';

async function mapWithConcurrency(items, concurrency, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// Mesma consulta que a tela de Categorias faz hoje: isTrashed false mais
// array-contains do id, pela agregacao count().
async function countProductsByArrayField(productsRef, field, value) {
  const snapshot = await productsRef
    .where('isTrashed', '==', false)
    .where(field, 'array-contains', value)
    .count()
    .get();
  return Number(snapshot.data().count || 0);
}

async function countByIds(productsRef, ids, field, concurrency) {
  const pares = await mapWithConcurrency(ids, concurrency, async (id) => [
    id,
    await countProductsByArrayField(productsRef, field, id),
  ]);
  return Object.fromEntries(pares);
}

async function contarCategorias({ storeRef, concurrency = CONTAGEM_CONCURRENCY }) {
  const startedAt = Date.now();
  const productsRef = storeRef.collection('Products');
  const [categorias, subcategorias, ativos] = await Promise.all([
    storeRef.collection('ProductCategories').select().get(),
    storeRef.collection('ProductSubcategories').select().get(),
    productsRef.where('isTrashed', '==', false).count().get(),
  ]);

  const categoryIds = categorias.docs.map((document) => document.id);
  const subcategoryIds = subcategorias.docs.map((document) => document.id);
  const porCategoria = await countByIds(productsRef, categoryIds, 'categoriesIds', concurrency);
  const porSubcategoria = await countByIds(productsRef, subcategoryIds, 'subcategoriesIds', concurrency);

  return {
    version: CONTAGEM_VERSION,
    porCategoria,
    porSubcategoria,
    totalAtivos: Number(ativos.data().count || 0),
    categorias: categoryIds.length,
    subcategorias: subcategoryIds.length,
    segundos: Math.round((Date.now() - startedAt) / 100) / 10,
    observacao: OBSERVACAO,
  };
}

function contagemReference(storeRef) {
  return storeRef.collection('Stats').doc(CONTAGEM_DOCUMENT);
}

// Conta, grava e devolve o documento como ficou gravado, para a rota responder com
// o mesmo conteudo que a tela vai ler depois.
async function recalcularCategorias({ storeRef, geradoEm, concurrency }) {
  const contagem = await contarCategorias({ storeRef, concurrency });
  const reference = contagemReference(storeRef);
  await reference.set({ ...contagem, geradoEm });
  const gravado = await reference.get();
  return gravado.data();
}

module.exports = {
  CONTAGEM_CONCURRENCY,
  CONTAGEM_DOCUMENT,
  CONTAGEM_VERSION,
  OBSERVACAO,
  contagemReference,
  contarCategorias,
  countProductsByArrayField,
  recalcularCategorias,
};
