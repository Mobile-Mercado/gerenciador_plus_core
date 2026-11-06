import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { formaDisponivel } from '../src/application/loja/FormasDePagamento.js';
import { createFormasDePagamentoRoutes } from '../src/http/routes/formasDePagamentoRoutes.js';
import { createPermissionGuard } from '../src/http/middlewares/requirePermission.js';
import { errorHandler } from '../src/http/middlewares/errorHandler.js';
import { CREDENCIAL, LOJA, credencialBoa, montar } from './apoio/safraDeMentira.js';

// Cola RP-62, item B.5: regra de pagamento 10 no servidor (contrato K2).
const MENSAGEM = 'Deixe pelo menos uma forma de pagamento ligada.';
const SAFRA_LIGADA = { safrapay: { enabled: true }, paymentGateway: { safrapay: { enabled: true } } };
const recusada = (erro) => erro.statusCode === 409 && erro.code === 'sem_forma_de_pagamento' && erro.message === MENSAGEM;

// Loja so com Pix e Dinheiro ativos (apoio/safraDeMentira.js).
test('regra 10: desligar a ultima forma presencial e recusado, e nada muda', async () => {
  const { banco, formas } = montar();
  await formas.salvar('loja-1', { pix: { ativa: false } });
  const antes = banco.dados(LOJA);
  await assert.rejects(formas.salvar('loja-1', { dinheiro: { ativa: false } }), recusada);
  assert.deepEqual(banco.dados(LOJA), antes);
  assert.equal(banco.dados(`${LOJA}/paymentMethods/dinheiro`), undefined, 'subcolecao sem escrita');
  await assert.rejects(formas.salvar('loja-1', { pix: { ativa: false }, dinheiro: { ativa: false } }), recusada);
});

test('regra 10: so "Pelo app" conta com a Safra ligada; sem ela, nao conta', async () => {
  const comSafra = montar(SAFRA_LIGADA, { [CREDENCIAL]: credencialBoa() });
  await comSafra.formas.salvar('loja-1', { pix: { ativa: true, cobradoEm: 'app' }, dinheiro: { ativa: false } });
  assert.equal(comSafra.banco.dados(LOJA).paymentMethods.find((item) => item.id === 'dinheiro').isActive, false);
  // A Safra desligada (K3) nao e recusada: a faixa da regra 11 avisa.
  await comSafra.formas.ligarSafra('loja-1', false);
  // Agora, com a Safra desligada, qualquer mudanca que deixe so o Pix pelo app e recusada.
  await assert.rejects(comSafra.formas.salvar('loja-1', { credito: { ativa: false } }), recusada);
  // Ligar uma forma presencial resolve.
  const ok = await comSafra.formas.salvar('loja-1', { dinheiro: { ativa: true } });
  assert.equal(ok.formas.dinheiro.ativa, true);
});

test('regra 10: "ambos" conta como presencial mesmo sem a Safra; forma inativa nunca conta', () => {
  assert.equal(formaDisponivel({}, { ativa: true, cobradoEm: 'ambos' }), true);
  assert.equal(formaDisponivel({}, { ativa: true, cobradoEm: 'entrega' }), true);
  assert.equal(formaDisponivel({}, { ativa: true, cobradoEm: 'app' }), false);
  assert.equal(formaDisponivel(SAFRA_LIGADA, { ativa: true, cobradoEm: 'app' }), true);
  assert.equal(formaDisponivel(SAFRA_LIGADA, { ativa: false, cobradoEm: 'ambos' }), false);
  const desligadaNoGateway = { safrapay: { enabled: true }, paymentGateway: { safrapay: { enabled: false } } };
  assert.equal(formaDisponivel(desligadaNoGateway, { ativa: true, cobradoEm: 'app' }), false);
});

test('regra 10: so a entrega no corpo nao passa pela regra (a mudanca nao mexe nas formas)', async () => {
  const { banco, formas } = montar({ paymentMethods: [] });
  const corpo = await formas.salvar('loja-1', {}, { entrega: true });
  assert.equal(corpo.entrega, true);
  assert.equal(banco.dados(LOJA).featureFlags.entrega, true);
});

test('regra 10 pela rota: 409 sem_forma_de_pagamento com a mensagem do contrato', async () => {
  const contexto = montar();
  const { requirePermission, accountForRequest } = createPermissionGuard({
    accessRepository: {
      findAccountByClaims: async () => ({
        hasEstablishment: true, establishmentDocument: {}, establishmentId: 'loja-1', permissions: { isAdmin: true, groupId: null, keys: [] },
      }),
    },
  });
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = { uid: 'uid-dono' }; next(); });
  app.use('/api/loja/formas-de-pagamento', createFormasDePagamentoRoutes({ formasDePagamento: contexto.formas, requirePermission, accountForRequest }));
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const resposta = await fetch(`http://127.0.0.1:${servidor.address().port}/api/loja/formas-de-pagamento`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ formas: { pix: { ativa: false }, dinheiro: { ativa: false } } }),
    });
    assert.equal(resposta.status, 409);
    const { error } = await resposta.json();
    assert.equal(error.code, 'sem_forma_de_pagamento');
    assert.equal(error.message, MENSAGEM);
  } finally {
    servidor.closeAllConnections();
    servidor.close();
  }
});
