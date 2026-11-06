// Cola RP-52, item 3.2: dinheiro dos resumos em centavos ao gravar. Caso que dava diferenca no
// codigo de antes: 3 itens de R$ 0,335 somavam 1.0050000000000001 (sem arredondar) ou 1.01 (com
// o arredondamento so no fim); pela regra combinada, cada item vira 0,34 e a soma, 1,02.
const test = require('node:test');
const assert = require('node:assert/strict');
const { arredondarCentavos, emCentavos, semRuido } = require('./centavos');
const { buildAggregateDeltas, contributionFromOrder, orderTotal } = require('./hourlySalesAggregation');
const { resumirPedido, getOrderTotal } = require('./resumoPedidos');
const { resumirCliente } = require('./resumoClientes');
const { classificarPedido } = require('./resumoDoMes');
const { salesFromOrders, summarizeSales } = require('./productImageFileCheck');

const ts = (iso) => ({ toDate: () => new Date(iso) });
const TRES_ITENS = [
  { quantity: 1, price: 0.335 },
  { quantity: 1, price: 0.335 },
  { quantity: 1, price: 0.335 },
];
const SOMA_CRUA = 0.335 + 0.335 + 0.335;

test('centavos: protecao contra ruido, negativo e valor que nao e numero', () => {
  assert.equal(SOMA_CRUA, 1.0050000000000001, 'soma crua de antes');
  assert.equal(Math.round(SOMA_CRUA * 100) / 100, 1.01, 'arredondar so no fim, como antes');
  assert.equal(arredondarCentavos(1.005), 1.01, '1.005 * 100 da 100.49999999999999; o toFixed(6) tira o ruido');
  assert.equal(arredondarCentavos(138.04800000000003), 138.05);
  assert.equal(arredondarCentavos(0.1 + 0.2), 0.3);
  assert.equal(arredondarCentavos(-4.905), -4.91);
  assert.equal(emCentavos(0.335), 34);
  assert.equal(arredondarCentavos(Number.NaN), 0);
  assert.equal(semRuido(10.25 - 10.1), 0.15, 'tira o ruido da subtracao');
  assert.equal(semRuido(138.04800000000003 - 138.05), -0.002, 'fracao de centavo de verdade fica');
});

test('hourlySales: total somado dos itens em centavos, item por item, e total direto arredondado', () => {
  assert.equal(orderTotal({ productsCart: TRES_ITENS }), 1.02);
  assert.equal(orderTotal({ totalPrice: 138.04800000000003 }), 138.05);
  const pedido = {
    companyId: 'store-1',
    currentPurchaseStatus: 'PurchaseStatus.accepted',
    createdAt: ts('2026-07-28T15:30:00.000Z'),
    productsCart: TRES_ITENS,
  };
  assert.equal(contributionFromOrder(pedido).amount, 1.02);
});

test('hourlySales: o increment tira a contribuicao antiga como foi somada e poe a nova em centavos', () => {
  const base = {
    companyId: 'store-1',
    currentPurchaseStatus: 'PurchaseStatus.accepted',
    createdAt: ts('2026-07-28T15:30:00.000Z'),
  };
  // Contribuicao guardada antes desta regra, com sobra de casas.
  const antiga = { ...contributionFromOrder({ ...base, totalPrice: 138.05 }), amount: 138.04800000000003 };
  const nova = contributionFromOrder({ ...base, totalPrice: 138.04800000000003 });
  assert.equal(nova.amount, 138.05);
  buildAggregateDeltas(antiga, nova).forEach((alvo) => {
    assert.equal(alvo.fields.get('hourlySales.app.h12'), 0.002);
  });
  // As duas em centavos: o delta sai limpo (sem semRuido seria 0.15000000000000036).
  const deltas = buildAggregateDeltas(
    contributionFromOrder({ ...base, totalPrice: 10.1 }),
    contributionFromOrder({ ...base, totalPrice: 10.25 }),
  );
  deltas.forEach((alvo) => assert.equal(alvo.fields.get('hourlySales.app.h12'), 0.15));
});

test('ResumoPedidos: total, total dos itens e price em centavos', () => {
  assert.equal(getOrderTotal({ productsCart: TRES_ITENS }), 1.02);
  const resumo = resumirPedido('ped-1', {
    createdAt: ts('2026-09-10T15:20:00Z'),
    total: 138.04800000000003,
    price: 133.04800000000003,
  });
  assert.equal(resumo.total, 138.05);
  assert.equal(resumo.price, 133.05);
  assert.equal(resumirPedido('ped-2', { productsCart: TRES_ITENS }).total, 1.02);
});

test('ResumoClientes: total de cada pedido e LTV em centavos', () => {
  const pedido = (extra) => ({
    clientId: 'cliente-1',
    currentPurchaseStatus: 'PurchaseStatus.completed',
    createdAt: ts('2026-09-10T15:20:00Z'),
    ...extra,
  });
  assert.equal(resumirCliente({ pedidos: [pedido({ productsCart: TRES_ITENS })] }).ltv, 1.02);
  assert.equal(0.1 + 0.2, 0.30000000000000004, 'soma crua de antes');
  assert.equal(resumirCliente({ pedidos: [pedido({ total: 0.1 }), pedido({ total: 0.2 })] }).ltv, 0.3);
});

test('Resumo do mes: cada item em centavos antes de somar no grupo', () => {
  const meta = { produtos: new Map(), categorias: new Map(), prateleiras: new Map() };
  const item = (id) => ({ id, quantity: 1, product: { price: 0.335 } });
  const { resumoPorGrupo } = classificarPedido({ productsCart: [item('i1'), item('i2'), item('i3')] }, meta);
  assert.equal(resumoPorGrupo.pet_e_outros, 1.02, 'antes: 1.01');
  // Pesado: soma das medidas vezes o preco, arredondado uma vez.
  const pesado = { id: 'i1', product: { price: 47.9 }, separated: { measures: [1.234, 1.648] } };
  assert.equal((1.234 + 1.648) * 47.9, 138.04779999999997);
  assert.equal(classificarPedido({ productsCart: [pesado] }, meta).resumoPorGrupo.pet_e_outros, 138.05);
});

test('faturamento dos bloqueados: cada item em centavos antes de somar', () => {
  const pedido = {
    currentPurchaseStatus: 'PurchaseStatus.completed',
    createdAt: { toDate: () => new Date() },
    productsCart: [1, 2, 3].map(() => ({ productRef: { id: 'a' }, quantity: 1, product: { price: 0.335 } })),
  };
  const vendas = salesFromOrders([pedido]);
  assert.equal(vendas.byProduct.get('a').vendas30.valor, 1.02, 'antes: 1.0050000000000001');
  const resumo = summarizeSales(vendas, [{ id: 'a', product: { isActive: false } }]);
  assert.equal(resumo.vendas30.faturamentoDosBloqueados, 1.02, 'antes: 1.01');
});
