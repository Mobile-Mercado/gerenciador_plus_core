const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildAggregateDeltas,
  contributionFromOrder,
} = require('./hourlySalesAggregation');

function timestamp(date) {
  return { toDate: () => new Date(date) };
}

function order(overrides = {}) {
  return {
    companyId: 'store-1',
    currentPurchaseStatus: 'PurchaseStatus.accepted',
    createdAt: timestamp('2026-07-28T15:30:00.000Z'),
    totalPrice: 125.5,
    ...overrides,
  };
}

test('creates an App contribution in the Sao Paulo hour', () => {
  assert.deepEqual(contributionFromOrder(order()), {
    companyId: 'store-1',
    channel: 'app',
    amount: 125.5,
    hourKey: 'h12',
    dateId: '28-07-2026',
    monthId: '01-07-2026',
    yearId: 'sales-2026',
    year: 2026,
    month: 7,
  });
});

test('recognizes orders created by the sales agent', () => {
  const contribution = contributionFromOrder(order({ agentOrder: true }));
  assert.equal(contribution.channel, 'agent');
});

test('does not aggregate pending or canceled orders', () => {
  assert.equal(contributionFromOrder(order({ currentPurchaseStatus: 'pending' })), null);
  assert.equal(contributionFromOrder(order({ currentPurchaseStatus: 'canceled' })), null);
});

test('compensates the previous channel when an order changes origin', () => {
  const previous = contributionFromOrder(order());
  const current = contributionFromOrder(order({ agentOrder: true }));
  const targets = buildAggregateDeltas(previous, current);

  assert.equal(targets.length, 2);
  targets.forEach((target) => {
    assert.equal(target.fields.get('hourlySales.app.h12'), -125.5);
    assert.equal(target.fields.get('hourlySales.agent.h12'), 125.5);
  });
});

test('subtracts a sale when a confirmed order is canceled', () => {
  const previous = contributionFromOrder(order());
  const targets = buildAggregateDeltas(previous, null);

  assert.equal(targets.length, 2);
  targets.forEach((target) => {
    assert.equal(target.fields.get('hourlySales.app.h12'), -125.5);
  });
});
