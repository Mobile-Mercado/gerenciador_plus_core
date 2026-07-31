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
      findAccountByUid: async () => allowed ? {
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
