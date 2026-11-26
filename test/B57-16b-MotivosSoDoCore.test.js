import assert from 'node:assert/strict';
import test from 'node:test';
import { FirestoreManagerDataGateway } from '../src/infra/firebase/FirestoreManagerDataGateway.js';
import { ManagerDataAccessPolicy } from '../src/infra/firebase/ManagerDataAccessPolicy.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Cola do Thay B57-16b, item 11 (linha aprovada): MotivosDaSeparacao e so do Core; o proxy de dados do
// painel nao le nem grava essa colecao direto (o web e o App Gerenciador passam pelas rotas do Core).
const dono = { uid: 'uid-dono', userId: 'loja-1', establishmentId: 'loja-1', hasEstablishment: true };

test('B57-16b item 11: o proxy de dados recusa ler e gravar MotivosDaSeparacao', async () => {
  const firestore = new FirestoreEmMemoria({
    'estabelecimentos/loja-1': { name: 'Loja 1' },
    'estabelecimentos/loja-1/MotivosDaSeparacao/m1': { texto: 'Produto em falta' },
  });
  const gateway = new FirestoreManagerDataGateway({ firestore, policy: new ManagerDataAccessPolicy({ firestore }) });
  const negado = (erro) => erro.statusCode === 403;
  await assert.rejects(gateway.getDocument({ actor: dono, target: { kind: 'document', path: 'estabelecimentos/loja-1/MotivosDaSeparacao/m1' } }), negado);
  await assert.rejects(gateway.getDocuments({ actor: dono, target: { kind: 'collection', path: 'estabelecimentos/loja-1/MotivosDaSeparacao' } }), negado);
  await assert.rejects(gateway.mutate({ actor: dono, request: { operation: 'set', target: { path: 'estabelecimentos/loja-1/MotivosDaSeparacao/m2' }, data: { texto: 'x' } } }), negado);
});
