import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { DeliveryByCodeUseCase, STATUS_DE_ENTREGA, STATUS_DE_ROTA } from '../src/application/delivery/DeliveryByCodeUseCase.js';
import { createDeliveryRoutes } from '../src/http/routes/deliveryRoutes.js';
import { errorHandler } from '../src/http/middlewares/errorHandler.js';

const AGORA = new Date('2026-09-30T18:00:00Z');

// Gateway em producao prova pagamento; em homologacao, nao. Loja sem gateway cai fora
// pelo mode do pedido.
const LOJAS = {
  'loja-prod': { name: 'Super Zero Grau', paymentGateway: { provider: 'safrapay', enabled: true, safrapay: { environment: 'prod' } } },
  'loja-hml': { paymentGateway: { provider: 'safrapay', enabled: true, safrapay: { environment: 'hml' } } },
  'loja-sem-ambiente': { paymentGateway: { provider: 'safrapay', enabled: true } },
  'loja-sem-gateway': { name: 'Sem gateway' },
};

const refLoja = (id) => ({
  path: `estabelecimentos/${id}`,
  id,
  get: async () => ({ data: () => LOJAS[id] || null }),
});

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
    companyReference: refLoja('loja-prod'),
    ...extra,
  };
}

// Firestore de mentira: pedidos e lojas, com consulta por deliveryCode e transacao.
function firestoreFalso(pedidos) {
  const documentos = new Map(Object.entries(pedidos));
  const lojaDe = (referencia) => ({ data: () => LOJAS[referencia?.id] || null });
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
        get: (alvo) => (alvo && alvo.get ? alvo.get() : lojaDe(alvo)),
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
    // Este pedido de teste nao tem street: cai no fullAddress, como a regra manda.
    enderecoPartes: {
      ruaNumeroComplemento: 'Rua 10, 120 - Centro - Anapolis/GO',
      bairro: null,
      referencia: 'Portao azul',
      origem: 'fullAddress',
    },
    coordenada: null,
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
  const pagamento = (extra) => ({ paymentType: 'PaymentType.pix', paymentValue: 74.5, ...extra });
  const casos = [
    ['pix pago', pedido({ purchasePayment: pagamento({ mode: 'online', paymentStatus: 'paid' }) }), true],
    ['pix esperando pagamento', pedido({ purchasePayment: pagamento({ mode: 'online', paymentStatus: 'waitingForPayment' }) }), false],
    ['pix reembolsado', pedido({ purchasePayment: pagamento({ mode: 'online', paymentStatus: 'canceled' }) }), false],
    ['pix com cancelamento pedido', pedido({ purchasePayment: pagamento({ mode: 'online', paymentStatus: 'pendingCancel' }) }), false],
    ['cartao aprovado', pedido({ purchasePayment: pagamento({ mode: 'online', paymentType: 'PaymentType.creditcard', paymentStatus: 'paidAwaitingConfirmation', responseCode: '00', authorizationCode: '123456' }) }), true],
    ['cartao de homologacao', pedido({ purchasePayment: pagamento({ mode: 'online', paymentType: 'PaymentType.creditcard', paymentStatus: 'paidAwaitingConfirmation', responseCode: '00', authorizationCode: 'HMLTEST' }) }), false],
    ['cartao recusado pela adquirente', pedido({ purchasePayment: pagamento({ mode: 'online', paymentStatus: 'paidAwaitingConfirmation', responseCode: '51', authorizationCode: '123456' }) }), false],
    ['cartao aprovado sem codigo de autorizacao', pedido({ purchasePayment: pagamento({ mode: 'online', paymentStatus: 'paidAwaitingConfirmation', responseCode: '00' }) }), false],
    ['pedido sem mode online: cobranca na maquininha', pedido({ purchasePayment: pagamento({ paymentStatus: 'paid' }) }), false],
    ['pix pago, com maiuscula e espaco no status', pedido({ purchasePayment: pagamento({ mode: ' Online ', paymentStatus: ' Paid ' }) }), true],
    ['esquema antigo: status no topo do pedido, com mode online', pedido({ paymentStatus: 'paid', purchasePayment: pagamento({ mode: 'online' }) }), true],
  ];

  for (const [rotulo, documento, esperado] of casos) {
    const { app } = servidor({ p1: documento });
    const { body } = await chamar(app, 'resumo', { codigo: 'A7K2Z9' });
    assert.equal(body.data.pagoOnline, esperado, rotulo);
  }
});

test('gateway fora de producao nunca conta como pago, mesmo com cartao aprovado', async () => {
  const cartaoAprovado = {
    paymentType: 'PaymentType.creditcard',
    paymentValue: 74.5,
    mode: 'online',
    paymentStatus: 'paidAwaitingConfirmation',
    responseCode: '00',
    authorizationCode: '654321',
  };
  const casos = [
    ['loja em producao', 'loja-prod', true],
    ['loja em homologacao', 'loja-hml', false],
    ['loja com gateway sem ambiente declarado', 'loja-sem-ambiente', false],
    ['loja sem gateway', 'loja-sem-gateway', false],
  ];

  for (const [rotulo, loja, esperado] of casos) {
    const { app } = servidor({ p1: pedido({ purchasePayment: cartaoAprovado, companyReference: refLoja(loja) }) });
    const { body } = await chamar(app, 'resumo', { codigo: 'A7K2Z9' });
    assert.equal(body.data.pagoOnline, esperado, rotulo);
  }

  // O mesmo vale na resposta da gravacao, que repete o resumo.
  const { app } = servidor({ p1: pedido({ purchasePayment: cartaoAprovado, companyReference: refLoja('loja-hml') }) });
  const { body } = await chamar(app, 'entregue', { codigo: 'A7K2Z9' });
  assert.equal(body.data.status, 'entregue');
  assert.equal(body.data.pagoOnline, false);
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

test('pedido sem nome de loja usa o nome do documento da loja', async () => {
  const { app } = servidor({ p1: pedido({ companyName: '' }) });

  const { body } = await chamar(app, 'resumo', { codigo: 'A7K2Z9' });

  assert.equal(body.data.loja, 'Super Zero Grau');
});

test('pedido com nome de loja mantem o do pedido, que e o do momento da compra', async () => {
  const { app } = servidor({ p1: pedido({ companyName: 'Zero Grau Centro' }) });

  const { body } = await chamar(app, 'resumo', { codigo: 'A7K2Z9' });

  assert.equal(body.data.loja, 'Zero Grau Centro');
});

test('sem nome no pedido e sem nome na loja, o campo vem vazio, nao indefinido', async () => {
  const { app } = servidor({
    p1: pedido({ companyName: '  ', companyReference: refLoja('loja-hml') }),
  });

  const { body } = await chamar(app, 'resumo', { codigo: 'A7K2Z9' });

  assert.equal(body.data.loja, '');
});

test('a resposta da gravacao tambem traz o nome da loja', async () => {
  const { app } = servidor({ p1: pedido({ companyName: '' }) });

  const { body } = await chamar(app, 'entregue', { codigo: 'A7K2Z9' });

  assert.equal(body.data.loja, 'Super Zero Grau');
  assert.equal(body.data.status, 'entregue');
});

// Endereco montado dos campos separados. O fullAddress do app repete a rua, entao ele so
// vale quando street vem vazio. Os enderecos abaixo sao inventados, com a mesma forma do
// dado real: dado de cliente nao entra em arquivo do repositorio.
const enderecoCompleto = {
  street: 'Avenida das Palmeiras',
  number: 'N 100',
  complement: 'Apto 201',
  neighborhood: 'Centro Norte',
  reference: 'Portao azul',
  city: 'Anapolis',
  uf: 'GO',
  zipCode: '75000-000',
  fullAddress: 'Avenida das Palmeiras, Avenida das Palmeiras, N 100, Centro Norte, Anapolis, Goias, CEP 75000-000.',
};

test('endereco completo sai dos campos separados, sem repetir a rua', async () => {
  const { app } = servidor({ p1: pedido({ address: enderecoCompleto }) });

  const { body } = await chamar(app, 'resumo', { codigo: 'A7K2Z9' });

  assert.deepEqual(body.data.enderecoPartes, {
    ruaNumeroComplemento: 'Avenida das Palmeiras, N 100 - Apto 201',
    bairro: 'Centro Norte',
    referencia: 'Portao azul',
    origem: 'campos',
  });
  assert.equal(body.data.endereco, 'Avenida das Palmeiras, N 100 - Apto 201 - Centro Norte');
  assert.ok(!body.data.endereco.includes('Avenida das Palmeiras, Avenida'), 'a rua nao se repete');
});

test('sem complemento, nao sobra travessao', async () => {
  const { app } = servidor({ p1: pedido({ address: { ...enderecoCompleto, complement: '' } }) });

  const { body } = await chamar(app, 'resumo', { codigo: 'A7K2Z9' });

  assert.equal(body.data.enderecoPartes.ruaNumeroComplemento, 'Avenida das Palmeiras, N 100');
  assert.equal(body.data.enderecoPartes.bairro, 'Centro Norte');
});

test('sem referencia, a parte vem nula e nao vazia', async () => {
  const { app } = servidor({ p1: pedido({ address: { ...enderecoCompleto, reference: '   ' } }) });

  const { body } = await chamar(app, 'resumo', { codigo: 'A7K2Z9' });

  assert.equal(body.data.enderecoPartes.referencia, null);
  assert.equal(body.data.referencia, '   '.trim() === '' ? '   ' : '', 'o campo antigo nao muda');
});

test('sem numero, fica so a rua e o complemento', async () => {
  const { app } = servidor({ p1: pedido({ address: { ...enderecoCompleto, number: '' } }) });

  const { body } = await chamar(app, 'resumo', { codigo: 'A7K2Z9' });

  assert.equal(body.data.enderecoPartes.ruaNumeroComplemento, 'Avenida das Palmeiras - Apto 201');
});

test('sem street, cai no fullAddress, como era antes', async () => {
  const { app } = servidor({
    p1: pedido({ address: { ...enderecoCompleto, street: '', number: '', complement: '' } }),
  });

  const { body } = await chamar(app, 'resumo', { codigo: 'A7K2Z9' });

  assert.equal(body.data.enderecoPartes.origem, 'fullAddress');
  assert.equal(body.data.enderecoPartes.ruaNumeroComplemento, enderecoCompleto.fullAddress);
  assert.ok(body.data.endereco.length > 0, 'nunca em branco para quem esta na rua');
});

test('sem street e sem fullAddress, as partes vem nulas e o campo antigo vazio', async () => {
  const { app } = servidor({
    p1: pedido({ address: { neighborhood: 'Centro Norte', reference: 'Portao azul' } }),
  });

  const { body } = await chamar(app, 'resumo', { codigo: 'A7K2Z9' });

  assert.equal(body.data.enderecoPartes.ruaNumeroComplemento, null);
  assert.equal(body.data.enderecoPartes.bairro, 'Centro Norte');
  assert.equal(body.data.endereco, 'Centro Norte');
});

test('o campo antigo endereco continua no retorno, para a pagina nao quebrar', async () => {
  const { app } = servidor({ p1: pedido({ address: enderecoCompleto }) });

  const { body } = await chamar(app, 'entregue', { codigo: 'A7K2Z9' });

  assert.equal(typeof body.data.endereco, 'string');
  assert.ok(body.data.endereco.length > 0);
  assert.equal(typeof body.data.complemento, 'string');
  assert.equal(typeof body.data.referencia, 'string');
});

// address.position e GeoPoint: o SDK expoe latitude/longitude, o dado cru _latitude/_longitude.
test('coordenada sai do position, nas duas formas do GeoPoint', async () => {
  const cru = servidor({
    p1: pedido({ address: { ...enderecoCompleto, position: { _latitude: -16.3285, _longitude: -48.9534 } } }),
  });
  const doSdk = servidor({
    p1: pedido({ address: { ...enderecoCompleto, position: { latitude: -16.3285, longitude: -48.9534 } } }),
  });

  const a = await chamar(cru.app, 'resumo', { codigo: 'A7K2Z9' });
  const b = await chamar(doSdk.app, 'resumo', { codigo: 'A7K2Z9' });

  assert.deepEqual(a.body.data.coordenada, { lat: -16.3285, lng: -48.9534 });
  assert.deepEqual(b.body.data.coordenada, { lat: -16.3285, lng: -48.9534 });
});

test('sem position, a coordenada vem nula', async () => {
  const { app } = servidor({ p1: pedido({ address: { ...enderecoCompleto, position: undefined } }) });

  const { body } = await chamar(app, 'resumo', { codigo: 'A7K2Z9' });

  assert.equal(body.data.coordenada, null);
  assert.ok(body.data.endereco.length > 0, 'o endereco em texto continua');
});

test('com um dos dois numeros faltando, a coordenada vem nula', async () => {
  const casos = [
    { _latitude: -16.3285 },
    { _longitude: -48.9534 },
    { _latitude: -16.3285, _longitude: null },
    { _latitude: 'abc', _longitude: -48.9534 },
  ];

  for (const position of casos) {
    const { app } = servidor({ p1: pedido({ address: { ...enderecoCompleto, position } }) });
    const { body } = await chamar(app, 'resumo', { codigo: 'A7K2Z9' });
    assert.equal(body.data.coordenada, null, JSON.stringify(position));
  }
});

test('numero fora da faixa do planeta vira nulo', async () => {
  const casos = [
    { _latitude: -91, _longitude: -48.9534 },
    { _latitude: 90.5, _longitude: 0 },
    { _latitude: 0, _longitude: 181 },
    { _latitude: 0, _longitude: -180.1 },
  ];

  for (const position of casos) {
    const { app } = servidor({ p1: pedido({ address: { ...enderecoCompleto, position } }) });
    const { body } = await chamar(app, 'resumo', { codigo: 'A7K2Z9' });
    assert.equal(body.data.coordenada, null, JSON.stringify(position));
  }

  // as bordas exatas continuam valendo
  const borda = servidor({ p1: pedido({ address: { ...enderecoCompleto, position: { _latitude: -90, _longitude: 180 } } }) });
  const { body } = await chamar(borda.app, 'resumo', { codigo: 'A7K2Z9' });
  assert.deepEqual(body.data.coordenada, { lat: -90, lng: 180 });
});

test('a coordenada tambem vem na resposta da gravacao, e o resto do retorno nao muda', async () => {
  const { app } = servidor({
    p1: pedido({ address: { ...enderecoCompleto, position: { _latitude: -16.3285, _longitude: -48.9534 } } }),
  });

  const { body } = await chamar(app, 'entregue', { codigo: 'A7K2Z9' });

  assert.deepEqual(body.data.coordenada, { lat: -16.3285, lng: -48.9534 });
  assert.equal(body.data.status, 'entregue');
  assert.equal(typeof body.data.endereco, 'string');
});
