// Cola do Thay B57-03 (18/11), item C1, e B57-03c (19/11), item 5: a prateleira "MAIS VENDIDOS NA
// LOJA" de "Minhas compras" vazia, no app usuario, vem de uma rota nova no Core que soma os pedidos
// dos ultimos 30 dias, so da loja. Sem dados suficientes, o app mostra os Destaques do dia.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DIAS_DOS_MAIS_VENDIDOS,
  LIMITE_DOS_MAIS_VENDIDOS,
  MaisVendidosDaLoja,
} from '../src/application/app/MaisVendidosDaLoja.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

const AGORA = new Date('2026-11-19T15:00:00Z');
const DIA = 24 * 60 * 60 * 1000;

function diasAtras(dias) {
  return new Date(AGORA.getTime() - dias * DIA);
}

async function montar(pedidos) {
  const banco = new FirestoreEmMemoria({});
  const loja = (id) => banco.collection('estabelecimentos').doc(id);
  for (const [id, pedido] of Object.entries(pedidos(loja))) {
    await banco.collection('PurchaseRequests').doc(id).set(pedido);
  }
  return { banco, mais: new MaisVendidosDaLoja({ firestore: banco, clock: () => AGORA.getTime() }) };
}

function item(produto, quantidade) {
  return { productReference: `estabelecimentos/loja-a/Products/${produto}`, quantity: quantidade, price: 5 };
}

test('C1: soma as quantidades dos pedidos de venda dos ultimos 30 dias, so da loja, do mais vendido para o menos', async () => {
  const { banco, mais } = await montar((loja) => ({
    p1: { companyReference: loja('loja-a'), currentPurchaseStatus: 'completed', createdAt: diasAtras(2), productsCart: [item('arroz', 2), item('feijao', 1)] },
    p2: { companyReference: loja('loja-a'), currentPurchaseStatus: 'delivered', createdAt: diasAtras(29), productsCart: [item('feijao', 3)] },
    p3: { companyReference: loja('loja-a'), currentPurchaseStatus: 'accepted', createdAt: diasAtras(1), productsCart: [item('cafe', 1)] },
    // Fora: mais de 30 dias, outra loja, pedido de teste, cancelado e item sem id de produto.
    velho: { companyReference: loja('loja-a'), currentPurchaseStatus: 'completed', createdAt: diasAtras(31), productsCart: [item('cafe', 50)] },
    outra: { companyReference: loja('loja-b'), currentPurchaseStatus: 'completed', createdAt: diasAtras(1), productsCart: [item('cafe', 40)] },
    teste: { companyReference: loja('loja-a'), currentPurchaseStatus: 'completed', isTest: true, createdAt: diasAtras(1), productsCart: [item('cafe', 30)] },
    cancelado: { companyReference: loja('loja-a'), currentPurchaseStatus: 'canceled', createdAt: diasAtras(1), productsCart: [item('cafe', 20)] },
    semId: { companyReference: loja('loja-a'), currentPurchaseStatus: 'completed', createdAt: diasAtras(1), productsCart: [{ name: 'Avulso', quantity: 9 }] },
  }));
  const escritasAntes = banco.escritas.length;

  const resposta = await mais.listar('loja-a');

  assert.equal(DIAS_DOS_MAIS_VENDIDOS, 30);
  assert.equal(resposta.desde, '2026-10-20T15:00:00.000Z');
  assert.deepEqual(resposta.produtos, [
    { produtoId: 'feijao', quantidade: 4 },
    { produtoId: 'arroz', quantidade: 2 },
    { produtoId: 'cafe', quantidade: 1 },
  ]);
  assert.equal(banco.escritas.length, escritasAntes, 'so le');
});

test('C1: loja sem venda nos 30 dias devolve a lista vazia (o app mostra os Destaques do dia)', async () => {
  const { mais } = await montar((loja) => ({
    velho: { companyReference: loja('loja-a'), currentPurchaseStatus: 'completed', createdAt: diasAtras(40), productsCart: [item('cafe', 5)] },
  }));
  assert.deepEqual((await mais.listar('loja-a')).produtos, []);
});

test(`C1: no maximo ${LIMITE_DOS_MAIS_VENDIDOS} produtos; empate pelo id; loja invalida e 404`, async () => {
  const { mais } = await montar((loja) => ({
    p: {
      companyReference: loja('loja-a'),
      currentPurchaseStatus: 'completed',
      createdAt: diasAtras(1),
      productsCart: Array.from({ length: 25 }, (_, i) => item(`prod-${String(i).padStart(2, '0')}`, 1)),
    },
  }));
  const { produtos } = await mais.listar('loja-a');
  assert.equal(produtos.length, LIMITE_DOS_MAIS_VENDIDOS);
  assert.equal(produtos[0].produtoId, 'prod-00');
  await assert.rejects(mais.listar('../x'), (erro) => erro.statusCode === 404 && erro.code === 'loja_nao_encontrada');
});

test('C1: GET /api/app/lojas/:lojaId/mais-vendidos pede o login do app', async () => {
  const { createApp } = await import('../src/app.js');
  const { mais } = await montar(() => ({}));
  const app = createApp({ maisVendidosDaLoja: mais, verificarAppCheck: async () => {}, adminAuditMiddleware: (_q, _r, next) => next() });
  const servidor = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const sem = await fetch(`http://127.0.0.1:${servidor.address().port}/api/app/lojas/loja-a/mais-vendidos`);
    assert.equal(sem.status, 401);
    assert.equal((await sem.json()).error.code, 'auth_token_required');
  } finally {
    servidor.close();
  }
});

test('C1: a rota devolve { data: { desde, produtos } }', async () => {
  const { default: express } = await import('express');
  const { createAppUsuarioRoutes } = await import('../src/http/routes/appUsuarioRoutes.js');
  const { errorHandler } = await import('../src/http/middlewares/errorHandler.js');
  const { mais } = await montar((loja) => ({
    p: { companyReference: loja('loja-a'), currentPurchaseStatus: 'completed', createdAt: diasAtras(1), productsCart: [item('arroz', 2)] },
  }));
  const app = express();
  app.use('/api/app', createAppUsuarioRoutes({ maisVendidosDaLoja: mais }));
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}/api/app/lojas`;
  try {
    const ok = await fetch(`${base}/loja-a/mais-vendidos`);
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).data.produtos, [{ produtoId: 'arroz', quantidade: 2 }]);
    assert.equal((await fetch(`${base}/x%20y/mais-vendidos`)).status, 404);
  } finally {
    servidor.close();
  }
});
