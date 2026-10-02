const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MARCADOR_DOCUMENT,
  MARCADOR_VERSION,
  lojasDaConversa,
  marcarMudanca,
} = require('./marcador');

// FieldValue de mentira: devolve marcas legiveis no lugar dos sentinelas do Firestore.
const FieldValue = {
  increment: (n) => ({ increment: n }),
  serverTimestamp: () => ({ serverTimestamp: true }),
};

// Firestore de mentira: registra cada caminho lido e cada set gravado.
function firestoreFalso({ lojas = [] } = {}) {
  const registro = { lidos: [], gravados: [] };
  const referencia = (partes) => ({
    collection: (nome) => ({ doc: (id) => referencia([...partes, nome, id]) }),
    async get() {
      const caminho = partes.join('/');
      registro.lidos.push(caminho);
      return { exists: partes.length === 2 && partes[0] === 'estabelecimentos' && lojas.includes(partes[1]) };
    },
    async set(dados, opcoes) {
      registro.gravados.push({ caminho: partes.join('/'), dados, opcoes });
    },
  });
  return { db: { collection: (nome) => ({ doc: (id) => referencia([nome, id]) }) }, registro };
}

test('grava o incremento e a data no marcador da loja, com merge', async () => {
  const { db, registro } = firestoreFalso();
  await marcarMudanca({ db, FieldValue, lojaId: 'loja-1', tipo: 'pedidos' });

  assert.deepEqual(registro.gravados, [{
    caminho: `estabelecimentos/loja-1/Stats/${MARCADOR_DOCUMENT}`,
    dados: {
      pedidos: { increment: 1 },
      pedidosEm: { serverTimestamp: true },
      versaoMarcador: MARCADOR_VERSION,
    },
    opcoes: { merge: true },
  }]);
});

test('conversas usa o proprio campo, sem tocar no de pedidos', async () => {
  const { db, registro } = firestoreFalso();
  await marcarMudanca({ db, FieldValue, lojaId: 'loja-1', tipo: 'conversas' });

  assert.deepEqual(Object.keys(registro.gravados[0].dados).sort(), ['conversas', 'conversasEm', 'versaoMarcador']);
});

test('recusa tipo invalido e nao grava', async () => {
  const { db, registro } = firestoreFalso();
  await assert.rejects(marcarMudanca({ db, FieldValue, lojaId: 'loja-1', tipo: 'clientes' }), /invalido/);
  await assert.rejects(marcarMudanca({ db, FieldValue, lojaId: 'loja-1' }), /invalido/);
  assert.equal(registro.gravados.length, 0);
});

test('sem lojaId nao grava', async () => {
  const { db, registro } = firestoreFalso();
  await marcarMudanca({ db, FieldValue, lojaId: null, tipo: 'pedidos' });
  await marcarMudanca({ db, FieldValue, lojaId: '', tipo: 'conversas' });
  assert.equal(registro.gravados.length, 0);
});

test('lojasDaConversa devolve so o id que existe em estabelecimentos e ignora o usuario', async () => {
  const { db } = firestoreFalso({ lojas: ['loja-1'] });
  const comoRemetente = await lojasDaConversa({ db, chat: { senderId: 'loja-1', receiverId: 'usuario-9' } });
  const comoDestino = await lojasDaConversa({ db, chat: { senderId: 'usuario-9', receiverId: 'loja-1' } });

  assert.deepEqual(comoRemetente, ['loja-1']);
  assert.deepEqual(comoDestino, ['loja-1']);
});

test('lojasDaConversa aceita referencia e caminho no lugar do id', async () => {
  const { db } = firestoreFalso({ lojas: ['loja-1'] });
  const porReferencia = await lojasDaConversa({ db, chat: { senderId: { id: 'loja-1' }, receiverId: 'usuario-9' } });
  const porCaminho = await lojasDaConversa({ db, chat: { senderId: 'usuario-9', receiverId: 'estabelecimentos/loja-1' } });

  assert.deepEqual(porReferencia, ['loja-1']);
  assert.deepEqual(porCaminho, ['loja-1']);
});

test('lojasDaConversa nao consulta duas vezes quando senderId e igual a receiverId', async () => {
  const { db, registro } = firestoreFalso({ lojas: ['loja-1'] });
  const lojas = await lojasDaConversa({ db, chat: { senderId: 'loja-1', receiverId: 'loja-1' } });

  assert.deepEqual(lojas, ['loja-1']);
  assert.deepEqual(registro.lidos, ['estabelecimentos/loja-1']);
});

test('lojasDaConversa sem participantes nao consulta nada', async () => {
  const { db, registro } = firestoreFalso({ lojas: ['loja-1'] });
  assert.deepEqual(await lojasDaConversa({ db, chat: {} }), []);
  assert.deepEqual(await lojasDaConversa({ db, chat: null }), []);
  assert.equal(registro.lidos.length, 0);
});
