import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { GetManagerSession } from '../src/application/auth/GetManagerSession.js';
import { FirestoreEstablishmentAccessRepository } from '../src/infra/firebase/FirestoreEstablishmentAccessRepository.js';
import { createPermissionGuard } from '../src/http/middlewares/requirePermission.js';
import { errorHandler } from '../src/http/middlewares/errorHandler.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// RP-65, E.1: sai a regra de transicao do E.8 (chaves herdadas e a marca painelNovo). Todo grupo vale
// o que esta gravado no PermissionGroups, na sessao e nas barreiras do Core.

function bancoDaLoja() {
  return new FirestoreEmMemoria({
    'estabelecimentos/loja-1': { name: 'Loja 1' },
    'estabelecimentos/loja-1/AdminUsers/f-ajustes': { firstName: 'Ana', active: true },
    'estabelecimentos/loja-1/AdminUsers/f-caixa': { firstName: 'Bia', active: true },
    'estabelecimentos/loja-1/AdminUsers/f-novo': { firstName: 'Caio', active: true },
    'estabelecimentos/loja-1/AdminUsers/f-inicio': { firstName: 'Davi', active: true },
    'estabelecimentos/loja-1/PermissionGroups/g-ajustes': { name: 'Ajustes', permissions: ['settings.view', 'settings.edit'] },
    'estabelecimentos/loja-1/PermissionGroups/g-caixa': { name: 'Caixa', permissions: ['requests.view'] },
    'estabelecimentos/loja-1/PermissionGroups/g-novo': { name: 'Novo', permissions: ['requests.view'], painelNovo: true },
    'estabelecimentos/loja-1/PermissionGroups/g-inicio': { name: 'Inicio', permissions: ['dashboard.view'] },
  });
}

test('E.1: /api/session devolve so as chaves gravadas do grupo, com ou sem painelNovo, e nao grava nada', async () => {
  const banco = bancoDaLoja();
  const antes = banco.escritas.length;
  const sessao = new GetManagerSession({ accessRepository: new FirestoreEstablishmentAccessRepository({ firestore: banco }) });
  const permissoesDe = async (uid, groupId) => (await sessao.execute({ actorUid: uid, claims: { uid, adminOf: 'loja-1', groupId } })).permissions;

  assert.deepEqual(await permissoesDe('f-ajustes', 'g-ajustes'), { isAdmin: false, groupId: 'g-ajustes', keys: ['settings.view', 'settings.edit'] });
  assert.deepEqual((await permissoesDe('f-caixa', 'g-caixa')).keys, ['requests.view']);
  assert.deepEqual((await permissoesDe('f-novo', 'g-novo')).keys, ['requests.view']);
  assert.deepEqual((await permissoesDe('f-inicio', 'g-inicio')).keys, ['dashboard.view']);
  assert.equal(banco.escritas.length, antes, 'nada gravado');
});

test('E.1: as barreiras do Core usam as chaves gravadas (sem dashboard.view nem logs.view herdados)', async () => {
  const accessRepository = new FirestoreEstablishmentAccessRepository({ firestore: bancoDaLoja() });
  const { requirePermission } = createPermissionGuard({ accessRepository });
  const app = express();
  app.use((request, _response, next) => { request.auth = JSON.parse(request.headers['x-auth']); next(); });
  app.get('/inicio', requirePermission('dashboard.view'), (_request, response) => response.json({ ok: true }));
  app.get('/logs', requirePermission('logs.view'), (_request, response) => response.json({ ok: true }));
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const pedir = async (caminho, uid, groupId) => (await fetch(`http://127.0.0.1:${servidor.address().port}${caminho}`, {
    headers: { 'x-auth': JSON.stringify({ uid, adminOf: 'loja-1', groupId }) },
  })).status;
  try {
    assert.equal(await pedir('/inicio', 'f-caixa', 'g-caixa'), 403);
    assert.equal(await pedir('/logs', 'f-ajustes', 'g-ajustes'), 403);
    assert.equal(await pedir('/inicio', 'f-novo', 'g-novo'), 403);
    assert.equal(await pedir('/inicio', 'f-inicio', 'g-inicio'), 200);
  } finally {
    servidor.closeAllConnections();
    servidor.close();
  }
});
