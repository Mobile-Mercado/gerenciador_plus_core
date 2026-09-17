import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPermission, createPermissionGuard } from '../src/http/middlewares/requirePermission.js';
import { ManagerDataAccessPolicy, permissionKeyForMutation } from '../src/infra/firebase/ManagerDataAccessPolicy.js';

const OWNER = { isAdmin: true, groupId: null, keys: [] };
const VENDEDOR = { isAdmin: false, groupId: 'g-1', keys: ['requests.update_status', 'products.edit'] };

function requisicao({ uid = 'uid-1', token = 'token-1', exp, adminOf, groupId } = {}) {
  return {
    headers: { authorization: `Bearer ${token}` },
    auth: {
      uid, exp, adminOf, groupId,
    },
  };
}

function repositorio(account, registro = { chamadas: 0 }) {
  return {
    registro,
    async findAccountByClaims() {
      registro.chamadas += 1;
      if (account instanceof Error) throw account;
      return account;
    },
  };
}

async function rodar(middleware, request) {
  return new Promise((resolve) => {
    middleware(request, {}, (error) => resolve(error));
  });
}

test('isAdmin passa em qualquer chave', () => {
  assertPermission(OWNER, 'products.delete');
  assertPermission(OWNER, 'settings.edit');
});

test('chave presente no grupo passa', () => {
  assertPermission(VENDEDOR, 'products.edit');
});

test('chave ausente responde 403 permission_denied com a chave que faltou', () => {
  assert.throws(
    () => assertPermission(VENDEDOR, 'products.delete'),
    (error) => error.statusCode === 403
      && error.code === 'permission_denied'
      && error.details.key === 'products.delete',
  );
});

test('middleware libera quem tem a chave e barra quem nao tem', async () => {
  const accessRepository = repositorio({ hasEstablishment: true, permissions: VENDEDOR });
  const { requirePermission } = createPermissionGuard({ accessRepository });

  assert.equal(await rodar(requirePermission('products.edit'), requisicao()), undefined);

  const erro = await rodar(requirePermission('coupons.manage'), requisicao({ token: 'token-2' }));
  assert.equal(erro.code, 'permission_denied');
  assert.equal(erro.details.key, 'coupons.manage');
});

test('funcionario desativado nao passa: o repositorio responde 403 admin_user_disabled', async () => {
  const desativado = Object.assign(new Error('desativado'), {
    statusCode: 403,
    code: 'admin_user_disabled',
  });
  const { requirePermission } = createPermissionGuard({ accessRepository: repositorio(desativado) });

  const erro = await rodar(requirePermission('products.edit'), requisicao({ adminOf: 'store-1', groupId: 'g-1' }));
  assert.equal(erro.code, 'admin_user_disabled');
  assert.equal(erro.statusCode, 403);
});

test('conta sem estabelecimento nao passa pela barreira', async () => {
  const { requirePermission } = createPermissionGuard({ accessRepository: repositorio(null) });
  const erro = await rodar(requirePermission('products.edit'), requisicao());
  assert.equal(erro.code, 'data_establishment_required');
});

test('cache por token dura a vida do token', async () => {
  const registro = { chamadas: 0 };
  const accessRepository = repositorio({ hasEstablishment: true, permissions: VENDEDOR }, registro);
  let agora = 1_000_000;
  const { requirePermission } = createPermissionGuard({ accessRepository, clock: () => agora });
  const guarda = requirePermission('products.edit');
  const pedido = requisicao({ exp: (agora + 60_000) / 1000 });

  await rodar(guarda, pedido);
  await rodar(guarda, pedido);
  assert.equal(registro.chamadas, 1);

  agora += 120_000;
  await rodar(guarda, pedido);
  assert.equal(registro.chamadas, 2);
});

test('mapa de chaves por escrita', () => {
  const chave = (mutation) => permissionKeyForMutation(mutation, 'store-1');
  assert.equal(chave({ operation: 'update', target: { path: 'PurchaseRequests/p1' }, data: { currentPurchaseStatus: 'canceled' } }), 'requests.cancel');
  assert.equal(chave({ operation: 'update', target: { path: 'PurchaseRequests/p1' }, data: { currentPurchaseStatus: 'PurchaseStatus.giveUp' } }), 'requests.cancel');
  assert.equal(chave({ operation: 'update', target: { path: 'PurchaseRequests/p1' }, data: { separatedAt: 1 } }), 'requests.update_status');
  assert.equal(chave({ operation: 'set', target: { path: 'estabelecimentos/store-1/Products/p1' }, data: { name: 'x' } }), 'products.create');
  assert.equal(chave({ operation: 'update', target: { path: 'estabelecimentos/store-1/Products/p1' }, data: { price: 10 } }), 'products.edit_price');
  assert.equal(chave({ operation: 'update', target: { path: 'estabelecimentos/store-1/Products/p1' }, data: { isTrashed: true } }), 'products.delete');
  assert.equal(chave({ operation: 'update', target: { path: 'estabelecimentos/store-1/Products/p1' }, data: { name: 'x' } }), 'products.edit');
  assert.equal(chave({ operation: 'set', target: { path: 'estabelecimentos/store-1/implantacaoGrenciador/categorizadorSugestoes_1' }, data: {} }), 'products.edit');
  assert.equal(chave({ operation: 'update', target: { path: 'estabelecimentos/store-1/ProductCategories/c1' }, data: {} }), 'products.edit');
  assert.equal(chave({ operation: 'set', target: { path: 'Chats/c1/Messages/m1' }, data: {} }), 'chat.send');
  assert.equal(chave({ operation: 'update', target: { path: 'estabelecimentos/store-1' }, data: { name: 'Loja' } }), 'settings.edit');
  assert.equal(chave({ operation: 'update', target: { path: 'estabelecimentos/store-1/paymentMethods/pix' }, data: {} }), 'settings.edit');
  assert.equal(chave({ operation: 'set', target: { path: 'estabelecimentos/store-1/Cupons/k1' }, data: {} }), 'coupons.manage');
  assert.equal(chave({ operation: 'update', target: { path: 'Users/u1' }, data: { isTestAccount: true } }), 'requests.update_status');
});

test('a politica barra a escrita sem a chave e deixa passar com ela', async () => {
  const policy = new ManagerDataAccessPolicy({ firestore: {} });
  const ator = (permissions) => ({
    uid: 'uid-1', userId: 'store-1', establishmentId: 'store-1', hasEstablishment: true, permissions,
  });
  const mutation = {
    operation: 'update',
    target: { kind: 'document', path: 'estabelecimentos/store-1/Products/p1' },
    data: { price: 12 },
    options: { merge: false },
  };

  await policy.assertMutation({ actor: ator(OWNER), mutation });
  await assert.rejects(
    policy.assertMutation({ actor: ator(VENDEDOR), mutation }),
    (error) => error.code === 'permission_denied' && error.details.key === 'products.edit_price',
  );
  await policy.assertMutation({
    actor: ator({ isAdmin: false, groupId: 'g-1', keys: ['products.edit_price'] }),
    mutation,
  });
});
