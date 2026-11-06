import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { GetManagerSession } from '../src/application/auth/GetManagerSession.js';
import { FirestoreEstablishmentAccessRepository } from '../src/infra/firebase/FirestoreEstablishmentAccessRepository.js';
import { createPermissionGuard } from '../src/http/middlewares/requirePermission.js';
import { ManagerDataAccessPolicy } from '../src/infra/firebase/ManagerDataAccessPolicy.js';
import { errorHandler } from '../src/http/middlewares/errorHandler.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// RP-65, E.2: o grupo "Administrador" ("Acesso total" na web antiga) e o PermissionGroups com
// isAdmin: true, gravado com permissions: [] (mobile_firebase_api adminAccessRules.test.ts). A sessao
// leva isAdmin true e as barreiras do Core deixam passar toda chave, inclusive as tres do painel novo
// (Inicio, Financas e Logs), sem precisar de nenhuma chave gravada.

// As chaves do catalogo do painel (web_gerenciador_plus src/features/settings/permissionsCatalog.js).
const TODAS_AS_CHAVES = [
  'requests.view', 'requests.update_status', 'requests.cancel',
  'products.view', 'products.create', 'products.edit', 'products.edit_price', 'products.delete',
  'coupons.view', 'coupons.manage', 'chat.view', 'chat.send', 'settings.view', 'settings.edit',
  'admin_users.view', 'admin_users.manage', 'permission_groups.view', 'permission_groups.manage',
  'dashboard.view', 'finance.view', 'logs.view',
];

function bancoDaLoja() {
  return new FirestoreEmMemoria({
    'estabelecimentos/loja-1': { name: 'Loja 1' },
    'estabelecimentos/loja-1/AdminUsers/f-adm': { firstName: 'Eva', active: true },
    'estabelecimentos/loja-1/AdminUsers/f-caixa': { firstName: 'Bia', active: true },
    'estabelecimentos/loja-1/PermissionGroups/g-adm': { name: 'Administrador', isAdmin: true, permissions: [] },
    'estabelecimentos/loja-1/PermissionGroups/g-caixa': { name: 'Caixa', isAdmin: false, permissions: ['requests.view'] },
  });
}

test('E.2: /api/session do funcionario do grupo Administrador leva isAdmin true', async () => {
  const sessao = new GetManagerSession({ accessRepository: new FirestoreEstablishmentAccessRepository({ firestore: bancoDaLoja() }) });
  const resposta = await sessao.execute({ actorUid: 'f-adm', claims: { uid: 'f-adm', adminOf: 'loja-1', groupId: 'g-adm' } });
  assert.deepEqual(resposta.permissions, { isAdmin: true, groupId: 'g-adm', keys: [] });
  assert.equal(resposta.establishmentId, 'loja-1');
  assert.equal(resposta.hasEstablishment, true);
});

test('E.2: o grupo Administrador passa em toda chave, inclusive Inicio, Financas e Logs; o grupo restrito nao', async () => {
  const accessRepository = new FirestoreEstablishmentAccessRepository({ firestore: bancoDaLoja() });
  const { requirePermission } = createPermissionGuard({ accessRepository });
  const app = express();
  app.use((request, _response, next) => { request.auth = JSON.parse(request.headers['x-auth']); next(); });
  app.get('/chave/:chave', (request, response, next) => requirePermission(request.params.chave)(request, response, next), (_request, response) => response.json({ ok: true }));
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const pedir = async (chave, uid, groupId) => (await fetch(`http://127.0.0.1:${servidor.address().port}/chave/${chave}`, {
    headers: { 'x-auth': JSON.stringify({ uid, adminOf: 'loja-1', groupId }) },
  })).status;
  try {
    for (const chave of TODAS_AS_CHAVES) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal(await pedir(chave, 'f-adm', 'g-adm'), 200, chave);
    }
    for (const chave of ['dashboard.view', 'finance.view', 'logs.view']) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal(await pedir(chave, 'f-caixa', 'g-caixa'), 403, chave);
    }
  } finally {
    servidor.closeAllConnections();
    servidor.close();
  }
});

test('E.2: no proxy de dados, o grupo Administrador grava o que pede chave (o restrito recebe 403)', async () => {
  const firestore = bancoDaLoja();
  const accessRepository = new FirestoreEstablishmentAccessRepository({ firestore });
  const policy = new ManagerDataAccessPolicy({ firestore });
  const contaDe = (uid, groupId) => accessRepository.findAccountByClaims({ uid, adminOf: 'loja-1', groupId });
  const mutacao = { operation: 'update', target: { path: 'estabelecimentos/loja-1' }, data: { name: 'Loja Um' } };
  await policy.assertMutation({ actor: await contaDe('f-adm', 'g-adm'), mutation: mutacao });
  await assert.rejects(
    policy.assertMutation({ actor: await contaDe('f-caixa', 'g-caixa'), mutation: mutacao }),
    (erro) => erro.statusCode === 403 && erro.code === 'permission_denied',
  );
});
