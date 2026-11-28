import assert from 'node:assert/strict';
import test from 'node:test';
import { FirestoreManagerDataGateway } from '../src/infra/firebase/FirestoreManagerDataGateway.js';
import { ManagerDataAccessPolicy } from '../src/infra/firebase/ManagerDataAccessPolicy.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Cola do Thay B57-16c, item 1 (opcao B): pelo proxy de dados do painel, SugestoesDeRevisao so aceita ler e
// gravar a conferencia (mescla com o resultado); sobrescrever o documento inteiro e apagar dao 403, mesmo
// com a permissao de editar Ajustes. A carga das sugestoes continua so pelo script (acesso de servidor).
const SUGESTAO = 'estabelecimentos/loja-1/SugestoesDeRevisao/unidade_p1';
const dono = { uid: 'uid-dono', userId: 'loja-1', establishmentId: 'loja-1', hasEstablishment: true, contaDaLoja: { uid: 'uid-dono' } };

function montar() {
  const firestore = new FirestoreEmMemoria({
    'estabelecimentos/loja-1': { name: 'Loja 1' },
    [SUGESTAO]: { tipo: 'unidade', produtoId: 'p1', sugestao: 'un' },
  });
  return { firestore, gateway: new FirestoreManagerDataGateway({ firestore, policy: new ManagerDataAccessPolicy({ firestore }) }) };
}

test('B57-16c item 1: sobrescrever e apagar uma sugestao pelo proxy dao 403', async () => {
  const { firestore, gateway } = montar();
  const negado = (erro) => erro.statusCode === 403;
  await assert.rejects(gateway.mutate({ actor: dono, request: { operation: 'set', target: { path: SUGESTAO }, data: { sugestao: 'kg' } } }), negado);
  await assert.rejects(gateway.mutate({ actor: dono, request: { operation: 'delete', target: { path: SUGESTAO } } }), negado);
  assert.equal(firestore.docs.get(SUGESTAO).sugestao, 'un');
});

test('B57-16c item 1: ler e gravar a conferencia continuam como hoje', async () => {
  const { firestore, gateway } = montar();
  const lido = await gateway.getDocument({ actor: dono, target: { kind: 'document', path: SUGESTAO } });
  assert.equal(lido.exists, true);
  await gateway.mutate({ actor: dono, request: { operation: 'set', target: { path: SUGESTAO }, options: { merge: true }, data: { resultado: 'aceitou a sugestão', unidadeConferida: 'un' } } });
  assert.equal(firestore.docs.get(SUGESTAO).resultado, 'aceitou a sugestão');
});
