import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { ManageCoupons, OBJETIVOS_PADRAO } from '../src/application/coupons/ManageCoupons.js';
import { FirestoreCouponRepository } from '../src/infra/firebase/FirestoreCouponRepository.js';
import { createCouponRoutes } from '../src/http/routes/couponRoutes.js';
import { errorHandler } from '../src/http/middlewares/errorHandler.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Cadastro de cupom da RP-62 (contrato K5), pela rota, com o repositorio de verdade sobre o banco
// em memoria.

const LOJA = 'loja-1';

const cupomValido = {
  objetivo: 'Atrair clientes novos',
  code: 'BEMVINDO',
  description: '10% na primeira compra',
  termsText: 'Uma vez por cliente.',
  firstPurchaseOnly: true,
  discount: { kind: 'percentage', value: 10 },
  startAt: '2026-10-28T00:00:00.000Z',
  endAt: '2026-11-30T23:59:59.000Z',
};

async function subirRota({ banco = new FirestoreEmMemoria({ [`estabelecimentos/${LOJA}`]: { name: 'Loja 1' } }), auth = { uid: 'uid-dono' }, conta = {} } = {}) {
  const manageCoupons = new ManageCoupons({
    couponRepository: new FirestoreCouponRepository({ firestore: banco }),
    accessRepository: { findAccountByUid: async () => null },
    clock: () => new Date('2026-10-28T17:32:00.000Z'),
  });
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = auth; next(); });
  app.use('/api/coupons', createCouponRoutes({
    manageCoupons,
    requirePermission: () => (_request, _response, next) => next(),
    accountForRequest: async () => ({ establishmentId: LOJA, hasEstablishment: true, ...conta }),
  }));
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}/api/coupons`;
  const chamar = async (caminho, { method = 'GET', body } = {}) => {
    const resposta = await fetch(`${base}${caminho}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: resposta.status, corpo: await resposta.json() };
  };
  return {
    banco,
    chamar,
    fechar: () => { servidor.closeAllConnections(); servidor.close(); },
  };
}

const docsDe = (banco, colecao) => [...banco.docs.keys()].filter((caminho) => caminho.startsWith(`${colecao}/`));

test('D.1: objetivo obrigatorio (1 a 40 letras) ao criar e ao editar, gravado so nos bastidores', async () => {
  const rota = await subirRota();
  try {
    const { objetivo, ...semObjetivo } = cupomValido;
    assert.equal((await rota.chamar('', { method: 'POST', body: semObjetivo })).status, 400);
    assert.equal((await rota.chamar('', { method: 'POST', body: { ...cupomValido, objetivo: '   ' } })).status, 400);
    assert.equal((await rota.chamar('', { method: 'POST', body: { ...cupomValido, objetivo: 'x'.repeat(41) } })).status, 400);
    assert.equal(docsDe(rota.banco, 'Coupons').length, 0, 'recusa nao grava');

    const criado = await rota.chamar('', { method: 'POST', body: { ...cupomValido, objetivo: `  ${'a'.repeat(40)}  ` } });
    assert.equal(criado.status, 201);
    const { id } = criado.corpo.data;
    assert.equal(criado.corpo.data.objetivo, 'a'.repeat(40));

    // O app do cliente le o Coupons/{id}: o objetivo nao vai la.
    const doCliente = rota.banco.dados(`Coupons/${id}`);
    assert.equal(doCliente.code, 'BEMVINDO');
    assert.ok(!('objetivo' in doCliente));
    assert.equal(rota.banco.dados(`CuponsBastidores/${id}`).objetivo, 'a'.repeat(40));

    // Editar: sem objetivo, recusa; com objetivo, troca nos bastidores e nada dele no Coupons.
    assert.equal((await rota.chamar(`/${id}`, { method: 'PATCH', body: { description: 'Outra' } })).status, 400);
    const editado = await rota.chamar(`/${id}`, { method: 'PATCH', body: { objetivo: 'Data comemorativa', description: 'Outra' } });
    assert.equal(editado.status, 200);
    assert.equal(rota.banco.dados(`CuponsBastidores/${id}`).objetivo, 'Data comemorativa');
    assert.equal(rota.banco.dados(`Coupons/${id}`).description, 'Outra');
    assert.ok(!('objetivo' in rota.banco.dados(`Coupons/${id}`)));
    // So o objetivo: o Coupons/{id} nao e regravado.
    const escritasAntes = rota.banco.escritas.length;
    assert.equal((await rota.chamar(`/${id}`, { method: 'PATCH', body: { objetivo: 'Vender produto parado' } })).status, 200);
    assert.deepEqual(rota.banco.escritas.slice(escritasAntes).map((escrita) => escrita.caminho), [`CuponsBastidores/${id}`]);

    // A lista e o GET de um cupom devolvem o objetivo.
    const lista = await rota.chamar('');
    assert.deepEqual(lista.corpo.data.map((cupom) => [cupom.id, cupom.objetivo]), [[id, 'Vender produto parado']]);
    const um = await rota.chamar(`/${id}`);
    assert.equal(um.status, 200);
    assert.equal(um.corpo.data.objetivo, 'Vender produto parado');
    assert.equal(um.corpo.data.code, 'BEMVINDO');
  } finally {
    rota.fechar();
  }
});

test('D.1: cupom antigo, sem bastidores, sai com objetivo null; cupom de outra loja nao abre', async () => {
  const banco = new FirestoreEmMemoria({
    [`estabelecimentos/${LOJA}`]: { name: 'Loja 1' },
    'Coupons/antigo': { code: 'ANTIGO', establishmentIds: [LOJA], active: true },
    'Coupons/alheio': { code: 'ALHEIO', establishmentIds: ['loja-2'], active: true },
  });
  const rota = await subirRota({ banco });
  try {
    const lista = await rota.chamar('');
    assert.deepEqual(lista.corpo.data.map((cupom) => [cupom.id, cupom.objetivo]), [['antigo', null]]);
    assert.equal((await rota.chamar('/antigo')).corpo.data.objetivo, null);
    assert.equal((await rota.chamar('/alheio')).status, 403);
    assert.equal((await rota.chamar('/nao-existe')).status, 404);
  } finally {
    rota.fechar();
  }
});

test('D.1: GET /api/coupons/objetivos devolve os cinco padrao e os da loja', async () => {
  const banco = new FirestoreEmMemoria({
    [`estabelecimentos/${LOJA}`]: { name: 'Loja 1' },
    [`estabelecimentos/${LOJA}/ObjetivosDeCupom/o1`]: { nome: 'Aniversário da loja' },
    'estabelecimentos/loja-2/ObjetivosDeCupom/o9': { nome: 'De outra loja' },
  });
  const rota = await subirRota({ banco });
  try {
    const resposta = await rota.chamar('/objetivos');
    assert.equal(resposta.status, 200);
    assert.deepEqual(resposta.corpo.data, {
      padrao: ['Atrair clientes novos', 'Trazer de volta quem sumiu', 'Aumentar o valor da compra', 'Vender produto parado', 'Data comemorativa'],
      daLoja: [{ id: 'o1', nome: 'Aniversário da loja' }],
    });
    assert.deepEqual(resposta.corpo.data.padrao, [...OBJETIVOS_PADRAO]);
  } finally {
    rota.fechar();
  }
});

test('D.1: excluir o cupom apaga tambem os bastidores', async () => {
  const rota = await subirRota();
  try {
    const { id } = (await rota.chamar('', { method: 'POST', body: cupomValido })).corpo.data;
    assert.equal((await rota.chamar(`/${id}`, { method: 'DELETE' })).status, 200);
    assert.equal(rota.banco.dados(`Coupons/${id}`), undefined);
    assert.equal(rota.banco.dados(`CuponsBastidores/${id}`), undefined);
  } finally {
    rota.fechar();
  }
});
