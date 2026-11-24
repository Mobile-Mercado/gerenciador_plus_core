import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { GetManagerSession } from '../src/application/auth/GetManagerSession.js';
import { ManageManagerData } from '../src/application/data/ManageManagerData.js';
import { autorDaAcao, ehAcaoDaEquipe } from '../src/domain/logs/autorDaAcao.js';
import { createDataRoutes } from '../src/http/routes/dataRoutes.js';
import { FirestoreEstablishmentAccessRepository } from '../src/infra/firebase/FirestoreEstablishmentAccessRepository.js';
import { FirestoreManagerDataGateway } from '../src/infra/firebase/FirestoreManagerDataGateway.js';
import { ManagerDataAccessPolicy } from '../src/infra/firebase/ManagerDataAccessPolicy.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Cola do Thay B57-13, item 28: o autor das acoes do painel no Log da equipe (AcoesEquipe).
// O Core grava em cada acao do painel o campo `autor`: a conta da loja (a conta principal, para
// a qual estabelecimentos/{loja}.userReference aponta) ou o funcionario (Novo funcionario), com o
// nome do computador dado em "Acessos conectados" (SessoesWeb/{X-Sessao}.nome).

function banco() {
  const firestore = new FirestoreEmMemoria({
    'Users/doc-dono': { id: 'loja-1', userAuthId: 'uid-dono', email: 'conta@loja.test', name: 'Super Loja' },
    'estabelecimentos/loja-1/AdminUsers/f-joao': { firstName: 'João', lastName: 'Silva', email: 'joao@loja.test', active: true },
    // Conta da loja que tambem tem cadastro de funcionario (como a da Zero Grau).
    'estabelecimentos/loja-1/AdminUsers/uid-dono': { firstName: 'Conta', lastName: 'Principal', email: 'conta@loja.test', active: true },
    'estabelecimentos/loja-1/PermissionGroups/g-adm': { name: 'Administrador', isAdmin: true, permissions: [] },
    'estabelecimentos/loja-1/SessoesWeb/sessao-escritorio': { uid: 'uid-dono', nome: 'Escritório' },
    'estabelecimentos/loja-1/SessoesWeb/sessao-sem-nome': { uid: 'f-joao', nome: null },
  });
  firestore.docs.set('estabelecimentos/loja-1', { name: 'Loja 1', userReference: firestore.doc('Users/doc-dono') });
  return firestore;
}

const ACAO = { em: new Date('2026-11-24T12:00:00Z'), quem: 'x@x.test', tela: 'pedidos', acao: 'pedido.aceitar', origem: 'manual' };

test('B57-13 item 28: a conta e o funcionario sabem qual e a conta da loja', async () => {
  const acesso = new FirestoreEstablishmentAccessRepository({ firestore: banco() });
  const dono = await acesso.findAccountByClaims({ uid: 'uid-dono' });
  assert.deepEqual(dono.contaDaLoja, { uid: 'uid-dono', email: 'conta@loja.test', nome: 'Super Loja' });
  const donoComClaim = await acesso.findAccountByClaims({ uid: 'uid-dono', adminOf: 'loja-1' });
  assert.deepEqual(donoComClaim.contaDaLoja, { uid: 'uid-dono', email: 'conta@loja.test', nome: 'Super Loja' });
  const joao = await acesso.findAccountByClaims({ uid: 'f-joao', adminOf: 'loja-1' });
  assert.deepEqual(joao.contaDaLoja, { uid: 'uid-dono', email: 'conta@loja.test', nome: 'Super Loja' });

  const sessao = new GetManagerSession({ accessRepository: acesso });
  const resposta = await sessao.execute({ actorUid: 'f-joao', claims: { uid: 'f-joao', adminOf: 'loja-1' } });
  assert.deepEqual(resposta.contaDaLoja, { uid: 'uid-dono', email: 'conta@loja.test', nome: 'Super Loja' });
});

test('B57-13 item 28: loja sem userReference fica sem conta da loja, e o funcionario continua funcionario', async () => {
  const firestore = banco();
  firestore.docs.set('estabelecimentos/loja-1', { name: 'Loja 1' });
  const joao = await new FirestoreEstablishmentAccessRepository({ firestore }).findAccountByClaims({ uid: 'f-joao', adminOf: 'loja-1' });
  assert.equal(joao.contaDaLoja, null);
  assert.equal(autorDaAcao(joao, null).tipo, 'funcionario');
});

test('B57-13 item 28: autor da acao: conta da loja com o e-mail, funcionario com o nome, e o computador', () => {
  const contaDaLoja = { uid: 'uid-dono', email: 'conta@loja.test' };
  assert.deepEqual(
    autorDaAcao({ uid: 'uid-dono', contaDaLoja, userDocument: { name: 'Super Loja', email: 'conta@loja.test' } }, 'Escritório'),
    { tipo: 'contaDaLoja', nome: 'Super Loja', email: 'conta@loja.test', computador: 'Escritório' },
  );
  assert.deepEqual(
    autorDaAcao({ uid: 'f-joao', contaDaLoja, userDocument: { name: 'João Silva', nome: 'João Silva', email: 'joao@loja.test' } }, '  '),
    { tipo: 'funcionario', nome: 'João Silva', email: 'joao@loja.test', computador: null },
  );
  // Admin da plataforma agindo na loja (X-Loja-Alvo): sem autor, fica o `quem` gravado pelo painel.
  assert.equal(autorDaAcao({ uid: 'adm', porAdminDaPlataforma: true }, 'Escritório'), null);
  assert.equal(ehAcaoDaEquipe('estabelecimentos/loja-1/AcoesEquipe/a1', 'loja-1'), true);
  assert.equal(ehAcaoDaEquipe('estabelecimentos/loja-2/AcoesEquipe/a1', 'loja-1'), false);
  assert.equal(ehAcaoDaEquipe('estabelecimentos/loja-1/Products/a1', 'loja-1'), false);
});

async function servidor(firestore) {
  const accessRepository = new FirestoreEstablishmentAccessRepository({ firestore });
  const gateway = new FirestoreManagerDataGateway({ firestore, policy: new ManagerDataAccessPolicy({ firestore }) });
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = JSON.parse(request.headers['x-auth']); next(); });
  app.use('/api/data', createDataRoutes({ manageManagerData: new ManageManagerData({ accessRepository, gateway }) }));
  app.use((erro, _request, response, _next) => response.status(erro.statusCode || 500).json({ erro: erro.message }));
  const ouvindo = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const gravar = (id, auth, sessao, data = { ...ACAO, em: ACAO.em.toISOString() }) => fetch(`http://127.0.0.1:${ouvindo.address().port}/api/data/mutate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-auth': JSON.stringify(auth), ...(sessao ? { 'x-sessao': sessao } : {}) },
    body: JSON.stringify({ operation: 'set', target: { path: `estabelecimentos/loja-1/AcoesEquipe/${id}` }, data }),
  });
  return { ouvindo, gravar };
}

test('B57-13 item 28: a acao gravada pelo painel leva o autor com o nome do computador do X-Sessao', async () => {
  const firestore = banco();
  const { ouvindo, gravar } = await servidor(firestore);
  try {
    assert.equal((await gravar('a1', { uid: 'uid-dono', adminOf: 'loja-1', groupId: 'g-adm' }, 'sessao-escritorio')).status, 200);
    assert.deepEqual(firestore.docs.get('estabelecimentos/loja-1/AcoesEquipe/a1').autor, {
      tipo: 'contaDaLoja', nome: 'Conta Principal', email: 'conta@loja.test', computador: 'Escritório',
    });
    // Navegador sem nome e chamada sem X-Sessao: computador null ("Navegador sem nome" no web).
    assert.equal((await gravar('a2', { uid: 'f-joao', adminOf: 'loja-1', groupId: 'g-adm' }, 'sessao-sem-nome')).status, 200);
    assert.deepEqual(firestore.docs.get('estabelecimentos/loja-1/AcoesEquipe/a2').autor, {
      tipo: 'funcionario', nome: 'João Silva', email: 'joao@loja.test', computador: null,
    });
    assert.equal((await gravar('a3', { uid: 'f-joao', adminOf: 'loja-1', groupId: 'g-adm' }, null)).status, 200);
    assert.equal(firestore.docs.get('estabelecimentos/loja-1/AcoesEquipe/a3').autor.computador, null);
    // Sessao de outro formato nao vira caminho no banco.
    assert.equal((await gravar('a4', { uid: 'f-joao', adminOf: 'loja-1', groupId: 'g-adm' }, '../../Users/doc-dono')).status, 200);
    assert.equal(firestore.docs.get('estabelecimentos/loja-1/AcoesEquipe/a4').autor.computador, null);
    // O painel nao escolhe o autor: o que vier no corpo e trocado pelo do Core.
    const forjado = { ...ACAO, em: ACAO.em.toISOString(), autor: { tipo: 'contaDaLoja', nome: 'Outro', email: 'o@o', computador: 'X' } };
    assert.equal((await gravar('a5', { uid: 'f-joao', adminOf: 'loja-1', groupId: 'g-adm' }, 'sessao-escritorio', forjado)).status, 200);
    assert.equal(firestore.docs.get('estabelecimentos/loja-1/AcoesEquipe/a5').autor.tipo, 'funcionario');
    // O resto da acao fica como o painel mandou.
    assert.equal(firestore.docs.get('estabelecimentos/loja-1/AcoesEquipe/a1').quem, 'x@x.test');
  } finally {
    ouvindo.close();
  }
});
