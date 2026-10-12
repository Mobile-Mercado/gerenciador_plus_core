import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { GetManagerSession } from '../src/application/auth/GetManagerSession.js';
import { createAdminAuditMiddleware } from '../src/http/middlewares/adminAudit.js';
import { createPlatformAdminGuard } from '../src/http/middlewares/requirePlatformAdmin.js';
import { FirestorePlatformAdminRepository } from '../src/infra/firebase/FirestorePlatformAdminRepository.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

function banco() {
  return new FirestoreEmMemoria({
    'usersAdmin/uid-admin': { nome: 'Thay', isAdmin: true },
    'usersAdmin/uid-sem-flag': { nome: 'Outro', isAdmin: false },
  });
}

async function rodar(middleware, request) {
  return new Promise((resolve) => {
    middleware(request, {}, (error) => resolve(error));
  });
}

test('admin da plataforma passa', async () => {
  const { requirePlatformAdmin } = createPlatformAdminGuard({
    platformAdminRepository: new FirestorePlatformAdminRepository({ firestore: banco() }),
  });
  assert.equal(await rodar(requirePlatformAdmin, { auth: { uid: 'uid-admin' } }), undefined);
});

test('dono de loja (isAdmin da loja) recebe 403', async () => {
  const { requirePlatformAdmin } = createPlatformAdminGuard({
    platformAdminRepository: new FirestorePlatformAdminRepository({ firestore: banco() }),
  });
  const erro = await rodar(requirePlatformAdmin, { auth: { uid: 'uid-dono-de-loja' } });
  assert.equal(erro.statusCode, 403);
  assert.equal(erro.code, 'platform_admin_required');
  const semFlag = await rodar(requirePlatformAdmin, { auth: { uid: 'uid-sem-flag' } });
  assert.equal(semFlag.code, 'platform_admin_required');
});

test('sem login recebe 401', async () => {
  const { requirePlatformAdmin } = createPlatformAdminGuard({
    platformAdminRepository: new FirestorePlatformAdminRepository({ firestore: banco() }),
  });
  assert.equal((await rodar(requirePlatformAdmin, {})).statusCode, 401);
});

test('confere em toda chamada, com cache ate o fim do token', async () => {
  const registro = { chamadas: 0 };
  const { requirePlatformAdmin } = createPlatformAdminGuard({
    platformAdminRepository: { isPlatformAdmin: async () => { registro.chamadas += 1; return true; } },
    clock: () => 1_000,
  });
  const request = { auth: { uid: 'uid-admin', exp: 2, iat: 1 } };
  await rodar(requirePlatformAdmin, request);
  await rodar(requirePlatformAdmin, request);
  assert.equal(registro.chamadas, 1);
});

test('registro grava quem agiu, a rota e a loja alvo', async () => {
  const firestore = new FirestoreEmMemoria();
  const middleware = createAdminAuditMiddleware({ firestore, serverTimestamp: () => 'agora' });
  const response = Object.assign(new EventEmitter(), { statusCode: 200, locals: {} });
  const request = {
    method: 'POST',
    originalUrl: '/api/admin/liberacoes',
    auth: { uid: 'uid-admin', email: 'admin@teste' },
    body: { lojaId: 'loja-1', categoriaId: 'tabacaria' },
    params: {},
  };
  await new Promise((resolve) => { middleware(request, response, resolve); });
  response.emit('finish');
  await new Promise((resolve) => { setImmediate(resolve); });

  const raiz = firestore.escritas.find((escrita) => escrita.caminho.startsWith('adminAuditLogs/'));
  assert.equal(raiz.dados.uid, 'uid-admin');
  assert.equal(raiz.dados.rota, '/api/admin/liberacoes');
  assert.deepEqual(raiz.dados.lojas, ['loja-1']);
  const daLoja = firestore.escritas.find((escrita) => escrita.caminho.startsWith('estabelecimentos/loja-1/AdminAuditLogs/'));
  assert.equal(daLoja.dados.performedBy, 'uid-admin');
  assert.equal(daLoja.dados.action, 'admin_plataforma');
});

test('GET nao vira registro', async () => {
  const firestore = new FirestoreEmMemoria();
  const middleware = createAdminAuditMiddleware({ firestore });
  const response = Object.assign(new EventEmitter(), { statusCode: 200, locals: {} });
  await new Promise((resolve) => { middleware({ method: 'GET', auth: { uid: 'x' } }, response, resolve); });
  response.emit('finish');
  assert.equal(firestore.escritas.length, 0);
});

test('a sessao diz se a conta e admin da plataforma, mesmo sem loja', async () => {
  const session = new GetManagerSession({
    accessRepository: { findAccountByClaims: async () => null },
    platformAdminRepository: new FirestorePlatformAdminRepository({ firestore: banco() }),
  });
  const result = await session.execute({ actorUid: 'uid-admin', claims: {} });
  assert.equal(result.hasEstablishment, false);
  assert.equal(result.isPlatformAdmin, true);
  assert.equal(result.permissions.isAdmin, false);
});
