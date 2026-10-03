const test = require('node:test');
const assert = require('node:assert/strict');
const {
  STATUS_DESISTENCIA,
  TAMANHO_DO_TRECHO,
  avisoDeMensagem,
  avisoDePedidoCancelado,
  avisoDePedidoNovo,
  trechoDaMensagem,
} = require('./avisos');

const LOJA = 'loja-1';
// Chat aberto pelo cliente: o cliente em senderId, a loja em receiverId.
const chatDoCliente = { senderId: 'cliente-1', senderName: 'Maria Souza', receiverId: LOJA, receiverName: '' };
// Chat aberto pela loja: a loja em senderId, o cliente em receiverId.
const chatDaLoja = { senderId: LOJA, senderName: 'Super Loja', receiverId: 'cliente-1', receiverName: 'Maria Souza' };

test('mensagem do cliente avisa a loja, com nome, trecho, url e tag do chat', () => {
  const aviso = avisoDeMensagem({
    chat: chatDoCliente, mensagem: { senderId: 'cliente-1', mensage: 'Tem pão de queijo?' }, chatId: 'c1', lojaId: LOJA,
  });
  assert.deepEqual(aviso, {
    title: 'Mensagem nova',
    body: 'Maria Souza: Tem pão de queijo?',
    url: '/mensagens',
    tag: 'chat-c1',
    data: { chatId: 'c1' },
  });
});

test('o nome do cliente vem da ponta do chat que nao e a loja', () => {
  const aviso = avisoDeMensagem({
    chat: chatDaLoja, mensagem: { senderId: 'cliente-1', mensage: 'Oi' }, chatId: 'c2', lojaId: LOJA,
  });
  assert.equal(aviso.body, 'Maria Souza: Oi');
});

test('mensagem da loja nao avisa, por id ou por referencia', () => {
  assert.equal(avisoDeMensagem({ chat: chatDaLoja, mensagem: { senderId: LOJA, mensage: 'Ola' }, chatId: 'c1', lojaId: LOJA }), null);
  assert.equal(avisoDeMensagem({
    chat: chatDaLoja, mensagem: { senderId: { id: LOJA, path: `estabelecimentos/${LOJA}` }, mensage: 'Ola' }, chatId: 'c1', lojaId: LOJA,
  }), null);
  assert.equal(avisoDeMensagem({
    chat: chatDaLoja, mensagem: { senderId: 'loja-2', mensage: 'Ola' }, chatId: 'c1', lojaId: LOJA, lojasDoChat: [LOJA, 'loja-2'],
  }), null, 'mensagem de outra loja do mesmo chat tambem nao avisa');
  assert.equal(avisoDeMensagem({ chat: chatDaLoja, mensagem: { mensage: 'sem remetente' }, chatId: 'c1', lojaId: LOJA }), null);
});

test('texto longo e cortado em ate 80 caracteres', () => {
  const longo = 'a'.repeat(200);
  assert.equal(trechoDaMensagem(longo).length, TAMANHO_DO_TRECHO);
  assert.ok(trechoDaMensagem(longo).endsWith('…'));
  const exato = 'b'.repeat(80);
  assert.equal(trechoDaMensagem(exato), exato, '80 caracteres cabem inteiros');
  const aviso = avisoDeMensagem({ chat: chatDoCliente, mensagem: { senderId: 'cliente-1', mensage: longo }, chatId: 'c1', lojaId: LOJA });
  assert.equal(aviso.body, `Maria Souza: ${'a'.repeat(79)}…`);
});

test('mensagem sem texto, como imagem, avisa que o cliente enviou uma mensagem', () => {
  const aviso = avisoDeMensagem({
    chat: chatDoCliente, mensagem: { senderId: 'cliente-1', mensage: '', filesUrls: ['https://x/foto.jpg'] }, chatId: 'c1', lojaId: LOJA,
  });
  assert.equal(aviso.body, 'Maria Souza enviou uma mensagem');
  const soEspaco = avisoDeMensagem({ chat: chatDoCliente, mensagem: { senderId: 'cliente-1', mensage: '   ' }, chatId: 'c1', lojaId: LOJA });
  assert.equal(soEspaco.body, 'Maria Souza enviou uma mensagem');
});

test('mensagem com HTML sai limpa e cliente sem nome vira Cliente', () => {
  const aviso = avisoDeMensagem({
    chat: { senderId: 'cliente-1', receiverId: LOJA }, mensagem: { senderId: 'cliente-1', message: '<b>oi</b>' }, chatId: 'c1', lojaId: LOJA,
  });
  assert.equal(aviso.body, 'Cliente: oi');
});

const pedido = (status, extra = {}) => ({
  currentPurchaseStatus: `PurchaseStatus.${status}`, orderNumber: '000321', clientName: 'Joana', ...extra,
});

test('troca para a desistencia do cliente avisa', () => {
  assert.equal(STATUS_DESISTENCIA, 'giveUp');
  const aviso = avisoDePedidoCancelado({ antes: pedido('accepted'), depois: pedido('giveUp'), pedidoId: 'pid1' });
  assert.deepEqual(aviso, {
    title: 'Pedido cancelado pelo cliente',
    body: 'Pedido #000321 de Joana',
    url: '/pedidos',
    tag: 'pid1',
    data: { orderId: 'pid1', orderNumber: '000321', clientName: 'Joana' },
  });
});

test('desistencia sem o prefixo PurchaseStatus tambem avisa', () => {
  const aviso = avisoDePedidoCancelado({
    antes: { currentPurchaseStatus: 'pending' }, depois: { currentPurchaseStatus: 'giveUp', clientName: 'Joana' }, pedidoId: 'abcdef123456',
  });
  assert.equal(aviso.body, 'Pedido #123456 de Joana', 'sem orderNumber, usa o fim do id como o painel');
});

test('desistencia que ja era desistencia nao avisa', () => {
  assert.equal(avisoDePedidoCancelado({ antes: pedido('giveUp'), depois: pedido('giveUp', { isTest: true }), pedidoId: 'p' }), null);
  assert.equal(avisoDePedidoCancelado({ antes: { currentPurchaseStatus: 'giveUp' }, depois: pedido('giveUp'), pedidoId: 'p' }), null);
});

test('outras trocas de status nao avisam', () => {
  const trocas = [
    ['pending', 'accepted'], ['accepted', 'deliveryRoute'], ['deliveryRoute', 'completed'],
    ['pending', 'denied'], ['accepted', 'canceled'], ['giveUp', 'accepted'],
  ];
  trocas.forEach(([de, para]) => {
    assert.equal(avisoDePedidoCancelado({ antes: pedido(de), depois: pedido(para), pedidoId: 'p' }), null, `${de} -> ${para}`);
  });
});

// Mesmas regras que sendOrderNotification usava antes de ser extraido.
test('titulo e texto do pedido novo iguais aos de hoje', () => {
  assert.deepEqual(avisoDePedidoNovo({ orderNumber: '000123', clientName: 'Ana' }), {
    title: '🔔 Novo Pedido!', body: 'Pedido #000123 de Ana', orderNumber: '000123', clientName: 'Ana',
  });
  assert.deepEqual(avisoDePedidoNovo({}), {
    title: '🔔 Novo Pedido!', body: 'Pedido  de Cliente', orderNumber: '', clientName: 'Cliente',
  });
  assert.equal(avisoDePedidoNovo({ orderNumber: 77, clientName: 'Bia' }).body, 'Pedido #77 de Bia');
  assert.deepEqual(
    avisoDePedidoNovo({ notificationTitle: 'Titulo <i>proprio</i>', notificationBody: 'Texto & proprio', clientName: 'Ana' }),
    { title: 'Titulo proprio', body: 'Texto  proprio', orderNumber: '', clientName: 'Ana' },
  );
  assert.equal(avisoDePedidoNovo({ orderNumber: '1'.repeat(30), clientName: 'Ana' }).orderNumber.length, 20);
});
