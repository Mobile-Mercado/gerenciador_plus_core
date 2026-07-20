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

test('envia notificacao e desativa somente token invalido', async () => {
  const deactivated = [];
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
} = {}) {
  return new ManageWebNotifications({
    accessRepository: {
      userCanAccess: async () => allowed,
    },
    tokenRepository: {
      listActiveByEstablishment: async () => tokens,
      deactivate: async (ids) => deactivated.push(...ids),
    },
    gateway: {
      sendMulticast: async () => {
        onGatewayCall();
        return gatewayResult;
      },
    },
    clock: () => new Date('2026-07-18T12:00:00.000Z'),
  });
}
