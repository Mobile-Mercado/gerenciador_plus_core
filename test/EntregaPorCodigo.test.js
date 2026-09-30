import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { DeliveryByCodeUseCase, STATUS_DE_ENTREGA, STATUS_DE_ROTA } from '../src/application/delivery/DeliveryByCodeUseCase.js';
import { createDeliveryRoutes } from '../src/http/routes/deliveryRoutes.js';
import { errorHandler } from '../src/http/middlewares/errorHandler.js';

const AGORA = new Date('2026-09-30T18:00:00Z');

function pedido(extra = {}) {
  return {
    orderNumber: '1042',
    companyName: 'Super Zero Grau',
    clientName: 'Maria Aparecida da Silva',
    clientePhoneNumber: '62999990000',
    clientId: 'cliente-1',
    clientReference: { path: 'Users/cliente-1' },
    address: {
      fullAddress: 'Rua 10, 120 - Centro - Anapolis/GO',
      complement: 'Apto 201',
      reference: 'Portao azul',
      zipCode: '75000-000',
    },
    purchasePayment: { paymentType: 'Dinheiro', paymentValue: 100, valueBack: 25.5 },
    deliveryPerson: { name: 'Joao Entregador', email: 'joao@exemplo.com', phone: '62988887777' },
    productsCart: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    total: 74.5,
    currentPurchaseStatus: STATUS_DE_ROTA,
    statusList: [{ purchaseStatus: 'PurchaseStatus.pending', createdAt: AGORA }],
    deliveryCode: 'A7K2Z9',
    ...extra,
  };
}

// Firestore de mentira com consulta por deliveryCode e transacao.
function firestoreFalso(pedidos) {
  const documentos = new Map(Object.entries(pedidos));
  const snapshot = (id) => ({
    id,
    ref: { path: `PurchaseRequests/${id}`, get: async () => snapshot(id) },
    data: () => documentos.get(id),
    get: (campo) => documentos.get(id)[campo],
  });
  const consulta = (codigo, limite) => ({
    codigo,
    limite,
    async get() {
      const achados = [...documentos.keys()]
        .filter((id) => documentos.get(id).deliveryCode === codigo)
        .slice(0, limite)
        .map(snapshot);
      return { docs: achados, size: achados.length };
    },
  });
  return {
    documentos,
    collection: () => ({
      where: (_campo, _operador, codigo) => ({ limit: (limite) => consulta(codigo, limite) }),
    }),
    async runTransaction(tarefa) {
      const escritas = [];
      const resultado = await tarefa({
        get: (query) => query.get(),
        update: (ref, dados) => escritas.push({ ref, dados }),
      });
      escritas.forEach(({ ref, dados }) => {
        const id = ref.path.split('/')[1];
        // serverTimestamp e uma sentinela sem valor: o Firestore a troca pela hora dele no
        // commit, e o fake faz o mesmo para deliveredAt.
        const comHora = Object.fromEntries(Object.entries(dados).map(([campo, valor]) => (
          campo === 'deliveredAt' ? [campo, { toDate: () => AGORA }] : [campo, valor]
        )));
        documentos.set(id, { ...documentos.get(id), ...comHora });
      });
      return resultado;
    },
  };
}

function servidor(pedidos) {
  const firestore = firestoreFalso(pedidos);
  const app = express();
  app.use(express.json());
  app.use('/api/entrega', createDeliveryRoutes({
    deliveryByCodeUseCase: new DeliveryByCodeUseCase({ firestore, clock: () => AGORA }),
  }));
  app.use(errorHandler);
  return { app, firestore };
}

async function chamar(app, rota, corpo) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/entrega/${rota}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.0.0.${Math.ceil(Math.random() * 250)}` },
      body: JSON.stringify(corpo),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
  }
}

test('codigo valido com pedido em rota devolve so o que a tela do entregador precisa', async () => {
  const { app } = servidor({ p1: pedido() });

  const { status, body } = await chamar(app, 'resumo', { codigo: 'A7K2Z9' });

  assert.equal(status, 200);
  assert.deepEqual(body.data, {
    pedido: '1042',
    loja: 'Super Zero Grau',
    cliente: 'Maria',
    telefone: '62999990000',
    endereco: 'Rua 10, 120 - Centro - Anapolis/GO',
    complemento: 'Apto 201',
    referencia: 'Portao azul',
    itens: 3,
    total: 74.5,
    pagamento: 'Dinheiro',
    troco: 25.5,
    pagoOnline: false,
  });
  const texto = JSON.stringify(body);
  ['cliente-1', 'Aparecida', 'joao@exemplo.com', 'productsCart', 'deliveryCode', '75000-000'].forEach((proibido) => {
    assert.ok(!texto.includes(proibido), `vazou ${proibido}`);
  });
});

test('marcar entregue grava os cinco campos e nada mais', async () => {
  const { app, firestore } = servidor({ p1: pedido() });

  const { status, body } = await chamar(app, 'entregue', { codigo: 'A7K2Z9' });

  assert.equal(status, 200);
  assert.equal(body.data.status, 'entregue');
  assert.equal(body.data.marcadoPor, 'Joao Entregador');
  assert.equal(body.data.origem, 'entregador_link');

  const gravado = firestore.documentos.get('p1');
  assert.equal(gravado.currentPurchaseStatus, STATUS_DE_ENTREGA);
  assert.equal(gravado.deliveredBy, 'Joao Entregador');
  assert.equal(gravado.deliveredSource, 'entregador_link');
  assert.ok(gravado.deliveredAt, 'deliveredAt gravado');
  assert.equal(gravado.statusList.length, 2);
  assert.equal(gravado.statusList[1].purchaseStatus, STATUS_DE_ENTREGA);
  assert.ok(gravado.statusList[1].createdAt, 'a entrada nova tem createdAt');
  // nada fora da lista branca: o pedido mantem os mesmos campos de antes mais os tres novos
  const novos = Object.keys(gravado).filter((campo) => !Object.keys(pedido()).includes(campo));
  assert.deepEqual(novos.sort(), ['deliveredAt', 'deliveredBy', 'deliveredSource']);
});

test('pagoOnline sai do registro de transacao, nunca da forma de pagamento', async () => {
  const casos = [
    ['pix cobrado na maquininha, sem transacao', pedido({ purchasePayment: { paymentType: 'PaymentType.pix', paymentValue: 74.5 } }), false],
    ['pix com transacao pendente', pedido({ paymentStatus: 'pending', paymentTransactionId: 'tx-1' }), false],
    ['cartao esperando confirmacao do provedor', pedido({ paymentStatus: 'paidAwaitingConfirmation' }), false],
    ['pago, no campo do topo', pedido({ paymentStatus: 'paid' }), true],
    ['pago, dentro de purchasePayment', pedido({ purchasePayment: { paymentType: 'PaymentType.pix', paymentValue: 74.5, paymentStatus: 'paid' } }), true],
    ['pago, com maiuscula e espaco', pedido({ paymentStatus: ' Paid ' }), true],
  ];

  for (const [rotulo, documento, esperado] of casos) {
    const { app } = servidor({ p1: documento });
    const { body } = await chamar(app, 'resumo', { codigo: 'A7K2Z9' });
    assert.equal(body.data.pagoOnline, esperado, rotulo);
  }
});

test('a gravacao devolve a hora que o servidor gravou em deliveredAt', async () => {
  const { app, firestore } = servidor({ p1: pedido() });

  const { status, body } = await chamar(app, 'entregue', { codigo: 'A7K2Z9' });

  assert.equal(status, 200);
  assert.equal(body.data.deliveredAt, AGORA.toISOString());
  assert.ok(firestore.documentos.get('p1').deliveredAt, 'gravado no documento');
});

test('codigo valido com pedido ja entregue responde link invalido, sem dado', async () => {
  const { app } = servidor({ p1: pedido({ currentPurchaseStatus: STATUS_DE_ENTREGA }) });

  for (const rota of ['resumo', 'entregue']) {
    const { status, body } = await chamar(app, rota, { codigo: 'A7K2Z9' });
    assert.equal(status, 404);
    assert.equal(body.error.code, 'entrega_link_invalido');
    assert.equal(body.data, undefined);
    assert.ok(!JSON.stringify(body).includes('1042'));
  }
});

test('pedido em waitingForDelivery responde igual, porque ainda nao ha entregador', async () => {
  const { app } = servidor({ p1: pedido({ currentPurchaseStatus: 'PurchaseStatus.waitingForDelivery' }) });

  const { status, body } = await chamar(app, 'resumo', { codigo: 'A7K2Z9' });

  assert.equal(status, 404);
  assert.equal(body.error.code, 'entrega_link_invalido');
});

test('codigo inexistente responde a mesma coisa que pedido inexistente', async () => {
  const { app } = servidor({ p1: pedido() });

  const inexistente = await chamar(app, 'resumo', { codigo: 'ZZZZZZ' });
  const vazio = await chamar(servidor({}).app, 'resumo', { codigo: 'A7K2Z9' });

  assert.equal(inexistente.status, 404);
  assert.deepEqual(inexistente.body, vazio.body);
});

test('codigo de outra loja serve o pedido daquela loja: o codigo e a unica chave', async () => {
  const { app, firestore } = servidor({
    p1: pedido(),
    p2: pedido({ deliveryCode: 'B9M4Q7', companyName: 'UAU Mart', orderNumber: '77', clientName: 'Carlos Souza' }),
  });

  const { status, body } = await chamar(app, 'resumo', { codigo: 'B9M4Q7' });

  assert.equal(status, 200);
  assert.equal(body.data.loja, 'UAU Mart');
  assert.equal(body.data.pedido, '77');
  assert.equal(body.data.cliente, 'Carlos');
  assert.equal(firestore.documentos.get('p1').currentPurchaseStatus, STATUS_DE_ROTA);
});

test('o mesmo codigo em dois pedidos nao vale para nenhum', async () => {
  const { app } = servidor({ p1: pedido(), p2: pedido({ orderNumber: '77' }) });

  const { status, body } = await chamar(app, 'resumo', { codigo: 'A7K2Z9' });

  assert.equal(status, 404);
  assert.equal(body.error.code, 'entrega_link_invalido');
});

test('duas gravacoes seguidas com o mesmo codigo: so a primeira passa', async () => {
  const { app, firestore } = servidor({ p1: pedido() });

  const primeira = await chamar(app, 'entregue', { codigo: 'A7K2Z9' });
  const segunda = await chamar(app, 'entregue', { codigo: 'A7K2Z9' });

  assert.equal(primeira.status, 200);
  assert.equal(segunda.status, 404);
  assert.equal(segunda.body.error.code, 'entrega_link_invalido');
  assert.equal(firestore.documentos.get('p1').statusList.length, 2);
});

test('limite de tentativas por origem: 10 por minuto', async () => {
  const { app } = servidor({ p1: pedido() });
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const tentar = () => fetch(`http://127.0.0.1:${port}/api/entrega/resumo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '200.0.0.1' },
      body: JSON.stringify({ codigo: 'ZZZZZZ' }),
    });
    const respostas = [];
    for (let tentativa = 0; tentativa < 12; tentativa += 1) respostas.push((await tentar()).status);
    assert.equal(respostas.filter((status) => status === 404).length, 10);
    assert.equal(respostas.filter((status) => status === 429).length, 2);
  } finally {
    server.close();
  }
});
