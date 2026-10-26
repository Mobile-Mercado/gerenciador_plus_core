const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  COLECAO_DE_AVISOS_DO_PEDIDO,
  MARCA_DE_PEDIDO_NOVO,
  avisaPedidoNovoNaAtualizacao,
  avisaPedidoNovoNaCriacao,
  avisarPedidoNovoUmaVez,
  reservarAvisoDePedidoNovo,
} = require('./avisos');

// FieldValue de mentira: devolve marcas legiveis no lugar dos sentinelas do Firestore.
const FieldValue = { serverTimestamp: () => ({ serverTimestamp: true }) };

// Firestore de mentira: create() falha com ALREADY_EXISTS (codigo 6) quando o caminho ja existe,
// como no Admin SDK. Registra cada documento criado.
function firestoreFalso({ existentes = [], erro = null } = {}) {
  const documentos = new Map(existentes.map((caminho) => [caminho, {}]));
  const criados = [];
  const referencia = (partes) => ({
    collection: (nome) => ({ doc: (id) => referencia([...partes, nome, id]) }),
    async create(dados) {
      if (erro) throw erro;
      const caminho = partes.join('/');
      if (documentos.has(caminho)) {
        const falha = new Error('6 ALREADY_EXISTS: Document already exists');
        falha.code = 6;
        throw falha;
      }
      documentos.set(caminho, dados);
      criados.push({ caminho, dados });
    },
  });
  return { db: { collection: (nome) => ({ doc: (id) => referencia([nome, id]) }) }, criados };
}

function envioFalso() {
  const enviados = [];
  return { enviados, enviar: async (aviso) => { enviados.push(aviso); return { totalSuccess: 1, totalFailures: 0 }; } };
}

const pedido = (status, extra = {}) => ({ currentPurchaseStatus: status, orderNumber: '000123', clientName: 'Ana', ...extra });
const MARCA = `PurchaseRequests/p1/${COLECAO_DE_AVISOS_DO_PEDIDO}/${MARCA_DE_PEDIDO_NOVO}`;

test('4.1: pedido criado esperando o pagamento pelo app nao avisa; os outros status avisam como hoje', () => {
  assert.equal(avisaPedidoNovoNaCriacao(pedido('PurchaseStatus.waitingForOrderPayment')), false);
  assert.equal(avisaPedidoNovoNaCriacao(pedido('waitingForOrderPayment')), false, 'sem o prefixo tambem');
  ['PurchaseStatus.pending', 'pending', 'PurchaseStatus.awaitingPayment', 'PurchaseStatus.accepted', '', undefined]
    .forEach((status) => assert.equal(avisaPedidoNovoNaCriacao(pedido(status)), true, String(status)));
  assert.equal(avisaPedidoNovoNaCriacao({}), true, 'pedido sem status continua avisando');
  assert.equal(avisaPedidoNovoNaCriacao(), true);
});

test('4.1: na atualizacao, avisa so na troca de waitingForOrderPayment para pending', () => {
  assert.equal(avisaPedidoNovoNaAtualizacao({
    antes: pedido('PurchaseStatus.waitingForOrderPayment'), depois: pedido('PurchaseStatus.pending'),
  }), true);
  assert.equal(avisaPedidoNovoNaAtualizacao({
    antes: pedido('waitingForOrderPayment'), depois: pedido('pending'),
  }), true, 'sem o prefixo tambem');
  const trocas = [
    ['waitingForOrderPayment', 'waitingForOrderPayment'], ['waitingForOrderPayment', 'giveUp'],
    ['waitingForOrderPayment', 'canceled'], ['waitingForOrderPayment', 'accepted'],
    ['pending', 'pending'], ['pending', 'accepted'], ['awaitingPayment', 'pending'], ['', 'pending'],
  ];
  trocas.forEach(([de, para]) => {
    assert.equal(avisaPedidoNovoNaAtualizacao({
      antes: pedido(`PurchaseStatus.${de}`), depois: pedido(`PurchaseStatus.${para}`),
    }), false, `${de} -> ${para}`);
  });
  assert.equal(avisaPedidoNovoNaAtualizacao(), false);
});

test('4.1: a reserva cria a marca na subcolecao do pedido uma vez; a segunda devolve false', async () => {
  const { db, criados } = firestoreFalso();
  assert.equal(await reservarAvisoDePedidoNovo({ db, FieldValue, pedidoId: 'p1', origem: 'sendOrderNotification' }), true);
  assert.equal(await reservarAvisoDePedidoNovo({ db, FieldValue, pedidoId: 'p1', origem: 'avisarPedidoPagoPeloApp' }), false);
  assert.deepEqual(criados, [{
    caminho: MARCA,
    dados: { avisadoEm: { serverTimestamp: true }, origem: 'sendOrderNotification' },
  }]);
});

test('4.1: erro na reserva que nao seja ALREADY_EXISTS sobe; o codigo already-exists tambem conta', async () => {
  const outro = Object.assign(new Error('indisponivel'), { code: 14 });
  await assert.rejects(
    reservarAvisoDePedidoNovo({ db: firestoreFalso({ erro: outro }).db, FieldValue, pedidoId: 'p1', origem: 'x' }),
    /indisponivel/,
  );
  const jaExiste = Object.assign(new Error('existe'), { code: 'already-exists' });
  assert.equal(await reservarAvisoDePedidoNovo({ db: firestoreFalso({ erro: jaExiste }).db, FieldValue, pedidoId: 'p1', origem: 'x' }), false);
});

test('4.1: avisa uma vez so por pedido, com o mesmo titulo e texto de hoje', async () => {
  const { db } = firestoreFalso();
  const { enviados, enviar } = envioFalso();
  const comum = { db, FieldValue, order: pedido('PurchaseStatus.pending'), pedidoId: 'p1', companyId: 'loja-1', enviar };
  await avisarPedidoNovoUmaVez({ ...comum, origem: 'avisarPedidoPagoPeloApp' });
  // Evento repetido e o outro gatilho: nenhum dos dois manda de novo.
  assert.equal(await avisarPedidoNovoUmaVez({ ...comum, origem: 'avisarPedidoPagoPeloApp' }), null);
  assert.equal(await avisarPedidoNovoUmaVez({ ...comum, origem: 'sendOrderNotification' }), null);
  assert.deepEqual(enviados, [{
    companyId: 'loja-1',
    title: '🔔 Novo Pedido!',
    body: 'Pedido #000123 de Ana',
    url: '/pedidos',
    tag: 'p1',
    data: { orderId: 'p1', orderNumber: '000123', clientName: 'Ana' },
    origem: 'avisarPedidoPagoPeloApp',
  }]);
});

test('4.1: pedido ja avisado antes (marca existente) nao avisa', async () => {
  const { db } = firestoreFalso({ existentes: [MARCA] });
  const { enviados, enviar } = envioFalso();
  await avisarPedidoNovoUmaVez({ db, FieldValue, order: pedido('pending'), pedidoId: 'p1', companyId: 'loja-1', enviar, origem: 'x' });
  assert.deepEqual(enviados, []);
});

test('4.1 index.js: sendOrderNotification pula o pedido esperando pagamento e o gatilho novo avisa na confirmacao', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const criacao = index.slice(index.indexOf('exports.sendOrderNotification = onDocumentCreated('), index.indexOf('exports.avisarPedidoPagoPeloApp'));
  assert.match(criacao, /'PurchaseRequests\/\{orderId\}'/);
  assert.ok(criacao.includes('if (!avisaPedidoNovoNaCriacao(order))'));
  assert.ok(criacao.includes('avisarPedidoNovoUmaVez({'));
  assert.ok(!criacao.includes('enviarAvisoParaLoja({'), 'o envio passa pela reserva');
  assert.match(index, /exports\.avisarPedidoPagoPeloApp = onDocumentUpdated\(\s+'PurchaseRequests\/\{orderId\}'/);
  const pago = index.slice(index.indexOf('exports.avisarPedidoPagoPeloApp'), index.indexOf('exports.avisarMensagemNova'));
  assert.ok(pago.includes('avisaPedidoNovoNaAtualizacao({ antes, depois })'));
  assert.ok(pago.includes('avisarPedidoNovoUmaVez({'));
});
