import assert from 'node:assert/strict';
import test from 'node:test';
import { FirestoreEstablishmentAccessRepository } from '../src/infra/firebase/FirestoreEstablishmentAccessRepository.js';
import { FirestoreManagerDataGateway } from '../src/infra/firebase/FirestoreManagerDataGateway.js';
import { ManagerDataAccessPolicy } from '../src/infra/firebase/ManagerDataAccessPolicy.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Cola do Thay B57-13g, respostas ao item 28:
// 28.2: a conta principal aparece em Usuarios e permissoes mesmo sem cadastro de funcionario, entao a
//       sessao leva tambem o nome dela (contaDaLoja.nome).
// 28.5: as linhas de lote do categorizador e do taggeador (historicoProdutos_N) ganham o mesmo autor.
const HISTORICO = 'estabelecimentos/loja-1/implantacaoGrenciador/historicoProdutos_1';

function banco() {
  const firestore = new FirestoreEmMemoria({
    'Users/doc-dono': { id: 'loja-1', userAuthId: 'uid-dono', email: 'conta@loja.test', name: 'Super Loja' },
    'estabelecimentos/loja-1/AdminUsers/f-joao': { firstName: 'João', lastName: 'Silva', email: 'joao@loja.test', active: true },
    'estabelecimentos/loja-1/PermissionGroups/g-adm': { name: 'Administrador', isAdmin: true, permissions: [] },
    'estabelecimentos/loja-1/SessoesWeb/sessao-caixa': { uid: 'f-joao', nome: 'Caixa' },
    [HISTORICO]: {
      pagina: 1,
      registros: [
        { produtoId: 'p1', quem: 'velho@loja.test', acao: 'prateleira' },
        { produtoId: 'p2', quem: 'outro@loja.test', acao: 'tags', autor: { tipo: 'funcionario', nome: 'Bia', email: 'bia@loja.test', computador: 'Delivery' } },
      ],
    },
  });
  firestore.docs.set('estabelecimentos/loja-1', { name: 'Loja 1', userReference: firestore.doc('Users/doc-dono') });
  return firestore;
}

test('B57-13g item 28.2: a conta da loja vem com o nome, pelo dono e pelo funcionario', async () => {
  const acesso = new FirestoreEstablishmentAccessRepository({ firestore: banco() });
  assert.deepEqual((await acesso.findAccountByClaims({ uid: 'uid-dono' })).contaDaLoja, { uid: 'uid-dono', email: 'conta@loja.test', nome: 'Super Loja' });
  assert.deepEqual((await acesso.findAccountByClaims({ uid: 'f-joao', adminOf: 'loja-1', groupId: 'g-adm' })).contaDaLoja, { uid: 'uid-dono', email: 'conta@loja.test', nome: 'Super Loja' });
});

test('B57-13g item 28.5: so os registros novos do historico ganham o autor; os antigos ficam como estavam', async () => {
  const firestore = banco();
  const acesso = new FirestoreEstablishmentAccessRepository({ firestore });
  const gateway = new FirestoreManagerDataGateway({ firestore, policy: new ManagerDataAccessPolicy({ firestore }) });
  const actor = await acesso.findAccountByClaims({ uid: 'f-joao', adminOf: 'loja-1', groupId: 'g-adm' });
  const forjado = { tipo: 'contaDaLoja', nome: 'X', email: 'x@x', computador: 'X' };
  await gateway.mutate({
    actor,
    sessaoId: 'sessao-caixa',
    request: {
      operation: 'set',
      target: { path: HISTORICO },
      options: { merge: true },
      data: {
        pagina: 1,
        registros: [
          // O painel reenvia a pagina inteira: os dois antigos (um com autor forjado) e os novos.
          { produtoId: 'p1', quem: 'velho@loja.test', acao: 'prateleira', autor: forjado },
          { produtoId: 'p2', quem: 'outro@loja.test', acao: 'tags', autor: forjado },
          { produtoId: 'p3', quem: 'joao@loja.test', acao: 'tags' },
          { produtoId: 'p4', quem: 'joao@loja.test', acao: 'tags', autor: forjado },
        ],
      },
    },
  });
  const registros = firestore.docs.get(HISTORICO).registros;
  assert.equal(registros[0].autor, undefined, 'registro antigo sem autor continua sem');
  assert.deepEqual(registros[1].autor, { tipo: 'funcionario', nome: 'Bia', email: 'bia@loja.test', computador: 'Delivery' });
  const joao = { tipo: 'funcionario', nome: 'João Silva', email: 'joao@loja.test', computador: 'Caixa' };
  assert.deepEqual(registros[2].autor, joao);
  assert.deepEqual(registros[3].autor, joao);
  assert.equal(registros[2].quem, 'joao@loja.test');
});

test('B57-13g item 28.5: o cabecalho do historico (sem registros) passa sem mudar', async () => {
  const firestore = banco();
  const acesso = new FirestoreEstablishmentAccessRepository({ firestore });
  const gateway = new FirestoreManagerDataGateway({ firestore, policy: new ManagerDataAccessPolicy({ firestore }) });
  const actor = await acesso.findAccountByClaims({ uid: 'f-joao', adminOf: 'loja-1', groupId: 'g-adm' });
  await gateway.mutate({
    actor,
    request: { operation: 'set', target: { path: HISTORICO }, options: { merge: true }, data: { cabecalho: { totalDocumentos: 1, totalRegistros: 2 } } },
  });
  assert.equal(firestore.docs.get(HISTORICO).registros.length, 2);
  assert.equal(firestore.docs.get(HISTORICO).cabecalho.totalRegistros, 2);
});
