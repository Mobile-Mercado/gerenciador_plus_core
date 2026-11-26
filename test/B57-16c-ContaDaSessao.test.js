import assert from 'node:assert/strict';
import test from 'node:test';
import { FirestoreEstablishmentAccessRepository } from '../src/infra/firebase/FirestoreEstablishmentAccessRepository.js';
import { createPermissionGuard } from '../src/http/middlewares/requirePermission.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Cola do Thay B57-16c, item 2 (b): a conta que o Core monta para cada chamada (accountForRequest) leva quem
// agiu (uid, nome e e-mail do cadastro e a conta principal da loja), para o autor do Log da equipe e o
// "salvo por" dos motivos (e o autor da planilha importada, B57-13o). O establishmentId e as permissoes
// continuam iguais (a rota do SafraPay so le o establishmentId).
function montar() {
  const firestore = new FirestoreEmMemoria({
    'Users/doc-dono': { id: 'loja-1', userAuthId: 'uid-dono', email: 'conta@loja.test', name: 'Zero Grau' },
    'estabelecimentos/loja-1/AdminUsers/f-joao': { firstName: 'João', lastName: 'Silva', email: 'joao@loja.test', active: true },
    'estabelecimentos/loja-1/PermissionGroups/g-adm': { name: 'Administrador', isAdmin: true, permissions: [] },
  });
  firestore.docs.set('estabelecimentos/loja-1', { name: 'Zero Grau', userReference: firestore.doc('Users/doc-dono') });
  return createPermissionGuard({ accessRepository: new FirestoreEstablishmentAccessRepository({ firestore }) });
}

test('B57-16c item 2: a conta da sessao leva quem agiu, e a loja e as permissoes ficam iguais', async () => {
  const { accountForRequest } = montar();
  const dono = await accountForRequest({ auth: { uid: 'uid-dono', exp: 9999999999, iat: 1 } });
  assert.equal(dono.establishmentId, 'loja-1');
  assert.deepEqual(dono.permissions, { isAdmin: true, groupId: null, keys: [] });
  assert.equal(dono.uid, 'uid-dono');
  assert.deepEqual(dono.userDocument, { nome: null, name: 'Zero Grau', email: 'conta@loja.test' });
  assert.deepEqual(dono.contaDaLoja, { uid: 'uid-dono', email: 'conta@loja.test', nome: 'Zero Grau' });
  const joao = await accountForRequest({ auth: { uid: 'f-joao', adminOf: 'loja-1', groupId: 'g-adm', exp: 9999999999, iat: 1 } });
  assert.equal(joao.establishmentId, 'loja-1');
  assert.equal(joao.uid, 'f-joao');
  assert.equal(joao.userDocument.name, 'João Silva');
  assert.equal(joao.contaDaLoja.uid, 'uid-dono');
  // Admin da plataforma na loja escolhida: so a loja, as permissoes e o uid.
  const admin = await accountForRequest({ auth: { uid: 'uid-admin' }, lojaAlvo: 'loja-1' });
  assert.equal(admin.establishmentId, 'loja-1');
  assert.equal(admin.porAdminDaPlataforma, true);
  assert.equal(admin.uid, 'uid-admin');
});
