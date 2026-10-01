import assert from 'node:assert/strict';
import test from 'node:test';
import { ManagerDataAccessPolicy } from '../src/infra/firebase/ManagerDataAccessPolicy.js';

const LOJA = 'store-1';
const actor = {
  uid: 'uid-manager',
  userId: 'store-1',
  establishmentId: LOJA,
  hasEstablishment: true,
  permissions: { isAdmin: true, groupId: null, keys: [] },
};

// Firestore de mentira: so os pedidos que a politica le para conferir a loja do pedido.
function firestoreFalso(pedidos = { 'PurchaseRequests/p1': { companyReference: { id: LOJA } } }) {
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

const politica = (pedidos) => new ManagerDataAccessPolicy({ firestore: firestoreFalso(pedidos) });

function mutacao(data, path = 'PurchaseRequests/p1') {
  return { operation: 'update', target: { path }, data };
}

const CONFERENCIA = {
  proximaEm: new Date('2026-10-02T12:00:00Z'),
  ultimaResposta: 'a_caminho',
  ultimaEm: new Date('2026-10-01T18:00:00Z'),
  ultimaPor: 'uid-manager',
};

test('gravacao valida da conferencia de entrega passa', async () => {
  const policy = politica();

  await policy.assertMutation({ actor, mutation: mutacao({ conferenciaEntrega: CONFERENCIA }) });
  // mapa parcial tambem vale: a pergunta pode so reagendar
  await policy.assertMutation({
    actor,
    mutation: mutacao({ conferenciaEntrega: { proximaEm: CONFERENCIA.proximaEm } }),
  });
  // as tres respostas previstas
  for (const ultimaResposta of ['entregue', 'a_caminho', 'nao']) {
    await policy.assertMutation({
      actor,
      mutation: mutacao({ conferenciaEntrega: { ...CONFERENCIA, ultimaResposta } }),
    });
  }
});

test('chave desconhecida dentro do mapa e recusada', async () => {
  const policy = politica();

  for (const conferenciaEntrega of [
    { ...CONFERENCIA, observacao: 'cliente nao atendeu' },
    { proximaEm: CONFERENCIA.proximaEm, status: 'entregue' },
    { currentPurchaseStatus: 'PurchaseStatus.completed' },
  ]) {
    await assert.rejects(
      policy.assertMutation({ actor, mutation: mutacao({ conferenciaEntrega }) }),
      (error) => error.code === 'data_order_fields_forbidden' && error.statusCode === 403,
      JSON.stringify(Object.keys(conferenciaEntrega)),
    );
  }
});

test('conferencia que nao e mapa e recusada', async () => {
  const policy = politica();

  for (const conferenciaEntrega of ['entregue', 42, true, ['entregue'], null]) {
    await assert.rejects(
      policy.assertMutation({ actor, mutation: mutacao({ conferenciaEntrega }) }),
      (error) => error.code === 'data_order_fields_forbidden',
      JSON.stringify(conferenciaEntrega),
    );
  }
});

test('tentar gravar status junto com a conferencia e recusado', async () => {
  const policy = politica();

  await assert.rejects(
    policy.assertMutation({
      actor,
      mutation: mutacao({
        conferenciaEntrega: CONFERENCIA,
        currentPurchaseStatus: 'PurchaseStatus.completed',
      }),
    }),
    (error) => error.code === 'permission_denied' || error.code === 'data_order_fields_forbidden',
  );
});

test('status e statusList continuam valendo sozinhos, sem mudanca de comportamento', async () => {
  const policy = politica();

  await policy.assertMutation({
    actor,
    mutation: mutacao({ currentPurchaseStatus: 'PurchaseStatus.deliveryRoute', statusList: [] }),
  });
  await assert.rejects(
    policy.assertMutation({ actor, mutation: mutacao({ clientName: 'outro' }) }),
    (error) => error.code === 'data_order_fields_forbidden',
  );
});

test('loja nao grava conferencia em pedido de outra loja', async () => {
  const policy = politica({ 'PurchaseRequests/p2': { companyReference: { id: 'store-2' } } });

  await assert.rejects(
    policy.assertMutation({
      actor,
      mutation: mutacao({ conferenciaEntrega: CONFERENCIA }, 'PurchaseRequests/p2'),
    }),
    (error) => error.code === 'data_access_forbidden' && error.statusCode === 403,
  );
});

test('pedido inexistente tambem e recusado', async () => {
  const policy = politica({});

  await assert.rejects(
    policy.assertMutation({ actor, mutation: mutacao({ conferenciaEntrega: CONFERENCIA }) }),
    (error) => error.code === 'data_access_forbidden',
  );
});
