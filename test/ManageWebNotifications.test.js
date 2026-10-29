import assert from 'node:assert/strict';
import test from 'node:test';
import { ManageWebNotifications } from '../src/application/notifications/ManageWebNotifications.js';

test('impede o usuario de consultar notificacoes de outra loja', async () => {
  const manager = createManager({ allowed: false });

  await assert.rejects(
    manager.getStatus({ actorUid: 'uid-1', establishmentId: 'loja-2' }),
    (error) => error.code === 'notification_establishment_forbidden' && error.statusCode === 403,
  );
});

test('registra o token no estabelecimento resolvido pelo backend', async () => {
  const registered = [];
  const manager = createManager({ registered });

  const result = await manager.registerToken({
    actorUid: 'uid-1',
    token: 'token-fcm-valido-com-tamanho-suficiente',
    userAgent: 'Browser Test',
  });

  assert.equal(result.establishmentId, 'loja-1');
  assert.equal(result.enabled, true);
  assert.deepEqual(registered, [{
    establishmentId: 'loja-1',
    token: 'token-fcm-valido-com-tamanho-suficiente',
    userAgent: 'Browser Test',
  }]);
});

test('envia notificacao e desativa somente token invalido', async () => {
  const deactivated = [];
  const sentPayloads = [];
  const manager = createManager({
    tokens: [
      { id: 'doc-a', token: 'token-a' },
      { id: 'doc-b', token: 'token-b' },
    ],
    gatewayResult: {
      successCount: 1,
      failureCount: 1,
      failures: [
        {
          token: 'token-b',
          code: 'messaging/registration-token-not-registered',
        },
      ],
    },
    deactivated,
    sentPayloads,
  });

  const result = await manager.sendSystemNotification({
    establishmentId: 'loja-1',
    title: '<b>Atualizacao</b>',
    body: 'Etapa aprovada',
    url: '/implantacao',
  });

  assert.equal(result.successCount, 1);
  assert.equal(result.failureCount, 1);
  assert.equal(result.invalidTokensDeactivated, 1);
  assert.deepEqual(deactivated, ['doc-b']);
  assert.equal(sentPayloads[0].notification, undefined);
  assert.equal(sentPayloads[0].data.title, 'Atualizacao');
  assert.equal(sentPayloads[0].data.url, '/implantacao');
});

test('nao chama o FCM quando a loja nao possui token ativo', async () => {
  let gatewayCalls = 0;
  const manager = createManager({
    tokens: [],
    onGatewayCall: () => {
      gatewayCalls += 1;
    },
  });

  const result = await manager.sendTest({
    actorUid: 'uid-1',
    establishmentId: 'loja-1',
  });

  assert.equal(result.activeTokens, 0);
  assert.equal(result.successCount, 0);
  assert.equal(gatewayCalls, 0);
});

function createManager({
  allowed = true,
  tokens = [],
  gatewayResult = { successCount: 0, failureCount: 0, failures: [] },
  deactivated = [],
  onGatewayCall = () => {},
  registered = [],
  sentPayloads = [],
} = {}) {
  return new ManageWebNotifications({
    accessRepository: {
      userCanAccess: async () => allowed,
      findAccountByClaims: async () => allowed ? {
        establishmentId: 'loja-1',
        hasEstablishment: true,
      } : null,
    },
    tokenRepository: {
      listActiveByEstablishment: async () => tokens,
      deactivate: async (ids) => deactivated.push(...ids),
      upsert: async (payload) => registered.push(payload),
    },
    gateway: {
      sendMulticast: async (payload) => {
        onGatewayCall();
        sentPayloads.push(payload);
        return gatewayResult;
      },
    },
    clock: () => new Date('2026-07-18T12:00:00.000Z'),
  });
}

// RP-62, E.9 (contrato K7): o aviso de pedido novo vale para qualquer conta da loja.
test('E.9: funcionario sem settings.edit registra o token na loja da claim adminOf; o dono, na loja dele', async () => {
  const { default: express } = await import('express');
  const { createNotificationRoutes } = await import('../src/http/routes/notificationRoutes.js');
  const { createPermissionGuard } = await import('../src/http/middlewares/requirePermission.js');
  const { errorHandler } = await import('../src/http/middlewares/errorHandler.js');
  const { FirestoreEstablishmentAccessRepository } = await import('../src/infra/firebase/FirestoreEstablishmentAccessRepository.js');
  const { FirestoreEmMemoria } = await import('./apoio/firestoreEmMemoria.js');
  const banco = new FirestoreEmMemoria({
    'estabelecimentos/loja-1': { name: 'Loja 1' },
    'estabelecimentos/loja-1/AdminUsers/func-1': { firstName: 'Ana', lastName: 'Souza', active: true },
    'estabelecimentos/loja-1/AdminUsers/func-off': { firstName: 'Bia', active: false },
    'estabelecimentos/loja-1/PermissionGroups/g-pedidos': { name: 'Pedidos', permissions: ['requests.view'] },
    'estabelecimentos/loja-2': { name: 'Loja 2' },
    'Users/u-dono2': { userAuthId: 'dono-2', id: 'loja-2' },
  });
  banco.docs.set('estabelecimentos/loja-2', { name: 'Loja 2', userReference: banco.collection('Users').doc('u-dono2') });
  const accessRepository = new FirestoreEstablishmentAccessRepository({ firestore: banco });
  const registrados = [];
  const manageWebNotifications = new ManageWebNotifications({
    accessRepository,
    tokenRepository: {
      upsert: async (payload) => registrados.push(payload),
      listActiveByEstablishment: async (loja) => registrados.filter((item) => item.establishmentId === loja),
    },
    gateway: { sendMulticast: async () => ({ successCount: 0, failureCount: 0, failures: [] }) },
  });
  const { requirePermission } = createPermissionGuard({ accessRepository });
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = JSON.parse(request.headers['x-auth']); next(); });
  app.use('/api/notifications', createNotificationRoutes({ manageWebNotifications, requirePermission }));
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const registrar = (auth, corpo = {}) => fetch(`http://127.0.0.1:${servidor.address().port}/api/notifications/web/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth': JSON.stringify(auth) },
    body: JSON.stringify({ token: `token-fcm-${auth.uid}-com-tamanho-suficiente`, ...corpo }),
  });
  try {
    const doFuncionario = await registrar({ uid: 'func-1', adminOf: 'loja-1', groupId: 'g-pedidos' }, { establishmentId: 'loja-2' });
    assert.equal(doFuncionario.status, 200);
    assert.equal((await doFuncionario.json()).data.establishmentId, 'loja-1', 'a loja vem da claim, nao do corpo');
    assert.equal((await registrar({ uid: 'dono-2' })).status, 200);
    assert.deepEqual(registrados.map((item) => item.establishmentId), ['loja-1', 'loja-2']);

    // Funcionario desativado e conta sem loja continuam recusados.
    assert.equal((await registrar({ uid: 'func-off', adminOf: 'loja-1', groupId: 'g-pedidos' })).status, 403);
    assert.equal((await registrar({ uid: 'sem-loja' })).status, 403);
    assert.equal(registrados.length, 2);
  } finally {
    servidor.closeAllConnections();
    servidor.close();
  }
});

test('E.9: loja do cadastro novo em analise nao registra o token', async () => {
  const registrados = [];
  const manager = new ManageWebNotifications({
    accessRepository: {
      findAccountByClaims: async () => ({ establishmentId: 'loja-nova', hasEstablishment: true, establishmentDocument: { status: 'em_analise' } }),
    },
    tokenRepository: { upsert: async (payload) => registrados.push(payload), listActiveByEstablishment: async () => [] },
    gateway: {},
  });
  await assert.rejects(
    manager.registerToken({ actorUid: 'dono', token: 'token-fcm-valido-com-tamanho-suficiente' }),
    (error) => error.code === 'loja_em_analise' && error.statusCode === 403,
  );
  assert.equal(registrados.length, 0);
});
