import assert from 'node:assert/strict';
import test from 'node:test';
import { FirestoreEstablishmentAccessRepository } from '../src/infra/firebase/FirestoreEstablishmentAccessRepository.js';
import { FirestoreManagerDataGateway } from '../src/infra/firebase/FirestoreManagerDataGateway.js';
import { ManagerDataAccessPolicy } from '../src/infra/firebase/ManagerDataAccessPolicy.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Cola do Thay B57-13t, item 38 (k): colecao "Sugestões de revisão" por loja,
// estabelecimentos/{loja}/SugestoesDeRevisao/unidade_{produtoId}, sem mexer no documento do produto. A
// tela "Revisar unidade" grava ali o resultado da linha conferida ("aceitou a sugestão", "escolheu outra
// unidade" ou "manteve a unidade, contra a sugestão"); o Core poe o autor e a data. Quem edita produto
// (products.edit) grava; a sugestao em si nao muda pelo painel.
const SUGESTAO = 'estabelecimentos/loja-1/SugestoesDeRevisao/unidade_p1';

function montar() {
  const firestore = new FirestoreEmMemoria({
    'Users/doc-dono': { id: 'loja-1', userAuthId: 'uid-dono', email: 'conta@loja.test', name: 'Zero Grau' },
    'estabelecimentos/loja-1/AdminUsers/f-caixa': { firstName: 'Bia', email: 'bia@loja.test', active: true },
    'estabelecimentos/loja-1/AdminUsers/f-produtos': { firstName: 'Ana', email: 'ana@loja.test', active: true },
    'estabelecimentos/loja-1/PermissionGroups/g-caixa': { name: 'Caixa', isAdmin: false, permissions: ['requests.view'] },
    'estabelecimentos/loja-1/PermissionGroups/g-produtos': { name: 'Produtos', isAdmin: false, permissions: ['products.edit'] },
    [SUGESTAO]: { tipo: 'unidade', produtoId: 'p1', sugestao: 'un', duvida: false },
  });
  firestore.docs.set('estabelecimentos/loja-1', { name: 'Zero Grau', userReference: firestore.doc('Users/doc-dono') });
  return {
    firestore,
    gateway: new FirestoreManagerDataGateway({ firestore, policy: new ManagerDataAccessPolicy({ firestore }) }),
    acesso: new FirestoreEstablishmentAccessRepository({ firestore }),
  };
}

const conferir = (gateway, actor, data, path = SUGESTAO) => gateway.mutate({
  actor, request: { operation: 'set', target: { path }, options: { merge: true }, data },
});

test('B57-13t item 38 k: quem edita produto grava o resultado; o Core poe o autor e a data e a sugestao fica', async () => {
  const { firestore, gateway, acesso } = montar();
  const ana = await acesso.findAccountByClaims({ uid: 'f-produtos', adminOf: 'loja-1', groupId: 'g-produtos' });
  await conferir(gateway, ana, { resultado: 'aceitou a sugestão', unidadeConferida: 'un', conferidoPor: { nome: 'Forjado' }, sugestao: 'kg' });
  const gravado = firestore.docs.get(SUGESTAO);
  assert.equal(gravado.resultado, 'aceitou a sugestão');
  assert.equal(gravado.unidadeConferida, 'un');
  assert.equal(gravado.sugestao, 'un', 'a sugestao nao muda pelo painel');
  assert.equal(gravado.conferidoPor.nome, 'Ana');
  assert.equal(gravado.conferidoPor.tipo, 'funcionario');
  assert.ok(gravado.conferidoEm instanceof Date);
});

test('B57-13t item 38 k: produto sem sugestao ganha o documento com o resultado vazio', async () => {
  const { firestore, gateway, acesso } = montar();
  const dono = await acesso.findAccountByClaims({ uid: 'uid-dono' });
  await conferir(gateway, dono, { resultado: null, unidadeConferida: 'kg' }, 'estabelecimentos/loja-1/SugestoesDeRevisao/unidade_p2');
  const gravado = firestore.docs.get('estabelecimentos/loja-1/SugestoesDeRevisao/unidade_p2');
  assert.equal(gravado.resultado, null);
  assert.equal(gravado.conferidoPor.tipo, 'contaDaLoja');
});

test('B57-13t item 38 k: sem products.edit, resultado fora da lista, outra loja ou apagar sao recusados', async () => {
  const { gateway, acesso } = montar();
  const bia = await acesso.findAccountByClaims({ uid: 'f-caixa', adminOf: 'loja-1', groupId: 'g-caixa' });
  const ana = await acesso.findAccountByClaims({ uid: 'f-produtos', adminOf: 'loja-1', groupId: 'g-produtos' });
  const negado = (erro) => erro.statusCode === 403 || erro.statusCode === 400;
  await assert.rejects(conferir(gateway, bia, { resultado: 'aceitou a sugestão', unidadeConferida: 'un' }), negado);
  await assert.rejects(conferir(gateway, ana, { resultado: 'qualquer coisa', unidadeConferida: 'un' }), negado);
  await assert.rejects(conferir(gateway, ana, { resultado: 'aceitou a sugestão' }, 'estabelecimentos/loja-2/SugestoesDeRevisao/unidade_p1'), negado);
  await assert.rejects(gateway.mutate({ actor: ana, request: { operation: 'delete', target: { path: SUGESTAO } } }), negado);
});
