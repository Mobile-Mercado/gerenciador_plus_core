const admin = require('firebase-admin');
const {
  RESUMO_COLLECTION,
  RESUMO_VERSION,
  TOTAL_DE_BLOCOS,
  blocoDoCliente,
  chaveDoPedido,
  resumirCliente,
  segmentoDoCliente,
} = require('../resumoClientes');
const { marcarMudanca } = require('../marcador');

const USERS_POR_LOTE = 100;

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function usage() {
  return [
    'Uso:',
    '  node scripts/gerarResumoClientes.js --loja ID [--gravar] [--project ID]',
    '',
    'Sem --gravar, so le: mostra clientes, blocos e a tabela por cliente.',
    'Com --gravar, substitui os 16 documentos de estabelecimentos/{loja}/ResumoClientes.',
  ].join('\n');
}

const dataHora = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

async function lerUsuarios(db, ids) {
  const usuarios = new Map();
  for (let inicio = 0; inicio < ids.length; inicio += USERS_POR_LOTE) {
    const refs = ids.slice(inicio, inicio + USERS_POR_LOTE).map((id) => db.collection('Users').doc(id));
    const snapshots = await db.getAll(...refs);
    snapshots.forEach((snapshot) => {
      if (snapshot.exists) usuarios.set(snapshot.id, { id: snapshot.id, ...snapshot.data() });
    });
  }
  return usuarios;
}

function tabela(linhas, colunas) {
  const larguras = colunas.map((coluna) => Math.max(coluna.length, ...linhas.map((linha) => String(linha[coluna]).length)));
  const formatar = (valores) => valores.map((valor, indice) => String(valor).padEnd(larguras[indice])).join(' | ');
  return [
    formatar(colunas),
    larguras.map((largura) => '-'.repeat(largura)).join('-+-'),
    ...linhas.map((linha) => formatar(colunas.map((coluna) => linha[coluna]))),
  ].join('\n');
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
  const agora = new Date();
  const lojaRef = db.collection('estabelecimentos').doc(lojaId);

  const pedidos = await db.collection('PurchaseRequests').where('companyReference', '==', lojaRef).get();
  const grupos = new Map();
  pedidos.docs.forEach((doc) => {
    const data = doc.data();
    const chave = chaveDoPedido(data);
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(data);
  });

  const ids = [...grupos.keys()].filter((chave) => !chave.startsWith('name:'));
  const usuarios = await lerUsuarios(db, ids);

  const resumos = [...grupos.entries()]
    .map(([chave, dados]) => resumirCliente({ pedidos: dados, usuario: usuarios.get(chave) || null }))
    .filter(Boolean);
  const ltvMedio = resumos.length ? resumos.reduce((soma, resumo) => soma + resumo.ltv, 0) / resumos.length : 0;
  const clientes = resumos.map((resumo) => ({ ...resumo, segmento: segmentoDoCliente({ resumo, ltvMedio, agora }) }));

  const blocos = new Map();
  for (let numero = 0; numero < TOTAL_DE_BLOCOS; numero += 1) blocos.set(String(numero).padStart(2, '0'), {});
  clientes.forEach((cliente) => { blocos.get(blocoDoCliente(cliente.chave))[cliente.chave] = cliente; });

  console.log(`Loja ${lojaId}: ${pedidos.size} pedidos, ${clientes.length} clientes, LTV medio ${ltvMedio.toFixed(2)}`);
  console.log('Clientes por bloco:', [...blocos.entries()].map(([bloco, mapa]) => `${bloco}=${Object.keys(mapa).length}`).join(' '));
  // Tamanho aproximado: JSON do bloco em UTF-8. O Firestore conta um pouco diferente, mas
  // na mesma ordem de grandeza.
  const maior = Math.max(...[...blocos.values()].map((mapa) => Buffer.byteLength(JSON.stringify({ clientes: mapa }))));
  console.log(`Maior bloco: ${(maior / 1024).toFixed(1)} KB`);

  const linhas = [...clientes]
    .sort((a, b) => (b.ultimoPedidoEm?.getTime() || 0) - (a.ultimoPedidoEm?.getTime() || 0))
    .map((cliente) => ({
      nome: cliente.nome,
      segmento: cliente.segmento,
      pedidos: cliente.pedidos,
      ticket: (cliente.ltv / cliente.pedidos).toFixed(2),
      LTV: cliente.ltv.toFixed(2),
      'ultima compra': cliente.ultimoPedidoEm ? dataHora.format(cliente.ultimoPedidoEm).replace(',', '') : '',
      'frequencia (dias)': cliente.frequenciaDias === null ? '' : cliente.frequenciaDias.toFixed(1),
    }));
  console.log('');
  console.log(tabela(linhas, ['nome', 'segmento', 'pedidos', 'ticket', 'LTV', 'ultima compra', 'frequencia (dias)']));

  if (!gravar) {
    console.log('\nSimulacao: nada foi gravado. Use --gravar para gravar os blocos.');
    return;
  }

  const batch = db.batch();
  blocos.forEach((mapa, bloco) => {
    batch.set(lojaRef.collection(RESUMO_COLLECTION).doc(bloco), {
      clientes: mapa,
      versaoResumo: RESUMO_VERSION,
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  await batch.commit();
  console.log(`\nGravados ${blocos.size} blocos em estabelecimentos/${lojaId}/${RESUMO_COLLECTION}.`);
  await marcarMudanca({ db, FieldValue: admin.firestore.FieldValue, lojaId, tipo: 'clientes' });
  console.log(`Marcador: clientes somado em estabelecimentos/${lojaId}/Stats/marcador.`);
}

main().catch((error) => {
  console.error('[gerarResumoClientes] Falha', error.message);
  process.exitCode = 1;
});
