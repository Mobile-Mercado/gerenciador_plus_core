const admin = require('firebase-admin');
const {
  CONTRIBUICOES_COLLECTION,
  RESUMO_VENDAS_COLLECTION,
  RESUMO_VENDAS_VERSION,
  contribuicaoDoPedido,
  ehVenda,
  montarMeses,
} = require('../resumoVendas');
const { marcarMudanca } = require('../marcador');

// O Firestore aceita 1 MiB por documento; o aviso sai antes, com folga.
const LIMITE_DE_AVISO = 900 * 1024;
const OPERACOES_POR_LOTE = 400;
const LEITURAS_POR_LOTE = 300;

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function usage() {
  return [
    'Uso:',
    '  node scripts/gerarResumoVendas.js --loja ID [--gravar] [--project ID]',
    '',
    'Sem --gravar, so le: mostra os meses e os bytes de cada documento de ResumoVendas.',
    'Com --gravar, refaz do zero os meses e as contribuicoes da loja e soma o marcador.',
  ].join('\n');
}

const bytesDe = (valor) => Buffer.byteLength(JSON.stringify(valor));

async function lerEmLotes(db, referencias) {
  const resultado = [];
  for (let inicio = 0; inicio < referencias.length; inicio += LEITURAS_POR_LOTE) {
    resultado.push(...await db.getAll(...referencias.slice(inicio, inicio + LEITURAS_POR_LOTE)));
  }
  return resultado;
}

const idDoItem = (item) => {
  const valor = item?.productReference || item?.productRef || item?.reference || item?.product?.id
    || item?.productData?.id || item?.productId || item?.id;
  if (!valor) return '';
  if (typeof valor === 'string') return valor.split('/').filter(Boolean).at(-1) || valor;
  return valor.id || valor.path?.split('/').filter(Boolean).at(-1) || '';
};

// Produtos e categorias de todas as vendas da loja, lidos uma vez so.
async function metaDaLoja(db, lojaRef, vendas) {
  const idsDeProduto = [...new Set(vendas.flatMap((venda) => (venda.data.productsCart || venda.data.items || []).map(idDoItem)).filter(Boolean))];
  const produtos = new Map();
  (await lerEmLotes(db, idsDeProduto.map((id) => lojaRef.collection('Products').doc(id)))).forEach((snapshot) => {
    const dados = snapshot.exists ? snapshot.data() : {};
    produtos.set(snapshot.id, {
      name: dados.name || null,
      categoriesIds: Array.isArray(dados.categoriesIds) ? dados.categoriesIds : [],
      shelves: Array.isArray(dados.shelves) ? dados.shelves.map((shelf) => ({ productCategoryId: shelf.productCategoryId || shelf.categoryId || null })) : [],
    });
  });
  const categorias = new Map();
  (await lojaRef.collection('ProductCategories').get()).docs.forEach((doc) => categorias.set(doc.id, doc.get('name') || null));
  return { produtos, categorias };
}

async function apagarTudo(db, colecao) {
  const documentos = await colecao.listDocuments();
  for (let inicio = 0; inicio < documentos.length; inicio += OPERACOES_POR_LOTE) {
    const batch = db.batch();
    documentos.slice(inicio, inicio + OPERACOES_POR_LOTE).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
  return documentos.length;
}

async function main() {
  const lojaId = argument('loja');
  if (!lojaId) {
    console.error(usage());
    process.exitCode = 1;
    return;
  }
  const gravar = process.argv.includes('--gravar');
  const projectId = argument('project') || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  admin.initializeApp(projectId ? { projectId } : undefined);
  const db = admin.firestore();
  const lojaRef = db.collection('estabelecimentos').doc(lojaId);

  const snapshot = await db.collection('PurchaseRequests').where('companyReference', '==', lojaRef).get();
  const vendas = snapshot.docs.filter((doc) => ehVenda(doc.data())).map((doc) => ({ id: doc.id, data: doc.data() }));
  const meta = await metaDaLoja(db, lojaRef, vendas);
  const contribuicoes = vendas
    .map(({ id, data }) => {
      const contribuicao = contribuicaoDoPedido(id, data, meta);
      if (!contribuicao) return null;
      const metaProdutos = {};
      (data.productsCart || data.items || []).forEach((item) => {
        const produtoId = idDoItem(item);
        if (produtoId && meta.produtos.has(produtoId)) metaProdutos[produtoId] = meta.produtos.get(produtoId);
      });
      return { ...contribuicao, metaProdutos };
    })
    .filter(Boolean);
  const meses = montarMeses(contribuicoes);

  console.log(`Loja ${lojaId}: ${snapshot.size} pedidos, ${contribuicoes.length} vendas, ${meses.size} meses`);
  console.log('documento | vendas | bytes');
  const tamanhos = [];
  [...meses.entries()].sort(([a], [b]) => a.localeCompare(b)).forEach(([mes, documento]) => {
    const bytes = bytesDe(documento);
    tamanhos.push(bytes);
    const vendasDoMes = contribuicoes.filter((contribuicao) => contribuicao.mes === mes).length;
    console.log(`${mes} | ${vendasDoMes} | ${bytes}${bytes > LIMITE_DE_AVISO ? '  << PASSA DE 900 KB' : ''}`);
  });
  const media = tamanhos.length ? tamanhos.reduce((soma, bytes) => soma + bytes, 0) / tamanhos.length : 0;
  console.log(`bytes por documento: media ${media.toFixed(0)}, maximo ${tamanhos.length ? Math.max(...tamanhos) : 0}`);
  const contribuicaoMaior = contribuicoes.length ? Math.max(...contribuicoes.map(bytesDe)) : 0;
  console.log(`maior contribuicao: ${contribuicaoMaior} bytes`);

  if (!gravar) {
    console.log('\nSimulacao: nada foi gravado. Use --gravar para gravar os documentos.');
    return;
  }

  const apagadosMeses = await apagarTudo(db, lojaRef.collection(RESUMO_VENDAS_COLLECTION));
  const apagadasContribuicoes = await apagarTudo(db, lojaRef.collection(CONTRIBUICOES_COLLECTION));
  const escritas = [
    ...[...meses.entries()].map(([mes, documento]) => [lojaRef.collection(RESUMO_VENDAS_COLLECTION).doc(mes), documento]),
    ...contribuicoes.map((contribuicao) => [lojaRef.collection(CONTRIBUICOES_COLLECTION).doc(contribuicao.pedidoId), contribuicao]),
  ];
  for (let inicio = 0; inicio < escritas.length; inicio += OPERACOES_POR_LOTE) {
    const batch = db.batch();
    escritas.slice(inicio, inicio + OPERACOES_POR_LOTE).forEach(([ref, dados]) => {
      batch.set(ref, { ...dados, versaoResumo: RESUMO_VENDAS_VERSION, atualizadoEm: admin.firestore.FieldValue.serverTimestamp() });
    });
    await batch.commit();
  }
  console.log(`\nApagados ${apagadosMeses} meses e ${apagadasContribuicoes} contribuicoes antigos.`);
  console.log(`Gravados ${meses.size} meses e ${contribuicoes.length} contribuicoes em estabelecimentos/${lojaId}.`);
  await marcarMudanca({ db, FieldValue: admin.firestore.FieldValue, lojaId, tipo: 'vendas' });
  console.log(`Marcador: vendas somado em estabelecimentos/${lojaId}/Stats/marcador.`);
}

main().catch((error) => {
  console.error('[gerarResumoVendas] Falha', error.message);
  process.exitCode = 1;
});
