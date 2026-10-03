const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DOCUMENTO_ABERTOS,
  RESUMO_PEDIDOS_VERSION,
  STATUS_ENCERRADOS,
  atualizarResumoDoPedido,
  mesDoPedido,
  pedidoAberto,
  resumirPedido,
} = require('./resumoPedidos');

// Timestamp de mentira, como o Firestore entrega.
const ts = (iso) => ({ toDate: () => new Date(iso) });
const ms = (iso) => new Date(iso).getTime();

test('mesDoPedido usa o fuso de Sao Paulo, inclusive na virada do mes', () => {
  assert.equal(mesDoPedido(ts('2026-10-01T01:00:00Z')), '2026-09');
  assert.equal(mesDoPedido(ts('2026-10-01T03:00:00Z')), '2026-10');
  assert.equal(mesDoPedido('2026-01-01T02:59:59Z'), '2025-12');
  assert.equal(mesDoPedido(ms('2026-07-15T12:00:00Z')), '2026-07');
});

test('mesDoPedido sem data vira sem-data', () => {
  assert.equal(mesDoPedido(null), 'sem-data');
  assert.equal(mesDoPedido(undefined), 'sem-data');
  assert.equal(mesDoPedido('nao e data'), 'sem-data');
});

test('pedidoAberto: os 8 status encerrados fecham, pending, accepted e deliveryRoute ficam abertos', () => {
  const encerrados = ['completed', 'delivered', 'denied', 'giveUp', 'return', 'canceled', 'cancelled', 'cancelado'];
  assert.deepEqual([...STATUS_ENCERRADOS].sort(), [...encerrados].sort());
  encerrados.forEach((status) => {
    assert.equal(pedidoAberto(status), false, status);
    assert.equal(pedidoAberto(`PurchaseStatus.${status}`), false, `PurchaseStatus.${status}`);
  });
  ['pending', 'accepted', 'deliveryRoute'].forEach((status) => {
    assert.equal(pedidoAberto(`PurchaseStatus.${status}`), true, status);
  });
});

// Valores esperados tirados das regras do mapOrder do painel, caso a caso.
test('resumirPedido: endereco em objeto, total direto, canal app', () => {
  const resumo = resumirPedido('p1', {
    orderNumber: '000123',
    clientId: 'cli1',
    clientName: 'Ana',
    currentPurchaseStatus: 'PurchaseStatus.accepted',
    createdAt: ts('2026-09-10T12:00:00Z'),
    statusList: [
      { purchaseStatus: 'PurchaseStatus.pending', createdAt: ts('2026-09-10T12:00:00Z') },
      { purchaseStatus: 'PurchaseStatus.accepted', createdAt: ts('2026-09-10T12:05:00Z') },
    ],
    address: {
      street: 'Avenida Brasil, N 10',
      number: '',
      neighborhood: 'Centro',
      city: 'Mozarlândia',
      uf: 'GO',
      zipCode: '76700-000',
      fullAddress: 'Avenida Brasil, Avenida Brasil, N 10, Centro',
    },
    total: 50.5,
    productsCart: [{ price: 1 }, { price: 2 }],
    deliveryPerson: { name: ' João ' },
    purchasePayment: { mode: 'pix', paymentStatus: 'paid' },
  });
  assert.deepEqual(resumo, {
    id: 'p1',
    clientId: 'cli1',
    clientName: 'Ana',
    orderNumber: '#000123',
    status: 'accepted',
    createdAt: ms('2026-09-10T12:00:00Z'),
    acceptedAt: ms('2026-09-10T12:05:00Z'),
    statusChangedAt: ms('2026-09-10T12:05:00Z'),
    address: 'Avenida Brasil, N 10 · Centro',
    addressSearch: 'Avenida Brasil, Avenida Brasil, N 10, Centro Avenida Brasil, N 10 · Centro Mozarlândia, GO, CEP 76700-000',
    shortAddress: 'Av. Brasil, 10 · Centro',
    neighborhood: 'Centro',
    deliveryPerson: 'João',
    total: 50.5,
    productsCount: 2,
    channel: 'app',
    isTest: false,
    isTestAccount: false,
    paymentMode: 'pix',
    paymentStatus: 'paid',
    selo: 'comum',
  });
});

test('resumirPedido: endereco em texto, total somado de productsCart, pedido do agente, recorrente', () => {
  const resumo = resumirPedido('abcdefghXYZ123', {
    clientReference: { id: 'cli2', path: 'Users/cli2' },
    customerName: 'Bia',
    status: 'pending',
    createdAt: '2026-10-01T01:00:00Z',
    address: ' Rua das Flores 99 ',
    productsCart: [{ quantity: 2, price: '3,50' }, { totalPrice: 10 }, { product: { price: 4 } }],
    origin: 'WhatsApp',
    clientOrderCount: 3,
  });
  assert.equal(resumo.status, 'pending');
  assert.equal(resumo.clientId, 'cli2');
  assert.equal(resumo.clientName, 'Bia');
  assert.equal(resumo.orderNumber, '#XYZ123');
  assert.equal(resumo.address, 'Rua das Flores 99');
  assert.equal(resumo.addressSearch, 'Rua das Flores 99');
  assert.equal(resumo.shortAddress, 'Rua das Flores 99');
  assert.equal(resumo.neighborhood, '');
  assert.equal(resumo.total, 21);
  assert.equal(resumo.productsCount, 3);
  assert.equal(resumo.channel, 'agent');
  assert.equal(resumo.selo, 'recorrente');
  assert.equal(resumo.createdAt, ms('2026-10-01T01:00:00Z'));
  assert.equal(resumo.acceptedAt, resumo.createdAt, 'sem aceite, conta da criacao');
  assert.equal(resumo.statusChangedAt, resumo.createdAt, 'sem statusList, conta da criacao');
  assert.equal(resumo.deliveryPerson, '');
  assert.equal(resumo.paymentMode, '');
});

test('resumirPedido: pedido de teste, sem data, sem cliente e sem endereco montavel', () => {
  const resumo = resumirPedido('p3', {
    isTestAccount: true,
    vip: true,
    agentOrder: true,
    deliveryAddress: { fullAddress: 'Rua X, 1' },
  });
  assert.equal(resumo.status, 'indefinido');
  assert.equal(resumo.clientId, '');
  assert.equal(resumo.clientName, 'Cliente não identificado');
  assert.equal(resumo.orderNumber, '#P3');
  assert.equal(resumo.createdAt, null);
  assert.equal(resumo.acceptedAt, null);
  assert.equal(resumo.statusChangedAt, null);
  assert.equal(resumo.address, 'Rua X, 1');
  assert.equal(resumo.addressSearch, 'Rua X, 1 Rua X, 1');
  assert.equal(resumo.shortAddress, 'Rua X, 1');
  assert.equal(resumo.total, 0);
  assert.equal(resumo.productsCount, 0);
  assert.equal(resumo.channel, 'agent');
  assert.equal(resumo.isTest, true);
  assert.equal(resumo.isTestAccount, true);
  assert.equal(resumo.selo, 'vip');
  assert.ok(Object.values(resumo).every((valor) => valor !== undefined));
});

test('resumirPedido: sem endereco nenhum mostra a frase do painel', () => {
  assert.equal(resumirPedido('p4', {}).address, 'Endereço não informado');
  assert.equal(resumirPedido('p4', { isTest: true }).isTest, true);
});

// ----- atualizarResumoDoPedido com Firestore de mentira -----

const DELETE = { delete: true };
const FieldValue = {
  delete: () => DELETE,
  increment: (n) => ({ increment: n }),
  serverTimestamp: () => ({ serverTimestamp: true }),
};

// Guarda os documentos de ResumoPedidos por caminho e aplica o merge do mapa pedidos
// como o Firestore faz. Gravacao em Stats (o marcador) fica em registro.marcas.
function firestoreFalso(inicial = {}) {
  const registro = { docs: JSON.parse(JSON.stringify(inicial)), marcas: [], gravacoes: 0 };
  const loja = (lojaId) => ({
    collection: (colecao) => ({
      doc: (id) => ({
        async set(dados, opcoes) {
          const caminho = `${lojaId}/${colecao}/${id}`;
          if (colecao === 'Stats') { registro.marcas.push({ caminho, dados }); return; }
          assert.deepEqual(opcoes, { merge: true });
          registro.gravacoes += 1;
          const atual = registro.docs[caminho] || { pedidos: {} };
          const pedidos = { ...atual.pedidos };
          Object.entries(dados.pedidos || {}).forEach(([pedidoId, valor]) => {
            if (valor === DELETE) delete pedidos[pedidoId];
            else pedidos[pedidoId] = valor;
          });
          registro.docs[caminho] = { ...atual, ...dados, pedidos };
        },
      }),
    }),
  });
  return { db: { collection: () => ({ doc: loja }) }, registro };
}

const pedido = (extra = {}) => ({
  companyId: 'loja-1',
  orderNumber: '000500',
  currentPurchaseStatus: 'PurchaseStatus.accepted',
  createdAt: ts('2026-09-20T15:00:00Z'),
  total: 30,
  ...extra,
});
const ids = (registro, caminho) => Object.keys(registro.docs[caminho]?.pedidos || {});

test('pedido aberto entra no mes e em abertos, e soma listaDePedidos no marcador', async () => {
  const { db, registro } = firestoreFalso();
  const resultado = await atualizarResumoDoPedido({ db, FieldValue, antes: null, depois: pedido(), pedidoId: 'p1' });
  assert.deepEqual(resultado, { acao: 'gravou', lojas: ['loja-1'] });
  assert.deepEqual(ids(registro, 'loja-1/ResumoPedidos/2026-09'), ['p1']);
  assert.deepEqual(ids(registro, `loja-1/ResumoPedidos/${DOCUMENTO_ABERTOS}`), ['p1']);
  assert.equal(registro.docs['loja-1/ResumoPedidos/2026-09'].versaoResumo, RESUMO_PEDIDOS_VERSION);
  assert.deepEqual(registro.marcas.map((m) => [m.caminho, Object.keys(m.dados).sort()]), [
    ['loja-1/Stats/marcador', ['listaDePedidos', 'listaDePedidosEm', 'versaoMarcador']],
  ]);
});

test('pedido encerrado sai de abertos e continua no mes', async () => {
  const { db, registro } = firestoreFalso();
  await atualizarResumoDoPedido({ db, FieldValue, antes: null, depois: pedido(), pedidoId: 'p1' });
  await atualizarResumoDoPedido({
    db, FieldValue, antes: pedido(), depois: pedido({ currentPurchaseStatus: 'PurchaseStatus.completed' }), pedidoId: 'p1',
  });
  assert.deepEqual(ids(registro, 'loja-1/ResumoPedidos/2026-09'), ['p1']);
  assert.equal(registro.docs['loja-1/ResumoPedidos/2026-09'].pedidos.p1.status, 'completed');
  assert.deepEqual(ids(registro, `loja-1/ResumoPedidos/${DOCUMENTO_ABERTOS}`), []);
});

test('pedido que ja estava encerrado nao grava em abertos', async () => {
  const { db, registro } = firestoreFalso();
  const encerrado = pedido({ currentPurchaseStatus: 'PurchaseStatus.completed' });
  await atualizarResumoDoPedido({ db, FieldValue, antes: encerrado, depois: { ...encerrado, isTest: true }, pedidoId: 'p1' });
  assert.equal(registro.docs[`loja-1/ResumoPedidos/${DOCUMENTO_ABERTOS}`], undefined);
  assert.equal(registro.docs['loja-1/ResumoPedidos/2026-09'].pedidos.p1.isTest, true);
});

test('pedido apagado sai do mes e de abertos', async () => {
  const { db, registro } = firestoreFalso();
  await atualizarResumoDoPedido({ db, FieldValue, antes: null, depois: pedido(), pedidoId: 'p1' });
  const resultado = await atualizarResumoDoPedido({ db, FieldValue, antes: pedido(), depois: null, pedidoId: 'p1' });
  assert.deepEqual(resultado, { acao: 'removeu', lojas: ['loja-1'] });
  assert.deepEqual(ids(registro, 'loja-1/ResumoPedidos/2026-09'), []);
  assert.deepEqual(ids(registro, `loja-1/ResumoPedidos/${DOCUMENTO_ABERTOS}`), []);
});

test('troca de loja limpa a loja antiga e marca as duas', async () => {
  const { db, registro } = firestoreFalso();
  await atualizarResumoDoPedido({ db, FieldValue, antes: null, depois: pedido(), pedidoId: 'p1' });
  registro.marcas = [];
  const resultado = await atualizarResumoDoPedido({
    db, FieldValue, antes: pedido(), depois: pedido({ companyId: 'loja-2' }), pedidoId: 'p1',
  });
  assert.deepEqual(resultado.lojas.sort(), ['loja-1', 'loja-2']);
  assert.deepEqual(ids(registro, 'loja-1/ResumoPedidos/2026-09'), []);
  assert.deepEqual(ids(registro, `loja-1/ResumoPedidos/${DOCUMENTO_ABERTOS}`), []);
  assert.deepEqual(ids(registro, 'loja-2/ResumoPedidos/2026-09'), ['p1']);
  assert.deepEqual(ids(registro, `loja-2/ResumoPedidos/${DOCUMENTO_ABERTOS}`), ['p1']);
  assert.deepEqual(registro.marcas.map((m) => m.caminho).sort(), ['loja-1/Stats/marcador', 'loja-2/Stats/marcador']);
});

test('troca do mes de criacao tira o pedido do mes antigo', async () => {
  const { db, registro } = firestoreFalso();
  await atualizarResumoDoPedido({ db, FieldValue, antes: null, depois: pedido(), pedidoId: 'p1' });
  await atualizarResumoDoPedido({
    db, FieldValue, antes: pedido(), depois: pedido({ createdAt: ts('2026-10-05T15:00:00Z') }), pedidoId: 'p1',
  });
  assert.deepEqual(ids(registro, 'loja-1/ResumoPedidos/2026-09'), []);
  assert.deepEqual(ids(registro, 'loja-1/ResumoPedidos/2026-10'), ['p1']);
});

test('mudanca fora do resumo nao grava nada nem marca', async () => {
  const { db, registro } = firestoreFalso();
  const resultado = await atualizarResumoDoPedido({
    db, FieldValue, antes: pedido(), depois: pedido({ conferenciaEntrega: { ultimaResposta: 'a_caminho' } }), pedidoId: 'p1',
  });
  assert.deepEqual(resultado, { acao: 'nada', lojas: [] });
  assert.equal(registro.gravacoes, 0);
  assert.equal(registro.marcas.length, 0);
});

test('pedido sem loja nao grava nada', async () => {
  const { db, registro } = firestoreFalso();
  const resultado = await atualizarResumoDoPedido({
    db, FieldValue, antes: null, depois: pedido({ companyId: undefined }), pedidoId: 'p1',
  });
  assert.deepEqual(resultado, { acao: 'nada', lojas: [] });
  assert.equal(registro.gravacoes, 0);
});

test('lojaDe do gatilho prevalece sobre a regra padrao', async () => {
  const { db, registro } = firestoreFalso();
  await atualizarResumoDoPedido({
    db, FieldValue, antes: null, depois: pedido({ companyId: undefined, companyReference: { id: 'loja-9' } }), pedidoId: 'p1',
    lojaDe: (dados) => dados.companyReference?.id || null,
  });
  assert.deepEqual(ids(registro, 'loja-9/ResumoPedidos/2026-09'), ['p1']);
});
