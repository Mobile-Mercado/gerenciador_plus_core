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

function createManager({
  hasEstablishment = true,
  establishmentId = 'loja-1',
  created = [],
  updated = [],
  coupons = [],
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
    },
    accessRepository: {
      findAccountByUid: async () => (hasEstablishment ? { establishmentId, hasEstablishment: true } : null),
    },
    clock: () => new Date('2026-08-12T12:00:00.000Z'),
  });
}
