import assert from 'node:assert/strict';
import test from 'node:test';
import { ManageCoupons } from '../src/application/coupons/ManageCoupons.js';

const validPayload = {
  code: 'PROMO10',
  description: '10% em bebidas',
  termsText: 'Válido uma vez por CPF, não cumulativo com outras promoções.',
  firstPurchaseOnly: false,
  establishmentIds: ['empresa-1'],
  rules: [{ type: 'category', categoryIds: ['cat-bebidas'] }],
  discount: { kind: 'percentage', value: 10 },
  startAt: '2026-08-01T00:00:00.000Z',
  endAt: '2026-12-31T23:59:59.000Z',
  perCustomerLimit: 1,
  totalUsageLimit: 100,
  stackable: false,
};

test('createCoupon rejeita quem nao esta na allowlist de admin', async () => {
  const manager = createManager({ allowed: false });

  await assert.rejects(
    manager.createCoupon({ actorUid: 'uid-qualquer', ...validPayload }),
    (error) => error.code === 'coupon_admin_forbidden' && error.statusCode === 403,
  );
});

test('createCoupon normaliza o codigo para maiusculo e grava no repositorio', async () => {
  const created = [];
  const manager = createManager({ created });

  const result = await manager.createCoupon({
    actorUid: 'uid-admin',
    ...validPayload,
    code: 'promo10',
  });

  assert.equal(result.code, 'PROMO10');
  assert.equal(created[0].code, 'PROMO10');
  assert.equal(created[0].usageCount, 0);
  assert.equal(created[0].active, true);
});

test('createCoupon rejeita establishmentIds vazio', async () => {
  const manager = createManager({});

  await assert.rejects(
    manager.createCoupon({ actorUid: 'uid-admin', ...validPayload, establishmentIds: [] }),
    (error) => error.code === 'coupon_establishment_required' && error.statusCode === 400,
  );
});

test('createCoupon grava termsText e firstPurchaseOnly', async () => {
  const created = [];
  const manager = createManager({ created });

  await manager.createCoupon({ actorUid: 'uid-admin', ...validPayload, firstPurchaseOnly: true });

  assert.equal(created[0].termsText, validPayload.termsText);
  assert.equal(created[0].firstPurchaseOnly, true);
});

test('createCoupon aceita termsText ausente como null', async () => {
  const created = [];
  const manager = createManager({ created });
  const { termsText, ...payloadSemTermos } = validPayload;

  await manager.createCoupon({ actorUid: 'uid-admin', ...payloadSemTermos });

  assert.equal(created[0].termsText, null);
});

test('listCoupons retorna os cupons do repositorio para um admin', async () => {
  const manager = createManager({ coupons: [{ id: 'c1', code: 'PROMO10' }] });

  const result = await manager.listCoupons({ actorUid: 'uid-admin' });

  assert.deepEqual(result, [{ id: 'c1', code: 'PROMO10' }]);
});

test('deactivateCoupon marca active como false', async () => {
  const updated = [];
  const manager = createManager({
    coupons: [{ id: 'c1', code: 'PROMO10', active: true }],
    updated,
  });

  await manager.deactivateCoupon({ actorUid: 'uid-admin', couponId: 'c1' });

  assert.deepEqual(updated, [{ id: 'c1', patch: { active: false } }]);
});

test('deactivateCoupon rejeita cupom inexistente', async () => {
  const manager = createManager({ coupons: [] });

  await assert.rejects(
    manager.deactivateCoupon({ actorUid: 'uid-admin', couponId: 'nao-existe' }),
    (error) => error.code === 'coupon_not_found' && error.statusCode === 404,
  );
});

function createManager({ allowed = true, created = [], updated = [], coupons = [] } = {}) {
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
    adminAccessRepository: {
      isAdmin: async () => allowed,
    },
    clock: () => new Date('2026-08-10T12:00:00.000Z'),
  });
}
