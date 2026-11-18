import assert from 'node:assert/strict';
import test from 'node:test';
import { DISCOUNT_BADGE_COLOR_PADRAO, LojaNoAdmin, OFFER_COLOR_PADRAO } from '../src/application/admin/LojaNoAdmin.js';
import { ManagerDataAccessPolicy } from '../src/infra/firebase/ManagerDataAccessPolicy.js';
import { AuthEmMemoria } from './apoio/authEmMemoria.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Cola B57-01 (18/11), item C6: cor do selo "-N%" do card de produto, no documento da loja
// (discountBadgeColor), gravada pelo Admin como o offerColor. Sem o campo, a cor de hoje do app.
const HORA = () => new Date('2026-11-18T12:00:00Z');

function lojaNoAdmin(dados = {}) {
  const banco = new FirestoreEmMemoria({ 'estabelecimentos/loja-1': { name: 'Loja', ...dados } });
  return { banco, admin: new LojaNoAdmin({ firestore: banco, auth: new AuthEmMemoria(), accessRepository: null, serverTimestamp: HORA }) };
}

test('C6: sem o campo, a aparencia devolve nulo e o padrao #E0566E, a cor de hoje do selo no app', async () => {
  const { admin } = lojaNoAdmin();
  const aparencia = await admin.aparencia('loja-1');
  assert.equal(DISCOUNT_BADGE_COLOR_PADRAO, '#E0566E');
  assert.equal(aparencia.discountBadgeColor, null);
  assert.equal(aparencia.discountBadgeColorPadrao, '#E0566E');
  assert.equal(aparencia.offerColorPadrao, OFFER_COLOR_PADRAO, 'a cor de oferta nao muda');
});

test('C6: grava em maiuscula, recusa fora de #RRGGBB, e vazio ou nulo apaga o campo (volta ao padrao)', async () => {
  const { banco, admin } = lojaNoAdmin({ offerColor: '#FFF4D1' });
  await assert.rejects(admin.salvarAparencia('loja-1', { discountBadgeColor: 'vermelho' }), (erro) => erro.code === 'aparencia_cor_invalida' && erro.details.campo === 'discountBadgeColor');
  const salva = await admin.salvarAparencia('loja-1', { discountBadgeColor: '#c0392b' });
  assert.equal(salva.discountBadgeColor, '#C0392B');
  assert.equal(banco.dados('estabelecimentos/loja-1').discountBadgeColor, '#C0392B');
  assert.equal(banco.dados('estabelecimentos/loja-1').offerColor, '#FFF4D1', 'o offerColor fica');
  const vazia = await admin.salvarAparencia('loja-1', { discountBadgeColor: '' });
  assert.equal(vazia.discountBadgeColor, null);
  assert.equal('discountBadgeColor' in banco.dados('estabelecimentos/loja-1'), false);
  await admin.salvarAparencia('loja-1', { discountBadgeColor: '#112233' });
  assert.equal((await admin.salvarAparencia('loja-1', { discountBadgeColor: null })).discountBadgeColor, null);
});

test('C6: a rota PATCH /estabelecimentos/:lojaId/aparencia aceita discountBadgeColor', async () => {
  const { default: express } = await import('express');
  const { createAdminRoutes } = await import('../src/http/routes/adminRoutes.js');
  const { errorHandler } = await import('../src/http/middlewares/errorHandler.js');
  const { banco, admin } = lojaNoAdmin();
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = { uid: 'admin-1' }; next(); });
  app.use('/api/admin', createAdminRoutes({ lojaNoAdmin: admin }));
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}/api/admin/estabelecimentos/loja-1/aparencia`;
  try {
    const resposta = await fetch(base, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ discountBadgeColor: '#aa0000' }) });
    assert.equal(resposta.status, 200);
    assert.equal((await resposta.json()).data.discountBadgeColor, '#AA0000');
    assert.equal(banco.dados('estabelecimentos/loja-1').discountBadgeColor, '#AA0000');
    assert.equal((await fetch(base, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ discountBadgeColor: '#AA00001' }) })).status, 400);
  } finally {
    servidor.close();
  }
});

test('C6: o lojista nao grava discountBadgeColor pelo painel; so o Admin, como o offerColor', async () => {
  const firestore = new FirestoreEmMemoria({ 'estabelecimentos/loja-1': { name: 'Loja' } });
  const politica = new ManagerDataAccessPolicy({ firestore });
  const mutar = (data) => politica.assertMutation({
    actor: { uid: 'u', establishmentId: 'loja-1', hasEstablishment: true, permissions: { isAdmin: true, keys: [] } },
    mutation: { operation: 'update', target: { path: 'estabelecimentos/loja-1' }, data },
  });
  await assert.rejects(mutar({ discountBadgeColor: '#000000' }), (erro) => erro.code === 'campo_so_admin');
  await assert.rejects(mutar({ offerColor: '#000000' }), (erro) => erro.code === 'campo_so_admin');
});
