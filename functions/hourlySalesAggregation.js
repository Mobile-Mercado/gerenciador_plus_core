const TIME_ZONE = 'America/Sao_Paulo';
const AGGREGATION_VERSION = 1;

const CONFIRMED_STATUSES = new Set([
  'accepted',
  'picking',
  'separatingorder',
  'waitingfordelivery',
  'waiting',
  'deliveryroute',
  'on_route',
  'completed',
  'delivered',
]);

function normalizeStatus(value) {
  return String(value || '')
    .replace(/^PurchaseStatus\./i, '')
    .trim()
    .toLowerCase();
}

function isConfirmedStatus(value) {
  return CONFIRMED_STATUSES.has(normalizeStatus(value));
}

function extractCompanyId(order = {}) {
  if (order.companyId) return String(order.companyId);
  const reference = order.companyReference || order.companyRef;
  if (!reference) return null;
  if (typeof reference === 'string') {
    return reference.split('/').filter(Boolean).at(-1) || null;
  }
  if (reference.id) return String(reference.id);
  if (reference.path) return String(reference.path).split('/').filter(Boolean).at(-1) || null;
  if (Array.isArray(reference._path?.segments)) {
    return reference._path.segments.at(-1) || null;
  }
  return null;
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === 'function') return value.toDate();
  if (typeof value.seconds === 'number') return new Date(value.seconds * 1000);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;
  const cleaned = value.replace(/[^\d,.-]/g, '');
  const normalized = cleaned.includes(',')
    ? cleaned.replaceAll('.', '').replace(',', '.')
    : cleaned;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nestedValue(source, paths) {
  for (const path of paths) {
    const value = path.split('.').reduce((current, key) => current?.[key], source);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function itemTotal(item = {}) {
  const explicit = nestedValue(item, ['total', 'totalPrice', 'subtotal', 'amount']);
  if (explicit !== null) return toNumber(explicit);
  const quantity = toNumber(item.quantity) || 1;
  const price = toNumber(nestedValue(item, [
    'price',
    'currentPrice',
    'unitPrice',
    'product.price',
    'product.currentPrice',
  ]));
  return quantity * price;
}

function orderTotal(order = {}) {
  const explicit = nestedValue(order, [
    'total',
    'totalPrice',
    'totalValue',
    'orderTotal',
    'priceTotal',
    'cartTotal',
    'amount',
    'payment.total',
    'payment.amount',
    'summary.total',
  ]);
  if (explicit !== null) return toNumber(explicit);

  const items = Array.isArray(order.productsCart)
    ? order.productsCart
    : Array.isArray(order.items)
      ? order.items
      : [];
  return items.reduce((sum, item) => sum + itemTotal(item), 0);
}

function orderChannel(order = {}) {
  if (order.agentOrder || order.isAgentOrder || order.createdByAgent || order.fromAgent) {
    return 'agent';
  }

  const source = String(nestedValue(order, [
    'channel',
    'source',
    'origin',
    'platform',
    'orderChannel',
    'purchaseOrigin',
    'createdBy',
  ]) || '').toLowerCase();

  return /(agent|agente|whatsapp|chat|ia)/.test(source) ? 'agent' : 'app';
}

function zonedParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value || '';
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
  };
}

function contributionFromOrder(order = {}) {
  const status = order.currentPurchaseStatus
    || order.purchaseStatus
    || order.status
    || order.stats;
  if (!isConfirmedStatus(status)) return null;

  const companyId = extractCompanyId(order);
  const soldAt = toDate(order.paidAt || order.acceptedAt || order.createdAt);
  if (!companyId || !soldAt) return null;

  const parts = zonedParts(soldAt);
  return {
    companyId,
    channel: orderChannel(order),
    amount: orderTotal(order),
    hourKey: `h${parts.hour}`,
    dateId: `${parts.day}-${parts.month}-${parts.year}`,
    monthId: `01-${parts.month}-${parts.year}`,
    yearId: `sales-${parts.year}`,
    year: Number(parts.year),
    month: Number(parts.month),
  };
}

function normalizeStoredContribution(data) {
  if (!data?.companyId || !data?.channel || !data?.hourKey) return null;
  return {
    companyId: String(data.companyId),
    channel: data.channel === 'agent' ? 'agent' : 'app',
    amount: toNumber(data.amount),
    hourKey: String(data.hourKey),
    dateId: String(data.dateId || ''),
    monthId: String(data.monthId || ''),
    yearId: String(data.yearId || ''),
    year: Number(data.year) || 0,
    month: Number(data.month) || 0,
  };
}

function contributionFingerprint(contribution) {
  if (!contribution) return '';
  return [
    contribution.companyId,
    contribution.channel,
    contribution.amount,
    contribution.hourKey,
    contribution.dateId,
    contribution.monthId,
    contribution.yearId,
  ].join('|');
}

function appendDelta(targets, contribution, direction) {
  if (!contribution || !contribution.monthId || !contribution.yearId) return;
  const delta = direction * contribution.amount;
  if (!delta) return;

  const fieldPath = `hourlySales.${contribution.channel}.${contribution.hourKey}`;
  const monthKey = `${contribution.companyId}/MonthlyStats/${contribution.monthId}`;
  const yearKey = `${contribution.companyId}/Stats/${contribution.yearId}`;

  for (const [key, period, periodId] of [
    [monthKey, 'month', contribution.monthId],
    [yearKey, 'year', contribution.yearId],
  ]) {
    if (!targets.has(key)) {
      targets.set(key, {
        companyId: contribution.companyId,
        period,
        periodId,
        year: contribution.year,
        month: period === 'month' ? contribution.month : null,
        fields: new Map(),
      });
    }
    const target = targets.get(key);
    target.fields.set(fieldPath, (target.fields.get(fieldPath) || 0) + delta);
  }
}

function buildAggregateDeltas(previous, current) {
  const targets = new Map();
  appendDelta(targets, previous, -1);
  appendDelta(targets, current, 1);
  return [...targets.values()].filter((target) =>
    [...target.fields.values()].some((delta) => Math.abs(delta) > Number.EPSILON),
  );
}

function aggregateReference(db, target) {
  return db
    .collection('estabelecimentos')
    .doc(target.companyId)
    .collection(target.period === 'month' ? 'MonthlyStats' : 'Stats')
    .doc(target.periodId);
}

async function reconcileOrderHourlySales({ db, FieldValue, orderRef }) {
  const contributionRef = db.collection('OrderSalesContributions').doc(orderRef.id);

  return db.runTransaction(async (transaction) => {
    const [orderSnapshot, contributionSnapshot] = await Promise.all([
      transaction.get(orderRef),
      transaction.get(contributionRef),
    ]);
    const previous = contributionSnapshot.exists
      ? normalizeStoredContribution(contributionSnapshot.data())
      : null;
    const current = orderSnapshot.exists
      ? contributionFromOrder(orderSnapshot.data())
      : null;

    if (contributionFingerprint(previous) === contributionFingerprint(current)) {
      return { changed: false };
    }

    const deltas = buildAggregateDeltas(previous, current);
    deltas.forEach((target) => {
      const update = {
        hourlySalesVersion: AGGREGATION_VERSION,
        hourlySalesPeriod: target.period,
        hourlySalesYear: target.year,
        hourlySalesUpdatedAt: FieldValue.serverTimestamp(),
        hourlySales: {},
      };
      if (target.month) update.hourlySalesMonth = target.month;
      target.fields.forEach((delta, fieldPath) => {
        const [, channel, hourKey] = fieldPath.split('.');
        if (!update.hourlySales[channel]) update.hourlySales[channel] = {};
        update.hourlySales[channel][hourKey] = FieldValue.increment(delta);
      });
      transaction.set(aggregateReference(db, target), update, { merge: true });
    });

    if (current) {
      transaction.set(contributionRef, {
        ...current,
        orderPath: orderRef.path,
        aggregationVersion: AGGREGATION_VERSION,
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else if (contributionSnapshot.exists) {
      transaction.delete(contributionRef);
    }

    return { changed: true, targets: deltas.length };
  });
}

async function handleOrderHourlySalesWrite({ db, FieldValue, event }) {
  const orderRef = event.data?.after?.ref || event.data?.before?.ref;
  if (!orderRef) return { changed: false };
  return reconcileOrderHourlySales({ db, FieldValue, orderRef });
}

module.exports = {
  AGGREGATION_VERSION,
  TIME_ZONE,
  buildAggregateDeltas,
  contributionFingerprint,
  contributionFromOrder,
  handleOrderHourlySalesWrite,
  isConfirmedStatus,
  normalizeStoredContribution,
  orderChannel,
  orderTotal,
  reconcileOrderHourlySales,
};
