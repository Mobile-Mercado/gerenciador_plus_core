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
