import assert from 'node:assert/strict';
import test from 'node:test';
import { ManagerDataAccessPolicy } from '../src/infra/firebase/ManagerDataAccessPolicy.js';
import { FirestoreManagerDataGateway } from '../src/infra/firebase/FirestoreManagerDataGateway.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Cola RP-62, item E.4: contrato K6 (codigo de barras repetido na mesma loja, pelo proxy).
const dono = { uid: 'uid-dono', userId: 'loja-1', establishmentId: 'loja-1', hasEstablishment: true };
const PRODUTOS = 'estabelecimentos/loja-1/Products';

function montar(extras = {}) {
  const firestore = new FirestoreEmMemoria({
    'estabelecimentos/loja-1': { name: 'Loja 1' },
    [`${PRODUTOS}/arroz`]: { name: 'Arroz Tio João 5kg', barCode: '7891234567890', isTrashed: false, deletedAt: null },
    [`${PRODUTOS}/feijao`]: { name: 'Feijão Preto 1kg', barCode: '7890000000001', isTrashed: false },
    [`${PRODUTOS}/velho`]: { name: 'Produto na lixeira', barCode: '7895555555555', isTrashed: true },
    [`${PRODUTOS}/apagado`]: { name: 'Produto apagado', barCode: '7896666666666', isTrashed: false, deletedAt: new Date('2026-10-01T00:00:00Z') },
    'estabelecimentos/loja-2/Products/outro': { name: 'Arroz da outra loja', barCode: '7897777777777', isTrashed: false },
    ...extras,
  });
  const policy = new ManagerDataAccessPolicy({ firestore });
  return { firestore, gateway: new FirestoreManagerDataGateway({ firestore, policy }) };
}

const gravar = (gateway, operation, path, data, options, actor = dono) => gateway.mutate({
  actor, request: { operation, target: { path }, data, options },
});

const repetido = (nome) => (erro) => erro.statusCode === 409
  && erro.code === 'codigo_de_barras_repetido'
  && erro.message === `Já existe um produto com este código de barras: ${nome}.`;

test('K6: produto novo ou editado com o codigo de outro produto da loja da 409 com o nome dele, e nada e gravado', async () => {
  const { firestore, gateway } = montar();
  await assert.rejects(
    gravar(gateway, 'set', `${PRODUTOS}/novo`, { name: 'Arroz novo', barCode: '7891234567890' }),
    repetido('Arroz Tio João 5kg'),
  );
  assert.equal((await firestore.doc(`${PRODUTOS}/novo`).get()).exists, false);
  await assert.rejects(
    gravar(gateway, 'update', `${PRODUTOS}/feijao`, { barCode: '7891234567890' }),
    repetido('Arroz Tio João 5kg'),
  );
  assert.equal((await firestore.doc(`${PRODUTOS}/feijao`).get()).data().barCode, '7890000000001');
  await assert.rejects(
    gravar(gateway, 'set', `${PRODUTOS}/novo`, { barCode: ' 7891234567890 ' }, { merge: true }),
    repetido('Arroz Tio João 5kg'),
    'com espacos em volta tambem',
  );
  // No lote, nada e gravado.
  await assert.rejects(gateway.mutate({
    actor: dono,
    request: {
      operation: 'batch',
      operations: [
        { operation: 'update', target: { path: `${PRODUTOS}/arroz` }, data: { name: 'Arroz 5kg' } },
        { operation: 'set', target: { path: `${PRODUTOS}/novo` }, data: { name: 'Outro', barCode: '7890000000001' } },
      ],
    },
  }), repetido('Feijão Preto 1kg'));
  assert.equal((await firestore.doc(`${PRODUTOS}/arroz`).get()).data().name, 'Arroz Tio João 5kg');
});

test('K6: o proprio produto, codigo vazio, produto na lixeira ou apagado e outra loja nao contam', async () => {
  const { firestore, gateway } = montar();
  await gravar(gateway, 'update', `${PRODUTOS}/arroz`, { barCode: '7891234567890', name: 'Arroz Tio João 5 kg' });
  await gravar(gateway, 'set', `${PRODUTOS}/sem-codigo`, { name: 'Sem codigo', barCode: '' });
  await gravar(gateway, 'set', `${PRODUTOS}/sem-codigo-2`, { name: 'Sem codigo 2', barCode: '   ' });
  await gravar(gateway, 'set', `${PRODUTOS}/de-novo`, { name: 'Volta da lixeira', barCode: '7895555555555' });
  await gravar(gateway, 'set', `${PRODUTOS}/de-novo-2`, { name: 'Volta do apagado', barCode: '7896666666666' });
  await gravar(gateway, 'set', `${PRODUTOS}/da-outra`, { name: 'Mesmo codigo da outra loja', barCode: '7897777777777' });
  await gravar(gateway, 'update', `${PRODUTOS}/feijao`, { name: 'Feijão Preto 1 kg' });
  assert.equal((await firestore.doc(`${PRODUTOS}/de-novo`).get()).data().barCode, '7895555555555');
  assert.equal((await firestore.doc(`${PRODUTOS}/da-outra`).get()).exists, true);
});

test('K6: o Admin da plataforma agindo na loja tambem recebe o 409', async () => {
  const { gateway } = montar();
  await assert.rejects(
    gravar(gateway, 'set', `${PRODUTOS}/novo`, { name: 'Novo', barCode: '7890000000001' }, undefined, { ...dono, porAdminDaPlataforma: true }),
    repetido('Feijão Preto 1kg'),
  );
});

// RP-65, item B.1: a repeticao so e conferida ao criar o produto ou quando o barCode muda em relacao
// ao do documento atual. Produto que ja esta repetido salva normalmente sem trocar o codigo.
test('B.1: criar produto com codigo repetido recusa', async () => {
  const { firestore, gateway } = montar({
    [`${PRODUTOS}/repA`]: { name: 'Leite A', barCode: '7899999999999', isTrashed: false },
    [`${PRODUTOS}/repB`]: { name: 'Leite B', barCode: '7899999999999', isTrashed: false },
  });
  await assert.rejects(gravar(gateway, 'set', `${PRODUTOS}/novo`, { name: 'Leite C', barCode: '7899999999999' }), repetido('Leite A'));
  await assert.rejects(gravar(gateway, 'set', `${PRODUTOS}/novo`, { name: 'Leite C', barCode: '7891234567890' }, { merge: true }), repetido('Arroz Tio João 5kg'));
  assert.equal((await firestore.doc(`${PRODUTOS}/novo`).get()).exists, false);
});

test('B.1: trocar o codigo para um repetido recusa, inclusive no produto que ja era repetido', async () => {
  const { firestore, gateway } = montar({
    [`${PRODUTOS}/repA`]: { name: 'Leite A', barCode: '7899999999999', isTrashed: false },
    [`${PRODUTOS}/repB`]: { name: 'Leite B', barCode: '7899999999999', isTrashed: false },
  });
  await assert.rejects(gravar(gateway, 'update', `${PRODUTOS}/feijao`, { name: 'Feijão', barCode: '7899999999999' }), repetido('Leite A'));
  await assert.rejects(gravar(gateway, 'set', `${PRODUTOS}/feijao`, { name: 'Feijão', barCode: '7891234567890' }, { merge: true }), repetido('Arroz Tio João 5kg'));
  await assert.rejects(gravar(gateway, 'update', `${PRODUTOS}/repA`, { barCode: '7891234567890' }), repetido('Arroz Tio João 5kg'));
  assert.equal((await firestore.doc(`${PRODUTOS}/feijao`).get()).data().barCode, '7890000000001');
  assert.equal((await firestore.doc(`${PRODUTOS}/repA`).get()).data().barCode, '7899999999999');
  // Trocar o repetido para um codigo livre passa.
  await gravar(gateway, 'update', `${PRODUTOS}/repB`, { barCode: '7898888888888' });
  assert.equal((await firestore.doc(`${PRODUTOS}/repB`).get()).data().barCode, '7898888888888');
});

test('B.1: editar outro campo de produto ja repetido, mandando o mesmo codigo, salva normalmente', async () => {
  const { firestore, gateway } = montar({
    [`${PRODUTOS}/repA`]: { name: 'Leite A', barCode: '7899999999999', price: 5, isTrashed: false },
    [`${PRODUTOS}/repB`]: { name: 'Leite B', barCode: '7899999999999', price: 6, isTrashed: false },
    [`${PRODUTOS}/repNum`]: { name: 'Leite N', barCode: 7899999999999, isTrashed: false },
  });
  await gravar(gateway, 'update', `${PRODUTOS}/repA`, { price: 5.5, barCode: '7899999999999' });
  await gravar(gateway, 'set', `${PRODUTOS}/repB`, { price: 6.5, barCode: ' 7899999999999 ' }, { merge: true });
  await gravar(gateway, 'set', `${PRODUTOS}/repA`, { name: 'Leite A 1L', barCode: '7899999999999', price: 5.5, isTrashed: false });
  // O mesmo codigo gravado como numero e mandado como texto nao e troca.
  await gravar(gateway, 'update', `${PRODUTOS}/repNum`, { name: 'Leite N 1L', barCode: '7899999999999' });
  // No lote tambem.
  await gateway.mutate({
    actor: dono,
    request: {
      operation: 'batch',
      operations: [
        { operation: 'update', target: { path: `${PRODUTOS}/repA` }, data: { price: 5.9, barCode: '7899999999999' } },
        { operation: 'update', target: { path: `${PRODUTOS}/repB` }, data: { price: 6.9, barCode: '7899999999999' } },
      ],
    },
  });
  assert.equal((await firestore.doc(`${PRODUTOS}/repA`).get()).data().price, 5.9);
  assert.equal((await firestore.doc(`${PRODUTOS}/repB`).get()).data().price, 6.9);
  assert.equal((await firestore.doc(`${PRODUTOS}/repA`).get()).data().name, 'Leite A 1L');
  assert.equal((await firestore.doc(`${PRODUTOS}/repNum`).get()).data().name, 'Leite N 1L');
});
