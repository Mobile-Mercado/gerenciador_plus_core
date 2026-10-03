const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { CONTAGEM_COLLECTION, RESUMO_PEDIDOS_COLLECTION, contagemDoMes, mesDoPedido } = require('../resumoPedidos');
const { CONTRIBUICOES_COLLECTION, RESUMO_VENDAS_COLLECTION, ehVenda } = require('../resumoVendas');

// Pedidos de quatro contas da equipe na UAU Mart (decisao do Thay em 03/10/2026): pedido
// delas nao e venda. Os abertos viram teste e denied com motivo encerramento_de_teste, no
// mesmo formato do encerramento de 02/10 na Zero Grau; os ja encerrados so ganham isTest.
// Nunca giveUp: giveUp avisa a loja. O unico pedido deles fora da UAU (Zero Grau) so entra
// com --incluir-zero-grau.
//
// O onPurchaseUpdate (mobile_old_web_platform) soma 1 em deniedRequestsCount no DailyStats
// de hoje a cada pedido que vira denied. Depois de gravar, o script desfaz so esse contador
// de hoje (e o de entregas, que nao deve mudar), com o delta medido.
const LOJA = 'q0IPIusmpEq3pHbMyfWY';
const CLIENTES_DA_EQUIPE = Object.freeze([
  '23du6YjtP7lOub6hj4D8',
  'qANp5omSHit5wUDPMYrv',
  'bUj9VV3ggbfkjjFexqaZ',
  'CMn5YtcadgqxGiBQssiw',
]);
// Unico pedido de equipe fora da UAU (cliente CMn5Yt na Zero Grau). Entra so com
// --incluir-zero-grau: ganha isTest, o status nao muda.
const PEDIDO_ZERO_GRAU = Object.freeze({
  id: 'UvWWom5R5VgLf8MyHb2t',
  loja: 'jQQjHTCc2zW1tuZMQzGF',
  cliente: 'CMn5YtcadgqxGiBQssiw',
});
const ENCERRADOS = new Set(['completed', 'denied', 'giveUp', 'canceled']);
const DENIED = 'PurchaseStatus.denied';
const MOTIVO = 'encerramento_de_teste';
const PEDIDOS_POR_LOTE = 10;
const CONTADORES = ['deniedRequestsCount', 'ordersDeliveredCount'];
const ESPERA_DO_GATILHO_MS = 120 * 1000;

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function usage() {
  return [
    'Uso:',
    '  node scripts/encerrarPedidosDeEquipe.js [--incluir-zero-grau] [--gravar --backup PASTA] [--project ID]',
    '',
    'Sem --gravar, so le: abertos, encerrados e soma de price na UAU Mart, e quantos pedidos',
    'os quatro clientes tem em cada outra loja (nas outras lojas nada e gravado).',
    `Com --incluir-zero-grau, o pedido ${PEDIDO_ZERO_GRAU.id} da Zero Grau tambem ganha isTest`,
    '(status sem mudanca), e a passada mostra o que muda no ResumoVendas e na contagem do mes.',
    'Com --gravar, salva o JSON de cada pedido em PASTA, grava em lotes numa transacao que so',
    'aplica se o status ainda for o lido, e compensa o DailyStats de hoje.',
  ].join('\n');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const status = (dados) => String(dados?.currentPurchaseStatus || '').replace(/^PurchaseStatus\./, '');
const millis = (valor) => (valor && typeof valor.toMillis === 'function' ? valor.toMillis() : null);
const lojaDoPedido = (dados) => dados?.companyReference?.path?.split('/')[1] || dados?.companyId || '(sem loja)';
const soma = (pedidos) => pedidos.reduce((total, pedido) => total + (Number(pedido.get('price')) || 0), 0);

// Maior createdAt do statusList, como no encerramento de 02/10.
function ultimaData(statusList) {
  return (Array.isArray(statusList) ? statusList : []).reduce((maior, entrada) => {
    const valor = millis(entrada?.createdAt);
    return valor != null && (maior == null || valor > millis(maior)) ? entrada.createdAt : maior;
  }, null);
}

// Dia do DailyStats no fuso de Sao Paulo, dd-mm-aaaa, como o CompanyStatsServices.
function diaDeHoje() {
  const texto = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  return texto.split('/').join('-');
}

function paraJson(valor) {
  if (valor instanceof admin.firestore.Timestamp) return { _timestamp: valor.toDate().toISOString() };
  if (valor instanceof admin.firestore.DocumentReference) return { _referencia: valor.path };
  if (valor instanceof admin.firestore.GeoPoint) return { _geopoint: [valor.latitude, valor.longitude] };
  if (Array.isArray(valor)) return valor.map(paraJson);
  if (valor && typeof valor === 'object') return Object.fromEntries(Object.entries(valor).map(([chave, item]) => [chave, paraJson(item)]));
  return valor;
}

async function contadoresDeHoje(ref) {
  const snapshot = await ref.get();
  return Object.fromEntries(CONTADORES.map((campo) => [campo, snapshot.exists ? Number(snapshot.get(campo)) || 0 : 0]));
}

// Motivo para nao gravar o pedido, ou null. `lido` e o pedido da leitura inicial.
function motivoParaPular(atual, lido) {
  if (!atual) return 'documento nao existe';
  if (atual.currentPurchaseStatus !== lido.get('currentPurchaseStatus')) return `status mudou para ${atual.currentPurchaseStatus}`;
  if (lojaDoPedido(atual) !== LOJA) return 'outra loja';
  if (!CLIENTES_DA_EQUIPE.includes(atual.clientId)) return 'outro cliente';
  return null;
}

// Confere que o cliente tem so este pedido na Zero Grau e mostra o que muda nos resumos do
// mes dele. Devolve o snapshot do pedido.
async function mostrarPedidoDaZeroGrau(db, todos) {
  const daZeroGrau = todos.filter((pedido) => lojaDoPedido(pedido.data()) === PEDIDO_ZERO_GRAU.loja
    && pedido.get('clientId') === PEDIDO_ZERO_GRAU.cliente);
  if (daZeroGrau.length !== 1 || daZeroGrau[0].id !== PEDIDO_ZERO_GRAU.id) {
    throw new Error(`esperado so o pedido ${PEDIDO_ZERO_GRAU.id} do cliente na Zero Grau; achados: ${daZeroGrau.map((pedido) => pedido.id).join(', ') || 'nenhum'}`);
  }
  const pedido = daZeroGrau[0];
  const dados = pedido.data();
  const criadoEm = dados.createdAt?.toDate?.();
  const mes = mesDoPedido(dados.createdAt);
  console.log(`\nZero Grau: pedido ${dados.orderNumber} (${pedido.id}) | status ${status(dados)} | price ${dados.price}`
    + ` | criado ${criadoEm ? criadoEm.toISOString() : '-'} | mes ${mes} | isTest ${dados.isTest === true}`);

  const loja = db.collection('estabelecimentos').doc(PEDIDO_ZERO_GRAU.loja);
  const [resumoMes, contagemGravada, contribuicao] = await Promise.all([
    loja.collection(RESUMO_PEDIDOS_COLLECTION).doc(mes).get(),
    loja.collection(CONTAGEM_COLLECTION).doc(mes).get(),
    loja.collection(CONTRIBUICOES_COLLECTION).doc(pedido.id).get(),
  ]);
  const pedidosDoMes = resumoMes.exists ? resumoMes.get('pedidos') || {} : {};
  const resumoDoPedido = pedidosDoMes[pedido.id];
  const antes = contagemDoMes(pedidosDoMes);
  const depois = contagemDoMes(resumoDoPedido ? { ...pedidosDoMes, [pedido.id]: { ...resumoDoPedido, isTest: true } } : pedidosDoMes);
  console.log(`${CONTAGEM_COLLECTION}/${mes}: pedido no ${RESUMO_PEDIDOS_COLLECTION}/${mes}? ${resumoDoPedido ? 'sim' : 'nao'}`);
  ['app', 'agent'].forEach((canal) => Object.keys(antes[canal]).forEach((grupo) => {
    const gravado = contagemGravada.exists ? Number(contagemGravada.get(`${canal}.${grupo}`)) || 0 : 0;
    if (antes[canal][grupo] !== depois[canal][grupo] || gravado !== antes[canal][grupo]) {
      console.log(`  ${canal}.${grupo}: gravado ${gravado} | recontado ${antes[canal][grupo]} | com isTest ${depois[canal][grupo]}`);
    }
  }));
  if (JSON.stringify(antes) === JSON.stringify(depois)) console.log('  contagem nao muda');
  const eraVenda = ehVenda(dados);
  console.log(`${RESUMO_VENDAS_COLLECTION}/${mes}: e venda hoje? ${eraVenda ? 'sim' : 'nao'} | contribuicao guardada? ${contribuicao.exists ? 'sim' : 'nao'}`
    + ` | ${eraVenda || contribuicao.exists ? `sai price ${contribuicao.get('price') ?? dados.price}` : 'nao muda'}`);
  return pedido;
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log(usage());
    return;
  }
  const gravar = process.argv.includes('--gravar');
  const pastaDeBackup = argument('backup');
  if (gravar && !pastaDeBackup) {
    console.error(usage());
    process.exitCode = 1;
    return;
  }
  const projectId = argument('project') || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  admin.initializeApp(projectId ? { projectId } : undefined);
  const db = admin.firestore();
  const { FieldValue } = admin.firestore;

  // Todos os pedidos dos quatro clientes, em qualquer loja; so os da UAU sao gravados.
  const todos = (await db.collection('PurchaseRequests').where('clientId', 'in', CLIENTES_DA_EQUIPE).get()).docs;
  const naLoja = todos.filter((pedido) => lojaDoPedido(pedido.data()) === LOJA);
  const abertos = naLoja.filter((pedido) => !ENCERRADOS.has(status(pedido.data())));
  const encerrados = naLoja.filter((pedido) => ENCERRADOS.has(status(pedido.data())));
  const encerradosSemTeste = encerrados.filter((pedido) => pedido.get('isTest') !== true);

  console.log(`UAU Mart (${LOJA}), clientes da equipe: ${CLIENTES_DA_EQUIPE.length}`);
  console.log(`abertos: ${abertos.length} | soma de price ${soma(abertos).toFixed(2)}`);
  console.log(`encerrados: ${encerrados.length} | soma de price ${soma(encerrados).toFixed(2)} | sem isTest ${encerradosSemTeste.length}`);
  const porStatus = new Map();
  naLoja.forEach((pedido) => porStatus.set(status(pedido.data()), (porStatus.get(status(pedido.data())) || 0) + 1));
  console.log('por status:', [...porStatus].sort().map(([nome, total]) => `${nome} ${total}`).join(', '));
  const semData = abertos.filter((pedido) => !ultimaData(pedido.get('statusList')));
  const comMotivo = abertos.filter((pedido) => pedido.get('motivoEncerramento') != null);
  console.log(`abertos sem data no statusList: ${semData.length} | abertos ja com motivoEncerramento: ${comMotivo.length}`);

  console.log('\nOutras lojas (so leitura) | cliente | pedidos');
  const outras = new Map();
  todos.filter((pedido) => lojaDoPedido(pedido.data()) !== LOJA).forEach((pedido) => {
    const chave = `${lojaDoPedido(pedido.data())} | ${pedido.get('clientId')}`;
    outras.set(chave, (outras.get(chave) || 0) + 1);
  });
  if (!outras.size) console.log('(nenhum pedido em outra loja)');
  [...outras].sort().forEach(([chave, total]) => console.log(`${chave} | ${total}`));

  const incluirZeroGrau = process.argv.includes('--incluir-zero-grau');
  let pedidoZeroGrau = null;
  if (incluirZeroGrau) {
    pedidoZeroGrau = await mostrarPedidoDaZeroGrau(db, todos);
  } else {
    console.log(`\nZero Grau: fora desta passada (use --incluir-zero-grau para o pedido ${PEDIDO_ZERO_GRAU.id}).`);
  }

  if (!gravar) {
    console.log('\nSimulacao: nada foi gravado. Use --gravar --backup PASTA para gravar.');
    return;
  }
  if (semData.length || comMotivo.length) throw new Error('ha abertos sem data no statusList ou ja com motivo; nada gravado');

  const pasta = path.resolve(pastaDeBackup);
  fs.mkdirSync(pasta, { recursive: true });
  const arquivo = path.join(pasta, `encerrarPedidosDeEquipe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(arquivo, JSON.stringify([...naLoja, ...(pedidoZeroGrau ? [pedidoZeroGrau] : [])].map((pedido) => ({
    id: pedido.id, updateTime: pedido.updateTime.toDate().toISOString(), dados: paraJson(pedido.data()),
  })), null, 2));
  console.log(`\nBackup de ${naLoja.length} pedidos em ${arquivo}`);

  const dia = diaDeHoje();
  const statsRef = db.collection('estabelecimentos').doc(LOJA).collection('DailyStats').doc(dia);
  const antes = await contadoresDeHoje(statsRef);
  console.log(`DailyStats ${dia} antes:`, JSON.stringify(antes));

  const alvos = [...abertos, ...encerradosSemTeste];
  const falhas = [];
  const negados = [];
  const marcados = [];
  for (let inicio = 0; inicio < alvos.length; inicio += PEDIDOS_POR_LOTE) {
    const lote = alvos.slice(inicio, inicio + PEDIDOS_POR_LOTE);
    try {
      const gravados = await db.runTransaction(async (transacao) => {
        const lidos = await transacao.getAll(...lote.map((pedido) => pedido.ref));
        const feitos = [];
        lidos.forEach((snapshot, indice) => {
          const lido = lote[indice];
          const atual = snapshot.exists ? snapshot.data() : null;
          const motivo = motivoParaPular(atual, lido);
          if (motivo) {
            falhas.push({ id: lido.id, numero: lido.get('orderNumber'), motivo });
            return;
          }
          if (ENCERRADOS.has(status(atual))) {
            transacao.update(snapshot.ref, { isTest: true });
            feitos.push({ id: lido.id, numero: atual.orderNumber, negado: false });
            return;
          }
          const statusList = Array.isArray(atual.statusList) ? atual.statusList : [];
          transacao.update(snapshot.ref, {
            isTest: true,
            currentPurchaseStatus: DENIED,
            statusList: [...statusList, { purchaseStatus: DENIED, createdAt: ultimaData(statusList) }],
            motivoEncerramento: MOTIVO,
            encerradoEm: FieldValue.serverTimestamp(),
          });
          feitos.push({ id: lido.id, numero: atual.orderNumber, negado: true });
        });
        return feitos;
      });
      gravados.forEach((feito) => (feito.negado ? negados : marcados).push(feito.numero));
      console.log(`lote ${inicio / PEDIDOS_POR_LOTE + 1}: ${gravados.map((feito) => feito.numero).join(' ') || '(nenhum)'}`);
    } catch (error) {
      lote.forEach((pedido) => falhas.push({ id: pedido.id, numero: pedido.get('orderNumber'), motivo: `lote falhou: ${error.message}` }));
    }
    if (inicio + PEDIDOS_POR_LOTE < alvos.length) await sleep(500);
  }
  if (pedidoZeroGrau) {
    const gravou = await db.runTransaction(async (transacao) => {
      const snapshot = await transacao.get(pedidoZeroGrau.ref);
      const atual = snapshot.exists ? snapshot.data() : null;
      let motivo = null;
      if (!atual) motivo = 'documento nao existe';
      else if (lojaDoPedido(atual) !== PEDIDO_ZERO_GRAU.loja) motivo = 'saiu da Zero Grau';
      else if (atual.clientId !== PEDIDO_ZERO_GRAU.cliente) motivo = 'outro cliente';
      else if (atual.currentPurchaseStatus !== pedidoZeroGrau.get('currentPurchaseStatus')) motivo = `status mudou para ${atual.currentPurchaseStatus}`;
      if (motivo) {
        falhas.push({ id: pedidoZeroGrau.id, numero: pedidoZeroGrau.get('orderNumber'), motivo });
        return false;
      }
      transacao.update(snapshot.ref, { isTest: true });
      return true;
    });
    if (gravou) marcados.push(pedidoZeroGrau.get('orderNumber'));
    console.log(`Zero Grau ${pedidoZeroGrau.get('orderNumber')}: ${gravou ? 'isTest gravado' : 'nao gravado'}`);
  }
  console.log(`\nnegados: ${negados.length} | so isTest: ${marcados.length} | falhas: ${falhas.length}`);
  falhas.forEach((falha) => console.log(`  ${falha.numero} ${falha.id}: ${falha.motivo}`));

  // Espera o onPurchaseUpdate somar os denied de hoje e desfaz o que ele somou.
  const inicioDaEspera = Date.now();
  let depois = await contadoresDeHoje(statsRef);
  while (depois.deniedRequestsCount - antes.deniedRequestsCount < negados.length && Date.now() - inicioDaEspera < ESPERA_DO_GATILHO_MS) {
    await sleep(5000);
    depois = await contadoresDeHoje(statsRef);
  }
  await sleep(10000);
  depois = await contadoresDeHoje(statsRef);
  const deltas = Object.fromEntries(CONTADORES.map((campo) => [campo, depois[campo] - antes[campo]]));
  const esperado = { deniedRequestsCount: negados.length, ordersDeliveredCount: 0 };
  console.log(`DailyStats ${dia} depois do gatilho:`, JSON.stringify(depois), '| deltas', JSON.stringify(deltas), '| esperado', JSON.stringify(esperado));
  if (CONTADORES.some((campo) => deltas[campo] !== esperado[campo])) {
    console.log('Delta diferente do esperado: compensacao NAO aplicada. Confira antes de compensar.');
    process.exitCode = 1;
    return;
  }
  const compensacao = Object.fromEntries(CONTADORES.filter((campo) => deltas[campo]).map((campo) => [campo, FieldValue.increment(-deltas[campo])]));
  if (Object.keys(compensacao).length) await statsRef.set(compensacao, { merge: true });
  console.log(`DailyStats ${dia} depois da compensacao:`, JSON.stringify(await contadoresDeHoje(statsRef)));
}

main().catch((error) => {
  console.error('[encerrarPedidosDeEquipe] Falha', error.message);
  process.exitCode = 1;
});
