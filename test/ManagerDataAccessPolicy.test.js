import assert from 'node:assert/strict';
import test from 'node:test';
import { ManagerDataAccessPolicy, carimboDeStatus } from '../src/infra/firebase/ManagerDataAccessPolicy.js';
import { FirestoreManagerDataGateway } from '../src/infra/firebase/FirestoreManagerDataGateway.js';

const actor = {
  uid: 'uid-manager',
  userId: 'store-1',
  establishmentId: 'store-1',
  hasEstablishment: true,
};

test('permite somente o caminho do estabelecimento autenticado', async () => {
  const policy = new ManagerDataAccessPolicy({ firestore: {} });

  await policy.assertRead({
    actor,
    target: { kind: 'collection', path: 'estabelecimentos/store-1/Products' },
  });
  await assert.rejects(
    policy.assertRead({
      actor,
      target: { kind: 'collection', path: 'estabelecimentos/store-2/Products' },
    }),
    (error) => error.code === 'data_access_forbidden' && error.statusCode === 403,
  );
});

test('aceita collectionGroup de conversas mesmo dentro de query', async () => {
  const policy = new ManagerDataAccessPolicy({ firestore: {} });
  await policy.assertRead({
    actor,
    target: {
      kind: 'query',
      source: { kind: 'collectionGroup', id: 'conversas' },
      constraints: [{ kind: 'where', field: 'companyId', operator: '==', value: 'store-1' }],
    },
  });
});

test('impede consulta ampla de chats sem filtro da loja', async () => {
  const policy = new ManagerDataAccessPolicy({ firestore: {} });
  await assert.rejects(
    policy.assertRead({
      actor,
      target: { kind: 'collection', path: 'Chats' },
    }),
    (error) => error.code === 'data_access_forbidden',
  );
});

test('remove campos de autenticacao e outros dados internos do perfil do cliente', () => {
  const policy = new ManagerDataAccessPolicy({ firestore: {} });
  const data = policy.sanitizeDocument('Users/client-1', {
    name: 'Cliente',
    phone: '27999999999',
    segmento: 'Fiel',
    userAuthId: 'nao-expor',
    internalFlag: true,
  });

  assert.deepEqual(data, {
    name: 'Cliente',
    phone: '27999999999',
    segmento: 'Fiel',
  });
});

// ----- Trava de pedido encerrado -----

const actorComPermissao = { ...actor, permissions: { isAdmin: true, groupId: null, keys: [] } };

// Firestore de mentira: so os pedidos que a politica le para conferir loja e status.
function firestoreDePedidos(pedidos) {
  return {
    doc: (path) => ({
      async get() {
        const dados = pedidos[path];
        return { exists: Boolean(dados), data: () => dados };
      },
    }),
    collection: () => ({ doc: () => ({ async get() { return { exists: false }; } }) }),
  };
}

const pedidoNoStatus = (status, loja = 'store-1') => ({
  'PurchaseRequests/p1': { companyReference: { id: loja }, currentPurchaseStatus: `PurchaseStatus.${status}` },
});

const mudarPedido = (status, data) => new ManagerDataAccessPolicy({ firestore: firestoreDePedidos(pedidoNoStatus(status)) })
  .assertMutation({ actor: actorComPermissao, mutation: { operation: 'update', target: { path: 'PurchaseRequests/p1' }, data } });

const TROCA_PARA_ACEITO = {
  currentPurchaseStatus: 'PurchaseStatus.accepted',
  statusList: [{ purchaseStatus: 'PurchaseStatus.accepted' }],
};
const pedidoEncerrado = (error) => error.code === 'pedido_encerrado' && error.statusCode === 409;

test('troca de status de pedido giveUp para accepted e recusada', async () => {
  await assert.rejects(mudarPedido('giveUp', TROCA_PARA_ACEITO), pedidoEncerrado);
});

test('troca de status a partir de completed, denied e canceled tambem e recusada', async () => {
  for (const status of ['completed', 'denied', 'canceled']) {
    await assert.rejects(mudarPedido(status, TROCA_PARA_ACEITO), pedidoEncerrado, status);
  }
});

test('so statusList ou so currentPurchaseStatus ja contam como troca de status', async () => {
  await assert.rejects(mudarPedido('canceled', { statusList: [] }), pedidoEncerrado);
  await assert.rejects(mudarPedido('canceled', { currentPurchaseStatus: 'PurchaseStatus.accepted' }), pedidoEncerrado);
});

test('troca de status de pedido pending, accepted e deliveryRoute continua permitida', async () => {
  for (const status of ['pending', 'accepted', 'deliveryRoute']) {
    await mudarPedido(status, TROCA_PARA_ACEITO);
  }
});

test('isTest em pedido encerrado continua permitido', async () => {
  await mudarPedido('completed', { isTest: true });
  await mudarPedido('canceled', { isTest: false, isTestAccount: true });
});

test('conferenciaEntrega sozinha em pedido encerrado continua permitida', async () => {
  await mudarPedido('completed', { conferenciaEntrega: { ultimaResposta: 'entregue' } });
});

test('pedido de outra loja continua recusado como antes, mesmo encerrado', async () => {
  const policy = new ManagerDataAccessPolicy({ firestore: firestoreDePedidos(pedidoNoStatus('canceled', 'store-2')) });
  await assert.rejects(
    policy.assertMutation({
      actor: actorComPermissao,
      mutation: { operation: 'update', target: { path: 'PurchaseRequests/p1' }, data: TROCA_PARA_ACEITO },
    }),
    (error) => error.code === 'data_access_forbidden' && error.statusCode === 403,
  );
});

test('campo proibido em pedido encerrado continua dando o erro de campo, antes da trava', async () => {
  await assert.rejects(
    mudarPedido('canceled', { ...TROCA_PARA_ACEITO, price: 1 }),
    (error) => error.code === 'data_order_fields_forbidden' && error.statusCode === 403,
  );
});

// ----- Carimbo de quem trocou o status -----

const atorComNome = (userDocument) => ({ ...actorComPermissao, uid: 'uid-func', userDocument });

test('carimbo com currentPurchaseStatus grava uid, nome e status sem prefixo', () => {
  const data = { currentPurchaseStatus: 'PurchaseStatus.completed', statusList: [] };
  const carimbado = carimboDeStatus(atorComNome({ nome: 'Ana Caixa', name: 'Outro' }), data);
  assert.deepEqual(carimbado, {
    currentPurchaseStatus: 'PurchaseStatus.completed',
    statusList: [],
    statusAlteradoPor: { uid: 'uid-func', nome: 'Ana Caixa', status: 'completed' },
  });
  assert.equal(data.statusAlteradoPor, undefined, 'nao altera o objeto recebido');
});

test('carimbo so com isTest nao muda nada', () => {
  const data = { isTest: true };
  assert.equal(carimboDeStatus(atorComNome({ nome: 'Ana' }), data), data);
  const soLista = { statusList: [] };
  assert.equal(carimboDeStatus(atorComNome({ nome: 'Ana' }), soLista), soLista);
});

test('nome do carimbo cai para name, depois email, e sem nenhum fica null', () => {
  const nomeDe = (userDocument) => carimboDeStatus(
    atorComNome(userDocument),
    { currentPurchaseStatus: 'PurchaseStatus.accepted' },
  ).statusAlteradoPor.nome;
  assert.equal(nomeDe({ nome: null, name: 'Loja Centro' }), 'Loja Centro');
  assert.equal(nomeDe({ nome: null, name: null, email: 'func@loja.test' }), 'func@loja.test');
  assert.equal(nomeDe({ nome: null, name: null, email: null }), null);
  assert.equal(nomeDe(undefined), null);
});

const pedidoComCarimbo = (status, carimbo) => ({
  'PurchaseRequests/p1': {
    companyReference: { id: 'store-1' },
    currentPurchaseStatus: `PurchaseStatus.${status}`,
    ...(carimbo === undefined ? {} : { statusAlteradoPor: carimbo }),
  },
});

const erroAoMudar = async (pedidos) => {
  const policy = new ManagerDataAccessPolicy({ firestore: firestoreDePedidos(pedidos) });
  try {
    await policy.assertMutation({
      actor: actorComPermissao,
      mutation: { operation: 'update', target: { path: 'PurchaseRequests/p1' }, data: TROCA_PARA_ACEITO },
    });
  } catch (error) {
    return error;
  }
  throw new Error('a troca deveria ter sido recusada');
};

test('pedido_encerrado traz o status atual e quem colocou, quando o carimbo e desse status', async () => {
  const error = await erroAoMudar(pedidoComCarimbo('giveUp', { uid: 'u1', nome: 'Bruno', status: 'giveUp' }));
  assert.equal(error.code, 'pedido_encerrado');
  assert.equal(error.statusCode, 409);
  assert.equal(error.message, 'Este pedido ja foi encerrado e nao pode mudar de status.');
  assert.deepEqual(error.details, { status: 'giveUp', por: 'Bruno' });
});

test('details.por e null com carimbo de outro status ou sem carimbo', async () => {
  const outro = await erroAoMudar(pedidoComCarimbo('canceled', { uid: 'u1', nome: 'Bruno', status: 'deliveryRoute' }));
  assert.deepEqual(outro.details, { status: 'canceled', por: null });
  const semCarimbo = await erroAoMudar(pedidoComCarimbo('completed'));
  assert.deepEqual(semCarimbo.details, { status: 'completed', por: null });
});

test('statusAlteradoPor mandado pelo painel continua recusado', async () => {
  await assert.rejects(
    mudarPedido('accepted', {
      currentPurchaseStatus: 'PurchaseStatus.deliveryRoute',
      statusAlteradoPor: { uid: 'x', nome: 'Forjado', status: 'deliveryRoute' },
    }),
    (error) => error.code === 'data_order_fields_forbidden' && error.statusCode === 403,
  );
});

// Gateway sem Firestore real: politica de mentira que guarda o que viu, e um Firestore
// que so registra as gravacoes.
function gatewayDeMentira() {
  const registro = { politicaViu: [], gravado: [] };
  const firestore = {
    doc: (path) => ({
      path,
      async update(data) { registro.gravado.push({ path, data, via: 'update' }); },
      async set(data) { registro.gravado.push({ path, data, via: 'set' }); },
    }),
    batch: () => ({
      update: (ref, data) => registro.gravado.push({ path: ref.path, data, via: 'batch.update' }),
      set: (ref, data) => registro.gravado.push({ path: ref.path, data, via: 'batch.set' }),
      delete: () => {},
      async commit() {},
    }),
  };
  const policy = {
    async assertMutation({ mutation }) { registro.politicaViu.push(structuredClone(mutation.data)); },
  };
  return { gateway: new FirestoreManagerDataGateway({ firestore, policy }), registro };
}

test('gateway carimba o status depois da politica, em gravacao unica e em batch', async () => {
  const ator = atorComNome({ nome: 'Ana Caixa' });
  const unica = gatewayDeMentira();
  await unica.gateway.mutate({
    actor: ator,
    request: { operation: 'update', target: { path: 'PurchaseRequests/p1' }, data: { currentPurchaseStatus: 'PurchaseStatus.accepted' } },
  });
  assert.equal(unica.registro.politicaViu[0].statusAlteradoPor, undefined, 'a politica ve o dado do painel, sem carimbo');
  assert.deepEqual(unica.registro.gravado[0].data.statusAlteradoPor, { uid: 'uid-func', nome: 'Ana Caixa', status: 'accepted' });

  const lote = gatewayDeMentira();
  await lote.gateway.mutate({
    actor: ator,
    request: {
      operation: 'batch',
      operations: [
        { operation: 'update', target: { path: 'PurchaseRequests/p1' }, data: { currentPurchaseStatus: 'PurchaseStatus.completed' } },
        { operation: 'update', target: { path: 'PurchaseRequests/p2' }, data: { isTest: true } },
        { operation: 'set', target: { path: 'estabelecimentos/store-1/Stats/x' }, data: { currentPurchaseStatus: 'PurchaseStatus.completed' } },
      ],
    },
  });
  assert.equal(lote.registro.gravado[0].data.statusAlteradoPor.status, 'completed');
  assert.deepEqual(lote.registro.gravado[1].data, { isTest: true });
  assert.equal(lote.registro.gravado[2].data.statusAlteradoPor, undefined, 'fora de PurchaseRequests nao carimba');
});
