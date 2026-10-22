import assert from 'node:assert/strict';
import test from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';
import { ManageCoupons } from '../src/application/coupons/ManageCoupons.js';

const validPayload = {
  code: 'PROMO10',
  description: '10% em bebidas',
  termsText: 'Válido uma vez por CPF, não cumulativo com outras promoções.',
  firstPurchaseOnly: false,
  rules: [{ type: 'category', categoryIds: ['cat-bebidas'] }],
  discount: { kind: 'percentage', value: 10 },
  startAt: '2026-08-01T00:00:00.000Z',
  endAt: '2026-12-31T23:59:59.000Z',
  perCustomerLimit: 1,
  totalUsageLimit: 100,
  stackable: false,
};

test('createCoupon rejeita ator sem estabelecimento vinculado', async () => {
  const manager = createManager({ hasEstablishment: false });

  await assert.rejects(
    manager.createCoupon({ actorUid: 'uid-sem-loja', ...validPayload }),
    (error) => error.code === 'coupon_no_establishment' && error.statusCode === 403,
  );
});

test('createCoupon grava establishmentIds com o estabelecimento do ator, ignorando qualquer valor no payload', async () => {
  const created = [];
  const manager = createManager({ created, establishmentId: 'loja-1' });

  const result = await manager.createCoupon({
    actorUid: 'uid-lojista',
    ...validPayload,
    establishmentIds: ['loja-2', 'loja-3'],
  });

  assert.deepEqual(created[0].establishmentIds, ['loja-1']);
  assert.equal(result.code, 'PROMO10');
});

test('createCoupon persiste o scopeName informado e null quando ausente', async () => {
  const created = [];
  const manager = createManager({ created });

  await manager.createCoupon({ actorUid: 'uid-lojista', ...validPayload, scopeName: '  Mercado  ' });
  await manager.createCoupon({ actorUid: 'uid-lojista', ...validPayload, code: 'OUTRO1' });

  assert.equal(created[0].scopeName, 'Mercado');
  assert.equal(created[1].scopeName, null);
});

test('createCoupon normaliza o codigo para maiusculo', async () => {
  const created = [];
  const manager = createManager({ created });

  await manager.createCoupon({ actorUid: 'uid-lojista', ...validPayload, code: 'promo10' });

  assert.equal(created[0].code, 'PROMO10');
  assert.equal(created[0].usageCount, 0);
  assert.equal(created[0].active, true);
});

test('createCoupon grava startAt/endAt/createdAt como Timestamp', async () => {
  const created = [];
  const manager = createManager({ created });

  await manager.createCoupon({ actorUid: 'uid-lojista', ...validPayload });

  assert.ok(created[0].startAt instanceof Timestamp);
  assert.ok(created[0].endAt instanceof Timestamp);
  assert.ok(created[0].createdAt instanceof Timestamp);
});

test('createCoupon rejeita codigo ja usado por cupom ativo do mesmo estabelecimento', async () => {
  const manager = createManager({
    coupons: [{ id: 'c1', code: 'PROMO10', active: true, establishmentIds: ['loja-1'] }],
  });

  await assert.rejects(
    manager.createCoupon({ actorUid: 'uid-lojista', ...validPayload }),
    (error) => error.code === 'coupon_code_already_exists' && error.statusCode === 409,
  );
});

test('createCoupon aceita codigo igual ao de um cupom desativado', async () => {
  const created = [];
  const manager = createManager({
    created,
    coupons: [{ id: 'c1', code: 'PROMO10', active: false, establishmentIds: ['loja-1'] }],
  });

  await manager.createCoupon({ actorUid: 'uid-lojista', ...validPayload });

  assert.equal(created[0].code, 'PROMO10');
});

test('listCoupons retorna so os cupons do estabelecimento do ator', async () => {
  const manager = createManager({
    establishmentId: 'loja-1',
    coupons: [
      { id: 'c1', code: 'DALOJA1', establishmentIds: ['loja-1'] },
      { id: 'c2', code: 'DALOJA2', establishmentIds: ['loja-2'] },
    ],
  });

  const result = await manager.listCoupons({ actorUid: 'uid-lojista' });

  assert.deepEqual(result.map((coupon) => coupon.code), ['DALOJA1']);
});

test('listCoupons rejeita ator sem estabelecimento vinculado', async () => {
  const manager = createManager({ hasEstablishment: false });

  await assert.rejects(
    manager.listCoupons({ actorUid: 'uid-sem-loja' }),
    (error) => error.code === 'coupon_no_establishment' && error.statusCode === 403,
  );
});

test('deactivateCoupon aceita cupom que pertence ao estabelecimento do ator', async () => {
  const updated = [];
  const manager = createManager({
    establishmentId: 'loja-1',
    updated,
    coupons: [{ id: 'c1', code: 'PROMO10', establishmentIds: ['loja-1'] }],
  });

  await manager.deactivateCoupon({ actorUid: 'uid-lojista', couponId: 'c1' });

  assert.deepEqual(updated, [{ id: 'c1', patch: { active: false } }]);
});

test('deactivateCoupon rejeita cupom que nao pertence ao estabelecimento do ator', async () => {
  const manager = createManager({
    establishmentId: 'loja-1',
    coupons: [{ id: 'c1', code: 'DEOUTRALOJA', establishmentIds: ['loja-2'] }],
  });

  await assert.rejects(
    manager.deactivateCoupon({ actorUid: 'uid-lojista', couponId: 'c1' }),
    (error) => error.code === 'coupon_establishment_forbidden' && error.statusCode === 403,
  );
});

test('deactivateCoupon rejeita cupom inexistente', async () => {
  const manager = createManager({ coupons: [] });

  await assert.rejects(
    manager.deactivateCoupon({ actorUid: 'uid-lojista', couponId: 'nao-existe' }),
    (error) => error.code === 'coupon_not_found' && error.statusCode === 404,
  );
});

test('updateCoupon aceita cupom que pertence ao estabelecimento do ator', async () => {
  const updated = [];
  const manager = createManager({
    establishmentId: 'loja-1',
    updated,
    coupons: [{ id: 'c1', code: 'PROMO10', establishmentIds: ['loja-1'] }],
  });

  await manager.updateCoupon({ actorUid: 'uid-lojista', couponId: 'c1', patch: { description: 'Nova descrição' } });

  assert.deepEqual(updated, [{ id: 'c1', patch: { description: 'Nova descrição' } }]);
});

test('updateCoupon rejeita cupom que nao pertence ao estabelecimento do ator', async () => {
  const manager = createManager({
    establishmentId: 'loja-1',
    coupons: [{ id: 'c1', code: 'DEOUTRALOJA', establishmentIds: ['loja-2'] }],
  });

  await assert.rejects(
    manager.updateCoupon({ actorUid: 'uid-lojista', couponId: 'c1', patch: {} }),
    (error) => error.code === 'coupon_establishment_forbidden' && error.statusCode === 403,
  );
});

test('updateCoupon converte startAt/endAt em Timestamp quando presentes no patch', async () => {
  const updated = [];
  const manager = createManager({
    establishmentId: 'loja-1',
    updated,
    coupons: [{ id: 'c1', code: 'PROMO10', establishmentIds: ['loja-1'] }],
  });

  await manager.updateCoupon({
    actorUid: 'uid-lojista',
    couponId: 'c1',
    patch: { startAt: '2026-08-01T00:00:00.000Z', endAt: '2026-12-31T23:59:59.000Z' },
  });

  assert.equal(updated.length, 1);
  assert.ok(updated[0].patch.startAt instanceof Timestamp);
  assert.ok(updated[0].patch.endAt instanceof Timestamp);
});

test('updateCoupon normaliza o codigo para maiusculo quando presente no patch', async () => {
  const updated = [];
  const manager = createManager({
    establishmentId: 'loja-1',
    updated,
    coupons: [{ id: 'c1', code: 'PROMO10', establishmentIds: ['loja-1'] }],
  });

  await manager.updateCoupon({ actorUid: 'uid-lojista', couponId: 'c1', patch: { code: 'novocodigo' } });

  assert.deepEqual(updated, [{ id: 'c1', patch: { code: 'NOVOCODIGO' } }]);
});

test('updateCoupon rejeita novo codigo ja usado por outro cupom ativo do mesmo estabelecimento', async () => {
  const manager = createManager({
    establishmentId: 'loja-1',
    coupons: [
      { id: 'c1', code: 'PROMO10', active: true, establishmentIds: ['loja-1'] },
      { id: 'c2', code: 'PROMO20', active: true, establishmentIds: ['loja-1'] },
    ],
  });

  await assert.rejects(
    manager.updateCoupon({ actorUid: 'uid-lojista', couponId: 'c1', patch: { code: 'promo20' } }),
    (error) => error.code === 'coupon_code_already_exists' && error.statusCode === 409,
  );
});

test('deleteCoupon exclui cupom sem uso registrado que pertence ao estabelecimento do ator', async () => {
  const deleted = [];
  const manager = createManager({
    establishmentId: 'loja-1',
    deleted,
    coupons: [{ id: 'c1', code: 'PROMO10', usageCount: 0, establishmentIds: ['loja-1'] }],
  });

  await manager.deleteCoupon({ actorUid: 'uid-lojista', couponId: 'c1' });

  assert.deepEqual(deleted, ['c1']);
});

test('deleteCoupon rejeita cupom com uso registrado', async () => {
  const deleted = [];
  const manager = createManager({
    establishmentId: 'loja-1',
    deleted,
    coupons: [{ id: 'c1', code: 'PROMO10', usageCount: 3, establishmentIds: ['loja-1'] }],
  });

  await assert.rejects(
    manager.deleteCoupon({ actorUid: 'uid-lojista', couponId: 'c1' }),
    (error) => error.code === 'coupon_has_usage' && error.statusCode === 409,
  );
  assert.deepEqual(deleted, []);
});

test('deleteCoupon rejeita cupom que nao pertence ao estabelecimento do ator', async () => {
  const manager = createManager({
    establishmentId: 'loja-1',
    coupons: [{ id: 'c1', code: 'DEOUTRALOJA', usageCount: 0, establishmentIds: ['loja-2'] }],
  });

  await assert.rejects(
    manager.deleteCoupon({ actorUid: 'uid-lojista', couponId: 'c1' }),
    (error) => error.code === 'coupon_establishment_forbidden' && error.statusCode === 403,
  );
});

test('deleteCoupon rejeita cupom inexistente', async () => {
  const manager = createManager({ coupons: [] });

  await assert.rejects(
    manager.deleteCoupon({ actorUid: 'uid-lojista', couponId: 'nao-existe' }),
    (error) => error.code === 'coupon_not_found' && error.statusCode === 404,
  );
});

function createManager({
  hasEstablishment = true,
  establishmentId = 'loja-1',
  created = [],
  updated = [],
  deleted = [],
  coupons = [],
  clientes = { 'cliente-9': 'uid-cliente-9' },
} = {}) {
  return new ManageCoupons({
    couponRepository: {
      create: async (coupon) => {
        created.push(coupon);
        return { id: 'novo-id', ...coupon };
      },
      list: async () => coupons,
      findById: async (id) => coupons.find((coupon) => coupon.id === id) || null,
      update: async (id, patch) => {
        updated.push({ id, patch });
      },
      delete: async (id) => {
        deleted.push(id);
      },
      findClienteDaLoja: async (userId) => (clientes[userId] ? { userId, userAuthId: clientes[userId] } : null),
    },
    accessRepository: {
      findAccountByUid: async () => (hasEstablishment ? { establishmentId, hasEstablishment: true } : null),
    },
    clock: () => new Date('2026-08-12T12:00:00.000Z'),
  });
}

test('C5.2: funcionario com coupons.manage (adminOf) usa a loja da conta da requisicao, nao a do dono', async () => {
  const { default: express } = await import('express');
  const { createCouponRoutes } = await import('../src/http/routes/couponRoutes.js');
  const { createPermissionGuard } = await import('../src/http/middlewares/requirePermission.js');
  const { errorHandler } = await import('../src/http/middlewares/errorHandler.js');
  const created = [];
  const updated = [];
  const coupons = [
    { id: 'c1', code: 'LOJA', active: true, establishmentIds: ['loja-func'] },
    { id: 'c2', code: 'OUTRA', active: true, establishmentIds: ['loja-outra'] },
  ];
  const manageCoupons = new ManageCoupons({
    couponRepository: {
      create: async (coupon) => { created.push(coupon); return { id: 'novo', ...coupon }; },
      list: async () => coupons,
      findById: async (id) => coupons.find((coupon) => coupon.id === id) || null,
      update: async (id, patch) => { updated.push({ id, patch }); },
      delete: async () => {},
    },
    // O funcionario nao e dono de loja: pelo uid nao acha nada.
    accessRepository: { findAccountByUid: async () => null },
  });
  const accessRepository = {
    findAccountByClaims: async ({ adminOf }) => (adminOf
      ? { establishmentId: adminOf, hasEstablishment: true, permissions: { isAdmin: false, keys: ['coupons.manage'] } }
      : null),
  };
  const { requirePermission, accountForRequest } = createPermissionGuard({ accessRepository });
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = { uid: 'func-1', adminOf: 'loja-func' }; next(); });
  app.use('/api/coupons', createCouponRoutes({ manageCoupons, requirePermission, accountForRequest }));
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const base = `http://127.0.0.1:${servidor.address().port}/api/coupons`;
    const lista = await (await fetch(base)).json();
    assert.deepEqual(lista.data.map((coupon) => coupon.id), ['c1']);
    const criado = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(validPayload) });
    assert.equal(criado.status, 201);
    assert.deepEqual(created[0].establishmentIds, ['loja-func']);
    const editado = await fetch(`${base}/c1`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: 'Nova' }) });
    assert.equal(editado.status, 200);
    const alheio = await fetch(`${base}/c2`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: 'X' }) });
    assert.equal(alheio.status, 403);
    assert.deepEqual(updated, [{ id: 'c1', patch: { description: 'Nova' } }]);
  } finally {
    servidor.close();
  }
});

test('D6: frete gratis sem desconto, sem data de fim, cupom pessoal e campaignId gravados no Coupons', async () => {
  const created = [];
  const manager = createManager({ created });
  await manager.createCoupon({
    actorUid: 'uid-lojista', ...validPayload, code: 'FRETE1', rules: [{ type: 'freight', freeShipping: true }],
    discount: null, endAt: null, targetClientId: 'cliente-9', campaignId: 'camp-1',
  });
  const [cupom] = created;
  assert.equal(cupom.discount, null);
  assert.equal(cupom.endAt, null);
  assert.equal(cupom.targetClientId, 'cliente-9');
  assert.equal(cupom.campaignId, 'camp-1');
  await manager.createCoupon({ actorUid: 'uid-lojista', ...validPayload, code: 'COMUM1' });
  assert.equal(created[1].targetClientId, null);
  assert.equal(created[1].campaignId, null);
  assert.ok(created[1].endAt instanceof Timestamp);
});

test('D6: a rota aceita frete gratis sem desconto e sem fim, e recusa cupom sem desconto e sem frete', async () => {
  const { default: express } = await import('express');
  const { createCouponRoutes } = await import('../src/http/routes/couponRoutes.js');
  const { errorHandler } = await import('../src/http/middlewares/errorHandler.js');
  const created = [];
  const manageCoupons = createManager({ created });
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = { uid: 'uid-lojista' }; next(); });
  app.use('/api/coupons', createCouponRoutes({
    manageCoupons,
    requirePermission: () => (_request, _response, next) => next(),
    accountForRequest: async () => ({ establishmentId: 'loja-1' }),
  }));
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const base = `http://127.0.0.1:${servidor.address().port}/api/coupons`;
    const enviar = (corpo) => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
    const { discount, endAt, ...semDescontoNemFim } = validPayload;
    assert.equal((await enviar({ ...semDescontoNemFim, code: 'FRETE2', rules: [{ type: 'freight', freeShipping: true }] })).status, 201);
    assert.equal(created[0].discount, null);
    assert.equal(created[0].endAt, null);
    assert.equal((await enviar({ ...semDescontoNemFim, code: 'NADA22', rules: [] })).status, 400);
    assert.equal((await enviar({ ...validPayload, code: 'PESSOA', targetClientId: 'cliente-9', campaignId: 'camp-1' })).status, 201);
    assert.equal(created[1].targetClientId, 'cliente-9');
  } finally {
    servidor.close();
  }
});

test('F3: leve N pague M e leve N por R$ X: a rota valida N, M e X e grava so a regra', async () => {
  const { default: express } = await import('express');
  const { createCouponRoutes } = await import('../src/http/routes/couponRoutes.js');
  const { errorHandler } = await import('../src/http/middlewares/errorHandler.js');
  const created = [];
  const manageCoupons = createManager({ created });
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = { uid: 'uid-lojista' }; next(); });
  app.use('/api/coupons', createCouponRoutes({
    manageCoupons,
    requirePermission: () => (_request, _response, next) => next(),
    accountForRequest: async () => ({ establishmentId: 'loja-1' }),
  }));
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const base = `http://127.0.0.1:${servidor.address().port}/api/coupons`;
    const { discount, ...semDesconto } = validPayload;
    const enviar = (regra, code) => fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...semDesconto, code, rules: [{ type: 'bundle', productId: 'suco', ...regra }] }),
    });
    assert.equal((await enviar({ quantity: 3, payQuantity: 2, repeat: true }, 'LEVE3P2')).status, 201);
    assert.equal((await enviar({ quantity: 3, bundlePrice: 12 }, 'LEVE3R12')).status, 201);
    assert.deepEqual(created[0].rules, [{ type: 'bundle', productId: 'suco', quantity: 3, payQuantity: 2, bundlePrice: null, repeat: true }]);
    assert.equal(created[0].discount, null);
    assert.deepEqual(created[1].rules[0], { type: 'bundle', productId: 'suco', quantity: 3, payQuantity: null, bundlePrice: 12, repeat: false });
    // Recusas: N = 1, N quebrado, M >= N, M = 0 (G3), X <= 0, os dois juntos, nenhum dos dois.
    for (const [regra, code] of [
      [{ quantity: 3, payQuantity: 0 }, 'MZERO'],
      [{ quantity: 1, payQuantity: 0 }, 'NUM1'], [{ quantity: 2.5, payQuantity: 1 }, 'NQUEBRA'],
      [{ quantity: 3, payQuantity: 3 }, 'MIGUALN'], [{ quantity: 3, bundlePrice: 0 }, 'XZERO'],
      [{ quantity: 3, payQuantity: 2, bundlePrice: 12 }, 'OSDOIS'], [{ quantity: 3 }, 'NENHUM'],
    ]) {
      assert.equal((await enviar(regra, code)).status, 400, code);
    }
    assert.equal(created.length, 2);
  } finally {
    servidor.close();
  }
});

test('versao 55: cupom para todos e para um cliente (destinatario com id do Users e userAuthId, uso unico)', async () => {
  const created = [];
  const manager = createManager({ created });
  await manager.createCoupon({ actorUid: 'uid-lojista', ...validPayload, code: 'TODOS1', tipo: 'todos', perCustomerLimit: 2, totalUsageLimit: 50 });
  assert.equal(created[0].tipo, 'todos');
  assert.equal(created[0].destinatario, null);
  assert.equal(created[0].targetClientId, null);
  assert.equal(created[0].perCustomerLimit, 2);

  await manager.createCoupon({ actorUid: 'uid-lojista', ...validPayload, code: 'SO-ANA', tipo: 'cliente', targetClientId: 'cliente-9', perCustomerLimit: 5, totalUsageLimit: 9 });
  assert.equal(created[1].tipo, 'cliente');
  assert.deepEqual(created[1].destinatario, { userId: 'cliente-9', userAuthId: 'uid-cliente-9' });
  assert.equal(created[1].targetClientId, 'cliente-9', 'o aplicarCupom de hoje compara targetClientId');
  assert.equal(created[1].perCustomerLimit, 1, 'uso unico');
  assert.equal(created[1].totalUsageLimit, 1);

  const recusa = (extra, codigo) => assert.rejects(
    manager.createCoupon({ actorUid: 'uid-lojista', ...validPayload, code: `X${created.length}`, ...extra }),
    (erro) => erro.code === codigo && erro.statusCode === 400,
  );
  await recusa({ tipo: 'cliente' }, 'coupon_destinatario_obrigatorio');
  await recusa({ tipo: 'cliente', targetClientId: 'nunca-comprou' }, 'coupon_destinatario_invalido');
  await recusa({ tipo: 'todos', targetClientId: 'cliente-9' }, 'coupon_tipo_invalido');
  assert.equal(created.length, 2, 'recusa nao cria');
});

test('versao 55: cupom pessoal nao muda o limite e, usado, nao e apagado', async () => {
  const pessoal = { id: 'c1', code: 'SO-ANA', tipo: 'cliente', establishmentIds: ['loja-1'], usageCount: 0, usadoEm: new Date('2026-10-20T12:00:00Z') };
  const updated = [];
  const deleted = [];
  const manager = createManager({ coupons: [pessoal], updated, deleted });
  await assert.rejects(manager.updateCoupon({ actorUid: 'uid', couponId: 'c1', patch: { perCustomerLimit: 3 } }), (erro) => erro.code === 'coupon_pessoal_uso_unico');
  await manager.updateCoupon({ actorUid: 'uid', couponId: 'c1', patch: { description: 'Só para a Ana' } });
  assert.equal(updated.length, 1);
  await assert.rejects(manager.deleteCoupon({ actorUid: 'uid', couponId: 'c1' }), (erro) => erro.code === 'coupon_has_usage');
  assert.equal(deleted.length, 0);
});

test('versao 55: destinatario so e cliente da loja quando o Users tem userAuthId e um pedido nela', async () => {
  const { FirestoreCouponRepository } = await import('../src/infra/firebase/FirestoreCouponRepository.js');
  const { FirestoreEmMemoria } = await import('./apoio/firestoreEmMemoria.js');
  const banco = new FirestoreEmMemoria({
    'Users/u-ana': { userAuthId: 'uid-ana' },
    'Users/u-sem-login': {},
    'Users/u-bia': { userAuthId: 'uid-bia' },
    'estabelecimentos/loja-1': { name: 'Loja 1' },
    'estabelecimentos/loja-2': { name: 'Loja 2' },
  });
  banco.docs.set('PurchaseRequests/p1', { clientId: 'u-ana', companyReference: banco.collection('estabelecimentos').doc('loja-1') });
  banco.docs.set('PurchaseRequests/p2', { clientId: 'u-bia', companyReference: banco.collection('estabelecimentos').doc('loja-2') });
  const repositorio = new FirestoreCouponRepository({ firestore: banco });
  assert.deepEqual(await repositorio.findClienteDaLoja('u-ana', 'loja-1'), { userId: 'u-ana', userAuthId: 'uid-ana' });
  assert.equal(await repositorio.findClienteDaLoja('u-bia', 'loja-1'), null, 'cliente de outra loja');
  assert.equal(await repositorio.findClienteDaLoja('u-sem-login', 'loja-1'), null);
  assert.equal(await repositorio.findClienteDaLoja('nao-existe', 'loja-1'), null);
});

test('RP-14: busca de clientes da loja para o cupom pessoal, com telefone mascarado', async () => {
  const { telefoneMascarado } = await import('../src/application/coupons/ManageCoupons.js');
  assert.equal(telefoneMascarado('(27) 99876-5432'), '(27) *****-5432');
  assert.equal(telefoneMascarado('+55 27 3333-4444'), '(27) ****-4444');
  assert.equal(telefoneMascarado('12'), null);
  assert.equal(telefoneMascarado(''), null);

  const manager = createManager();
  manager.couponRepository.listClientesDaLoja = async () => [
    { userId: 'u3', nome: 'Zé Pereira', telefone: '' },
    { userId: 'u1', nome: 'Ana Souza', telefone: '27998765432' },
    { userId: 'u2', nome: 'Antônio Lima', telefone: '27991112222' },
  ];
  const todos = await manager.buscarClientes({ actorUid: 'uid' });
  assert.deepEqual(todos.map((cliente) => cliente.nome), ['Ana Souza', 'Antônio Lima', 'Zé Pereira']);
  assert.deepEqual(todos[0], { userId: 'u1', nome: 'Ana Souza', telefone: '(27) *****-5432' });
  assert.equal(todos[2].telefone, null);
  assert.deepEqual((await manager.buscarClientes({ actorUid: 'uid', busca: 'antonio' })).map((c) => c.userId), ['u2']);
  assert.deepEqual((await manager.buscarClientes({ actorUid: 'uid', busca: '5432' })).map((c) => c.userId), ['u1']);
  assert.ok(!JSON.stringify(todos).includes('98765432'), 'telefone inteiro nunca sai');
});

test('RP-14: repositorio le o ResumoClientes da loja; sem resumo, os pedidos dela', async () => {
  const { FirestoreCouponRepository } = await import('../src/infra/firebase/FirestoreCouponRepository.js');
  const { FirestoreEmMemoria } = await import('./apoio/firestoreEmMemoria.js');
  const comResumo = new FirestoreEmMemoria({
    'estabelecimentos/loja-1/ResumoClientes/00': { clientes: { 'u-ana': { userId: 'u-ana', nome: 'Ana', telefone: '27998765432' }, 'name:sem id': { userId: null, nome: 'Sem id' } } },
    'estabelecimentos/loja-1/ResumoClientes/07': { clientes: { 'u-bia': { userId: 'u-bia', nome: 'Bia', telefone: '' } } },
  });
  const lidos = await new FirestoreCouponRepository({ firestore: comResumo }).listClientesDaLoja('loja-1');
  assert.deepEqual(lidos.map((cliente) => cliente.userId).sort(), ['u-ana', 'u-bia']);

  const semResumo = new FirestoreEmMemoria({ 'estabelecimentos/loja-2': { name: 'Loja 2' } });
  const loja2 = semResumo.collection('estabelecimentos').doc('loja-2');
  semResumo.docs.set('PurchaseRequests/p1', { clientId: 'u-cai', clientName: 'Caio', clientePhoneNumber: '27911112222', companyReference: loja2 });
  semResumo.docs.set('PurchaseRequests/p2', { clientId: 'u-cai', clientName: 'Caio', companyReference: loja2 });
  semResumo.docs.set('PurchaseRequests/p3', { clientId: 'u-outra', clientName: 'Outra', companyReference: semResumo.collection('estabelecimentos').doc('loja-9') });
  assert.deepEqual(await new FirestoreCouponRepository({ firestore: semResumo }).listClientesDaLoja('loja-2'),
    [{ userId: 'u-cai', nome: 'Caio', telefone: '27911112222' }]);
});

test('RP-14: rota GET /api/coupons/clientes pede a permissao de cupons', async () => {
  const { default: express } = await import('express');
  const { createCouponRoutes } = await import('../src/http/routes/couponRoutes.js');
  const { errorHandler } = await import('../src/http/middlewares/errorHandler.js');
  const { AppError } = await import('../src/domain/errors/AppError.js');
  const manager = createManager();
  manager.couponRepository.listClientesDaLoja = async () => [{ userId: 'u1', nome: 'Ana', telefone: '27998765432' }];
  const app = express();
  app.use((request, _response, next) => { request.auth = { uid: 'uid' }; next(); });
  app.use('/api/coupons', createCouponRoutes({
    manageCoupons: manager,
    requirePermission: (chave) => (request, _response, next) => next(
      String(request.headers['x-chaves'] || '').split(',').includes(chave) ? undefined : new AppError('sem', { statusCode: 403, code: 'permission_denied' }),
    ),
    accountForRequest: async () => ({ establishmentId: 'loja-1' }),
  }));
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}/api/coupons/clientes`;
  try {
    assert.equal((await fetch(`${base}?busca=ana`, { headers: { 'x-chaves': 'requests.view' } })).status, 403);
    const ok = await fetch(`${base}?busca=ana`, { headers: { 'x-chaves': 'coupons.manage' } });
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).data, [{ userId: 'u1', nome: 'Ana', telefone: '(27) *****-5432' }]);
  } finally {
    servidor.closeAllConnections();
    servidor.close();
  }
});
