import assert from 'node:assert/strict';
import test from 'node:test';
import { FirestoreEstablishmentAccessRepository } from '../src/infra/firebase/FirestoreEstablishmentAccessRepository.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// A1 (13/10/2026): dono so da loja cujo userReference e o proprio documento de Users.
function banco() {
  const firestore = new FirestoreEmMemoria({
    'Users/doc-dono': { id: 'loja-1', userAuthId: 'uid-dono' },
    'Users/doc-intruso': { id: 'loja-1', userAuthId: 'uid-intruso' },
    'Users/doc-sem-ref': { id: 'loja-2', userAuthId: 'uid-sem-ref' },
  });
  firestore.docs.set('estabelecimentos/loja-1', { name: 'Loja Um', userReference: firestore.doc('Users/doc-dono') });
  firestore.docs.set('estabelecimentos/loja-2', { name: 'Loja Dois' });
  return firestore;
}

test('loja que aponta para a conta: e dona', async () => {
  const acesso = new FirestoreEstablishmentAccessRepository({ firestore: banco() });
  const conta = await acesso.findAccountByUid('uid-dono');
  assert.equal(conta.establishmentId, 'loja-1');
  assert.equal(conta.hasEstablishment, true);
  assert.equal(await acesso.userCanAccess({ uid: 'uid-dono', establishmentId: 'loja-1' }), true);
});

test('Users com id trocado para a loja de outro: fica sem loja', async () => {
  const acesso = new FirestoreEstablishmentAccessRepository({ firestore: banco() });
  const conta = await acesso.findAccountByUid('uid-intruso');
  assert.equal(conta.hasEstablishment, false);
  assert.equal(conta.establishmentDocument, null);
  assert.equal(await acesso.userCanAccess({ uid: 'uid-intruso', establishmentId: 'loja-1' }), false);
  const porClaims = await acesso.findAccountByClaims({ uid: 'uid-intruso' });
  assert.equal(porClaims.hasEstablishment, false);
});

test('loja que nao aponta para a conta (sem userReference): fica sem loja', async () => {
  const acesso = new FirestoreEstablishmentAccessRepository({ firestore: banco() });
  const conta = await acesso.findAccountByUid('uid-sem-ref');
  assert.equal(conta.hasEstablishment, false);
  assert.equal(await acesso.userCanAccess({ uid: 'uid-sem-ref', establishmentId: 'loja-2' }), false);
});

test('busca por userReference tambem so acha a loja que aponta para o Users', async () => {
  const firestore = banco();
  firestore.docs.set('Users/doc-novo', { id: 'doc-novo', userAuthId: 'uid-novo' });
  firestore.docs.set('estabelecimentos/loja-3', { name: 'Loja Tres', userReference: firestore.doc('Users/doc-novo') });
  const acesso = new FirestoreEstablishmentAccessRepository({ firestore });
  assert.equal((await acesso.findAccountByUid('uid-novo')).establishmentId, 'loja-3');
});
