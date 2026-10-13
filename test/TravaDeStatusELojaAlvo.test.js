import assert from 'node:assert/strict';
import test from 'node:test';
import { ManageImplantationPipelines } from '../src/application/implantacao/ManageImplantationPipelines.js';
import { ManageManagerData } from '../src/application/data/ManageManagerData.js';
import { createLojaAlvoDoAdmin } from '../src/http/middlewares/lojaAlvoDoAdmin.js';
import { createPermissionGuard } from '../src/http/middlewares/requirePermission.js';
import { FirestoreEstablishmentAccessRepository } from '../src/infra/firebase/FirestoreEstablishmentAccessRepository.js';
import { ManagerDataAccessPolicy } from '../src/infra/firebase/ManagerDataAccessPolicy.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

function banco() {
  const firestore = new FirestoreEmMemoria({
    'Users/uid-novo': { id: 'uid-novo', userAuthId: 'uid-novo' },
    'Users/uid-antigo': { id: 'loja-antiga', userAuthId: 'uid-antigo' },
    'estabelecimentos/loja-antiga': { name: 'Antiga' },
    'estabelecimentos/loja-contratada': { name: 'Com agendamento', scheduling: { contracted: true } },
  });
  firestore.docs.set('estabelecimentos/loja-nova', { name: 'Nova', status: 'em_analise', userReference: firestore.doc('Users/uid-novo') });
  return firestore;
}

async function rodar(middleware, request) {
  return new Promise((resolve) => { middleware(request, {}, (erro) => resolve(erro)); });
}

test('trava: loja do cadastro novo so usa o painel aprovada; loja antiga sem status segue como hoje', async () => {
  const firestore = banco();
  const { accountForRequest } = createPermissionGuard({ accessRepository: new FirestoreEstablishmentAccessRepository({ firestore }) });
  await assert.rejects(accountForRequest({ auth: { uid: 'uid-novo' }, headers: { authorization: 'Bearer a' } }), (erro) => erro.code === 'loja_em_analise');
  const antiga = await accountForRequest({ auth: { uid: 'uid-antigo' }, headers: { authorization: 'Bearer b' } });
  assert.equal(antiga.establishmentId, 'loja-antiga');

  await firestore.doc('estabelecimentos/loja-nova').update({ status: 'recusada' });
  const dados = new ManageManagerData({ accessRepository: new FirestoreEstablishmentAccessRepository({ firestore }), gateway: {} });
  await assert.rejects(dados.actor('uid-novo', { exp: 1 }), (erro) => erro.code === 'loja_recusada');
  await firestore.doc('estabelecimentos/loja-nova').update({ status: 'aprovada' });
  assert.equal((await dados.actor('uid-novo', { exp: 2 })).establishmentId, 'loja-nova');
});

test('loja alvo: so admin da plataforma, conferido a cada chamada, e a loja precisa existir', async () => {
  const firestore = banco();
  const admins = new Set(['uid-admin']);
  const middleware = createLojaAlvoDoAdmin({ isPlatformAdminForRequest: async (request) => admins.has(request.auth?.uid), firestore });
  const semCabecalho = { headers: {}, auth: { uid: 'uid-qualquer' } };
  assert.equal(await rodar(middleware, semCabecalho), undefined);
  assert.equal(semCabecalho.lojaAlvo, undefined);
  assert.equal((await rodar(middleware, { headers: { 'x-loja-alvo': 'loja-antiga' }, auth: { uid: 'uid-dono' } })).code, 'platform_admin_required');
  assert.equal((await rodar(middleware, { headers: { 'x-loja-alvo': 'nao-existe' }, auth: { uid: 'uid-admin' } })).code, 'loja_alvo_nao_encontrada');
  const pedido = { headers: { 'x-loja-alvo': 'loja-antiga' }, auth: { uid: 'uid-admin' } };
  assert.equal(await rodar(middleware, pedido), undefined);
  assert.equal(pedido.lojaAlvo, 'loja-antiga');

  const { accountForRequest } = createPermissionGuard({ accessRepository: { findAccountByClaims: async () => null } });
  const conta = await accountForRequest(pedido);
  assert.equal(conta.establishmentId, 'loja-antiga');
  assert.equal(conta.porAdminDaPlataforma, true);
});

test('politica: lojista nao grava status, offerColor nem o contrato; scheduling.enabled so com contrato', async () => {
  const firestore = banco();
  const politica = new ManagerDataAccessPolicy({ firestore });
  const dono = (lojaId) => ({ uid: 'u', establishmentId: lojaId, hasEstablishment: true, permissions: { isAdmin: true, keys: [] } });
  const mutar = (lojaId, data, operation = 'update', options) => politica.assertMutation({
    actor: dono(lojaId),
    mutation: { operation, target: { path: `estabelecimentos/${lojaId}` }, data, options },
  });
  await assert.rejects(mutar('loja-antiga', { offerColor: '#000000' }), (erro) => erro.code === 'campo_so_admin');
  await assert.rejects(mutar('loja-antiga', { status: 'aprovada' }), (erro) => erro.code === 'campo_so_admin');
  await assert.rejects(mutar('loja-antiga', { 'scheduling.contracted': true }), (erro) => erro.code === 'campo_so_admin');
  await assert.rejects(mutar('loja-antiga', { scheduling: { contracted: true } }, 'set', { merge: true }), (erro) => erro.code === 'campo_so_admin');
  await assert.rejects(mutar('loja-antiga', { 'scheduling.enabled': true }), (erro) => erro.code === 'agendamento_nao_contratado');
  await mutar('loja-contratada', { 'scheduling.enabled': true });
  await mutar('loja-antiga', { paymentMethods: [], updatedAt: { __managerDataType: 'serverTimestamp' } });
  await assert.rejects(politica.assertMutation({
    actor: dono('loja-antiga'),
    mutation: { operation: 'set', target: { path: 'estabelecimentos/loja-antiga/implantacaoGrenciador/pipeline' }, data: { aprovacaoFormal: { nome: 'x' } }, options: { merge: true } },
  }), (erro) => erro.code === 'campo_so_admin');
  // Admin da plataforma agindo na loja passa.
  await politica.assertMutation({
    actor: { ...dono('loja-antiga'), porAdminDaPlataforma: true },
    mutation: { operation: 'update', target: { path: 'estabelecimentos/loja-antiga' }, data: { offerColor: '#FFF4D1' } },
  });
});

test('aprovacao formal: so depois da validacao, uma vez, com nome e data', async () => {
  const firestore = new FirestoreEmMemoria({
    'estabelecimentos/l1/implantacaoGrenciador/pipeline': { type: 'pipeline', unlockedSteps: ['01', '02'] },
  });
  const pipelines = new ManageImplantationPipelines({ firestore });
  await assert.rejects(pipelines.aprovarFormalmente({ establishmentId: 'l1', nome: 'Ana', uid: 'u' }), (erro) => erro.code === 'implantacao_aprovacao_antes_da_validacao');
  await firestore.doc('estabelecimentos/l1/implantacaoGrenciador/pipeline').update({ unlockedSteps: ['01', '02', '03', '04', '05', '06'] });
  const pipeline = await pipelines.aprovarFormalmente({ establishmentId: 'l1', nome: 'Ana Paula', uid: 'u' });
  assert.equal(pipeline.aprovacaoFormal.nome, 'Ana Paula');
  assert.ok(pipeline.aprovacaoFormal.em);
  assert.equal(pipeline.manualChecks['06'].clientApprovalRecorded.approved, true);
  await assert.rejects(pipelines.aprovarFormalmente({ establishmentId: 'l1', nome: 'Ana', uid: 'u' }), (erro) => erro.code === 'implantacao_ja_aprovada');
});
