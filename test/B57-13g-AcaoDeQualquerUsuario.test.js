import assert from 'node:assert/strict';
import test from 'node:test';
import { FirestoreEstablishmentAccessRepository } from '../src/infra/firebase/FirestoreEstablishmentAccessRepository.js';
import { FirestoreManagerDataGateway } from '../src/infra/firebase/FirestoreManagerDataGateway.js';
import { ManagerDataAccessPolicy } from '../src/infra/firebase/ManagerDataAccessPolicy.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Cola do Thay B57-13g, item 6: "toda acao de qualquer pessoa logada fica registrada". A acao nova
// do Log da equipe (AcoesEquipe) e gravada para todo usuario logado da loja, com ou sem a chave
// settings.edit. Sem brecha: so na loja do proprio usuario, so documento novo (nao sobrescreve
// registro) e o autor continua vindo do Core.
const ACOES = 'estabelecimentos/loja-1/AcoesEquipe';

function montar() {
  const firestore = new FirestoreEmMemoria({
    'Users/doc-dono': { id: 'loja-1', userAuthId: 'uid-dono', email: 'conta@loja.test', name: 'Super Loja' },
    'estabelecimentos/loja-2': { name: 'Loja 2' },
    'estabelecimentos/loja-1/AdminUsers/f-caixa': { firstName: 'Bia', lastName: 'Caixa', email: 'bia@loja.test', active: true },
    'estabelecimentos/loja-1/PermissionGroups/g-caixa': { name: 'Caixa', isAdmin: false, permissions: ['requests.view'] },
    [`${ACOES}/antiga`]: { quem: 'conta@loja.test', acao: 'pedido.aceitar' },
  });
  firestore.docs.set('estabelecimentos/loja-1', { name: 'Loja 1', userReference: firestore.doc('Users/doc-dono') });
  const gateway = new FirestoreManagerDataGateway({ firestore, policy: new ManagerDataAccessPolicy({ firestore }) });
  const acesso = new FirestoreEstablishmentAccessRepository({ firestore });
  return { firestore, gateway, acesso };
}

const acao = { quem: 'bia@loja.test', tela: 'pedidos', acao: 'pedido.aceitar', origem: 'manual', autor: { tipo: 'contaDaLoja', nome: 'X' } };
const gravar = (gateway, actor, path, data = acao, operation = 'set', options = {}) => gateway.mutate({
  actor, request: { operation, target: { path }, data, options },
});
const negado = (erro) => erro.statusCode === 403;

test('B57-13g item 6: funcionario sem settings.edit registra a acao, com o autor do Core', async () => {
  const { firestore, gateway, acesso } = montar();
  const bia = await acesso.findAccountByClaims({ uid: 'f-caixa', adminOf: 'loja-1', groupId: 'g-caixa' });
  assert.equal(bia.permissions.keys.includes('settings.edit'), false);
  await gravar(gateway, bia, `${ACOES}/nova`);
  const gravada = firestore.docs.get(`${ACOES}/nova`);
  assert.equal(gravada.acao, 'pedido.aceitar');
  assert.deepEqual(gravada.autor, { tipo: 'funcionario', nome: 'Bia Caixa', email: 'bia@loja.test', computador: null });
});

test('B57-13g item 6: sem brecha: outra loja, registro existente, merge, update e delete continuam barrados', async () => {
  const { firestore, gateway, acesso } = montar();
  const bia = await acesso.findAccountByClaims({ uid: 'f-caixa', adminOf: 'loja-1', groupId: 'g-caixa' });
  await assert.rejects(gravar(gateway, bia, 'estabelecimentos/loja-2/AcoesEquipe/x'), negado);
  await assert.rejects(gravar(gateway, bia, `${ACOES}/antiga`));
  assert.equal(firestore.docs.get(`${ACOES}/antiga`).quem, 'conta@loja.test', 'o registro antigo nao muda');
  await assert.rejects(gravar(gateway, bia, `${ACOES}/antiga`, { quem: 'outro' }, 'set', { merge: true }), negado);
  await assert.rejects(gravar(gateway, bia, `${ACOES}/antiga`, { quem: 'outro' }, 'update'), negado);
  await assert.rejects(gravar(gateway, bia, `${ACOES}/antiga`, null, 'delete'), negado);
  assert.equal(firestore.docs.has('estabelecimentos/loja-2/AcoesEquipe/x'), false);
});

test('B57-13g item 6: no lote, a acao passa e o resto continua pela regra de sempre', async () => {
  const { firestore, gateway, acesso } = montar();
  const bia = await acesso.findAccountByClaims({ uid: 'f-caixa', adminOf: 'loja-1', groupId: 'g-caixa' });
  await assert.rejects(gateway.mutate({
    actor: bia,
    request: {
      operation: 'batch',
      operations: [
        { operation: 'set', target: { path: `${ACOES}/lote` }, data: acao },
        { operation: 'update', target: { path: 'estabelecimentos/loja-1' }, data: { name: 'Outro nome' } },
      ],
    },
  }), negado);
  assert.equal(firestore.docs.has(`${ACOES}/lote`), false, 'o lote recusado nao grava nada');
});
