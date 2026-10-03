const admin = require('firebase-admin');
const {
  CONTAGEM_COLLECTION,
  CONTAGEM_VERSION,
  DOCUMENTO_ABERTOS,
  MES_SEM_DATA,
  contagemDoMes,
  RESUMO_PEDIDOS_COLLECTION,
  RESUMO_PEDIDOS_VERSION,
  mesDoPedido,
  pedidoAberto,
  resumirPedido,
} = require('../resumoPedidos');
const { marcarMudanca } = require('../marcador');

// O Firestore aceita 1 MiB por documento; o aviso sai antes, com folga.
const LIMITE_DE_AVISO = 900 * 1024;
// Teto de operacoes por lote do Firestore.
const OPERACOES_POR_LOTE = 400;

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function usage() {
  return [
    'Uso:',
    '  node scripts/gerarResumoPedidos.js --loja ID [--gravar] [--project ID]',
    '',
    'Sem --gravar, so le: mostra pedidos e bytes por mes, o tamanho de abertos, os bytes',
    'por pedido e a contagem por status de cada mes. Com --gravar, substitui os documentos',
    'de estabelecimentos/{loja}/ResumoPedidos e de ResumoPedidosContagem.',
  ].join('\n');
}

// Tamanho aproximado: JSON do mapa em UTF-8. O Firestore conta um pouco diferente, mas
// na mesma ordem de grandeza.
const bytesDe = (valor) => Buffer.byteLength(JSON.stringify(valor));

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

  // Mesma consulta da tela Pedidos: companyReference da loja.
  const snapshot = await db.collection('PurchaseRequests').where('companyReference', '==', lojaRef).get();
  const meses = new Map();
  const abertos = {};
  const bytesPorPedido = [];
  snapshot.docs.forEach((doc) => {
    const data = doc.data();
    const resumo = resumirPedido(doc.id, data);
    const mes = mesDoPedido(data.createdAt);
    if (!meses.has(mes)) meses.set(mes, {});
    meses.get(mes)[doc.id] = resumo;
    if (pedidoAberto(resumo.status)) abertos[doc.id] = resumo;
    bytesPorPedido.push(bytesDe(resumo));
  });

  const documentos = [...[...meses.entries()].sort(([a], [b]) => a.localeCompare(b)), [DOCUMENTO_ABERTOS, abertos]];
  console.log(`Loja ${lojaId}: ${snapshot.size} pedidos, ${meses.size} meses, ${Object.keys(abertos).length} abertos`);
  console.log('documento | pedidos | bytes');
  documentos.forEach(([nome, pedidos]) => {
    const bytes = bytesDe({ pedidos });
    const aviso = bytes > LIMITE_DE_AVISO ? '  << PASSA DE 900 KB' : '';
    console.log(`${nome} | ${Object.keys(pedidos).length} | ${bytes}${aviso}`);
  });
  const media = bytesPorPedido.length
    ? bytesPorPedido.reduce((soma, bytes) => soma + bytes, 0) / bytesPorPedido.length
    : 0;
  console.log(`bytes por pedido: media ${media.toFixed(0)}, maximo ${bytesPorPedido.length ? Math.max(...bytesPorPedido) : 0}`);

  // Contagem por status de cada mes (cards Pedidos, Entregues e Cancelados da Home).
  const contagens = [...meses.entries()]
    .filter(([mes]) => mes !== MES_SEM_DATA)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mes, pedidos]) => [mes, contagemDoMes(pedidos)]);
  console.log('\ncontagem | pedidos (confirmados) | nao concretizados | em aberto | entregues | cancelados | bytes');
  contagens.forEach(([mes, contagem]) => {
    const soma = (grupo) => contagem.app[grupo] + contagem.agent[grupo];
    console.log(`${mes} | ${soma('confirmed')} | ${soma('notConcretized')} | ${soma('open')} | ${soma('delivered')} | ${soma('canceled')} | ${bytesDe(contagem)}`);
  });

  if (!gravar) {
    console.log('\nSimulacao: nada foi gravado. Use --gravar para gravar os documentos.');
    return;
  }

  // Substitui cada documento inteiro (sem merge): pedido que saiu da loja some do resumo.
  for (let inicio = 0; inicio < documentos.length; inicio += OPERACOES_POR_LOTE) {
    const batch = db.batch();
    documentos.slice(inicio, inicio + OPERACOES_POR_LOTE).forEach(([nome, pedidos]) => {
      batch.set(lojaRef.collection(RESUMO_PEDIDOS_COLLECTION).doc(nome), {
        pedidos,
        versaoResumo: RESUMO_PEDIDOS_VERSION,
        atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
    await batch.commit();
  }
  console.log(`\nGravados ${documentos.length} documentos em estabelecimentos/${lojaId}/${RESUMO_PEDIDOS_COLLECTION}.`);
  // A contagem substitui o documento inteiro de cada mes.
  for (let inicio = 0; inicio < contagens.length; inicio += OPERACOES_POR_LOTE) {
    const batch = db.batch();
    contagens.slice(inicio, inicio + OPERACOES_POR_LOTE).forEach(([mes, contagem]) => {
      batch.set(lojaRef.collection(CONTAGEM_COLLECTION).doc(mes), {
        ...contagem,
        versaoContagem: CONTAGEM_VERSION,
        atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
    await batch.commit();
  }
  console.log(`Gravadas ${contagens.length} contagens em estabelecimentos/${lojaId}/${CONTAGEM_COLLECTION}.`);
  await marcarMudanca({ db, FieldValue: admin.firestore.FieldValue, lojaId, tipo: 'listaDePedidos' });
  console.log(`Marcador: listaDePedidos somado em estabelecimentos/${lojaId}/Stats/marcador.`);
}

main().catch((error) => {
  console.error('[gerarResumoPedidos] Falha', error.message);
  process.exitCode = 1;
});
