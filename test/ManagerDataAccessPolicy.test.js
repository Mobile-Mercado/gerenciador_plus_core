import assert from 'node:assert/strict';
import test from 'node:test';
import { ManagerDataAccessPolicy } from '../src/infra/firebase/ManagerDataAccessPolicy.js';

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
