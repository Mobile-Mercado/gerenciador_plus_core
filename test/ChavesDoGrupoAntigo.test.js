import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { chavesDoGrupo, chavesHerdadas, grupoEhAntigo } from '../src/application/auth/chavesDoGrupo.js';
import { GetManagerSession } from '../src/application/auth/GetManagerSession.js';
import { FirestoreEstablishmentAccessRepository } from '../src/infra/firebase/FirestoreEstablishmentAccessRepository.js';
import { createPermissionGuard } from '../src/http/middlewares/requirePermission.js';
import { errorHandler } from '../src/http/middlewares/errorHandler.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// RP-62, E.8 (contrato K8): grupo antigo ganha so a chave nova cuja tela ele ja via na web antiga.

test('E.8: o que cada tipo de grupo ganha', () => {
  const casos = [
    // [grupo, ganha]
    [{ permissions: [] }, ['dashboard.view']],
    [{ permissions: ['requests.view', 'requests.update_status'] }, ['dashboard.view']],
    [{ permissions: ['settings.view'] }, ['dashboard.view', 'logs.view']],
    [{ permissions: ['settings.view', 'settings.edit', 'products.view'] }, ['dashboard.view', 'logs.view']],
    // settings.edit sem settings.view nao abria /logs na web antiga (podeVerTela pede settings.view).
    [{ permissions: ['settings.edit'] }, ['dashboard.view']],
    [{}, ['dashboard.view']],
    // Grupo novo: ja tem alguma chave nova, ou foi salvo pelo painel novo.
    [{ permissions: ['settings.view', 'finance.view'] }, []],
    [{ permissions: ['dashboard.view'] }, []],
    [{ permissions: ['settings.view'], painelNovo: true }, []],
    [{ permissions: [], painelNovo: true }, []],
    // Administrador: passa em tudo pelo isAdmin, nada a herdar.
    [{ isAdmin: true, permissions: [] }, []],
  ];
  for (const [grupo, ganha] of casos) {
    assert.deepEqual(chavesHerdadas(grupo), ganha, JSON.stringify(grupo));
    assert.deepEqual(chavesDoGrupo(grupo), [...(grupo.permissions || []), ...ganha], JSON.stringify(grupo));
  }
  // finance.view nunca e herdada: a web antiga nao tinha tela de financas.
  assert.ok(casos.every(([grupo]) => !chavesHerdadas(grupo).includes('finance.view')));
  assert.equal(grupoEhAntigo(null), false);
  assert.equal(grupoEhAntigo({ permissions: ['logs.view'] }), false);
  assert.equal(grupoEhAntigo({ permissions: ['chat.view'], painelNovo: false }), true);
});

function bancoDaLoja() {
  return new FirestoreEmMemoria({
    'estabelecimentos/loja-1': { name: 'Loja 1' },
    'estabelecimentos/loja-1/AdminUsers/f-ajustes': { firstName: 'Ana', active: true },
    'estabelecimentos/loja-1/AdminUsers/f-caixa': { firstName: 'Bia', active: true },
    'estabelecimentos/loja-1/AdminUsers/f-novo': { firstName: 'Caio', active: true },
    'estabelecimentos/loja-1/PermissionGroups/g-ajustes': { name: 'Ajustes', permissions: ['settings.view', 'settings.edit'] },
    'estabelecimentos/loja-1/PermissionGroups/g-caixa': { name: 'Caixa', permissions: ['requests.view'] },
    'estabelecimentos/loja-1/PermissionGroups/g-novo': { name: 'Novo', permissions: ['requests.view'], painelNovo: true },
  });
}

test('E.8: /api/session devolve as chaves herdadas sem gravar no PermissionGroups', async () => {
  const banco = bancoDaLoja();
  const antes = banco.escritas.length;
  const sessao = new GetManagerSession({ accessRepository: new FirestoreEstablishmentAccessRepository({ firestore: banco }) });
  const chavesDe = async (uid, groupId) => (await sessao.execute({ actorUid: uid, claims: { uid, adminOf: 'loja-1', groupId } })).permissions.keys;

  assert.deepEqual(await chavesDe('f-ajustes', 'g-ajustes'), ['settings.view', 'settings.edit', 'dashboard.view', 'logs.view']);
  assert.deepEqual(await chavesDe('f-caixa', 'g-caixa'), ['requests.view', 'dashboard.view']);
  assert.deepEqual(await chavesDe('f-novo', 'g-novo'), ['requests.view']);
  assert.equal(banco.escritas.length, antes, 'nada gravado');
  assert.deepEqual(banco.dados('estabelecimentos/loja-1/PermissionGroups/g-caixa').permissions, ['requests.view']);
});

test('E.8: as barreiras do Core usam as mesmas chaves (dashboard.view do Inicio)', async () => {
  const accessRepository = new FirestoreEstablishmentAccessRepository({ firestore: bancoDaLoja() });
  const { requirePermission } = createPermissionGuard({ accessRepository });
  const app = express();
  app.use((request, _response, next) => { request.auth = JSON.parse(request.headers['x-auth']); next(); });
  app.get('/inicio', requirePermission('dashboard.view'), (_request, response) => response.json({ ok: true }));
  app.get('/financas', requirePermission('finance.view'), (_request, response) => response.json({ ok: true }));
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const pedir = async (caminho, uid, groupId) => (await fetch(`http://127.0.0.1:${servidor.address().port}${caminho}`, {
    headers: { 'x-auth': JSON.stringify({ uid, adminOf: 'loja-1', groupId }) },
  })).status;
  try {
    assert.equal(await pedir('/inicio', 'f-caixa', 'g-caixa'), 200);
    assert.equal(await pedir('/financas', 'f-caixa', 'g-caixa'), 403);
    assert.equal(await pedir('/inicio', 'f-novo', 'g-novo'), 403);
  } finally {
    servidor.closeAllConnections();
    servidor.close();
  }
});
