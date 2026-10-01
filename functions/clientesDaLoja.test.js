const test = require('node:test');
const assert = require('node:assert/strict');
const {
  gerarListaDeClientes,
  lerListaDeClientes,
  traduzirParaDocumentos,
} = require('./clientesDaLoja');
const { indiceDeUsuarios } = require('./provedoresDeLogin');

// Users de mentira: tres cadastros, um deles com dois documentos apontando para o mesmo uid.
function docUsuario(id, userAuthId = null) {
  const dados = { userAuthId };
  return { id, get: (campo) => dados[campo] };
}

const INDICE = indiceDeUsuarios([
  docUsuario('cliente-1'),
  docUsuario('cliente-2', 'uid-2'),
  docUsuario('cliente-3a', 'uid-ambiguo'),
  docUsuario('cliente-3b', 'uid-ambiguo'),
]);

// Firestore de mentira: pedidos, Chats, conversas e a lista em blocos.
function firestoreFalso({
  pedidos = [], chats = [], conversas = [], lista = null, blocos = null,
} = {}) {
  const registro = { gravados: {}, indice: lista, blocosRemovidos: [] };
  const docs = (entradas) => entradas.map((dados, indice) => ({
    id: `d${indice}`, data: () => dados, get: (campo) => dados[campo],
  }));

  const consulta = (resultado, campo = null, valor = null) => ({
    where: (c, _o, v) => consulta(resultado, c, v),
    select: () => consulta(resultado, campo, valor),
    async get() {
      // So os filtros de Chats importam para o fake: a loja aparece em senderId ou em
      // receiverId. Os outros filtros (companyReference, companyId) ja estao implicitos na
      // colecao de mentira.
      const deChats = campo === 'senderId' || campo === 'receiverId';
      const lista = deChats ? resultado.filter((x) => x[campo] === valor) : resultado;
      const achados = docs(lista);
      return { docs: achados, size: achados.length, empty: !achados.length };
    },
  });

  const blocoDoc = (numero) => ({
    async set(dados) { registro.gravados[numero] = dados; },
    async delete() { registro.blocosRemovidos.push(numero); delete registro.gravados[numero]; },
  });

  const listaDoc = {
    async get() {
      return { exists: Boolean(registro.indice), get: (campo) => (registro.indice || {})[campo] };
    },
    async set(dados) { registro.indice = dados; },
    collection: () => ({
      doc: blocoDoc,
      async get() {
        const fonte = blocos || registro.gravados;
        const entradas = Object.entries(fonte).map(([id, dados]) => ({ id, get: (campo) => dados[campo] }));
        return { docs: entradas, size: entradas.length, empty: !entradas.length };
      },
    }),
  };

  const storeRef = {
    id: 'loja-1',
    collection: () => ({ doc: () => listaDoc }),
  };
  const db = {
    collection: (nome) => (nome === 'Chats' ? consulta(chats) : consulta(pedidos)),
    collectionGroup: () => consulta(conversas),
  };
  return { db, storeRef, registro };
}

test('participante que e uid entra traduzido, e o que ja e id entra direto', async () => {
  const { db, storeRef, registro } = firestoreFalso({
    pedidos: [{ clientId: 'cliente-1' }],
    chats: [{ senderId: 'loja-1', receiverId: 'uid-2' }],
    conversas: [{ userId: 'cliente-1' }],
  });

  const resultado = await gerarListaDeClientes({
    db, storeRef, geradoEm: 'quando', indiceDeUsuarios: INDICE,
  });

  assert.deepEqual(registro.gravados[0].ids.sort(), ['cliente-1', 'cliente-2']);
  assert.equal(resultado.traduzidos, 1, 'uid-2 virou cliente-2');
  assert.equal(resultado.total, 2);
  assert.deepEqual(resultado.deOrigem, { pedidos: 1, chats: 1, agente: 1 });
});

test('uid ambiguo e id inexistente ficam de fora, e sao contados', async () => {
  const { db, storeRef, registro } = firestoreFalso({
    pedidos: [],
    chats: [{ senderId: 'loja-1', receiverId: 'uid-ambiguo' }],
    conversas: [{ userId: 'nao-existe-em-lugar-nenhum' }],
  });

  const resultado = await gerarListaDeClientes({
    db, storeRef, geradoEm: 'quando', indiceDeUsuarios: INDICE,
  });

  assert.deepEqual(registro.gravados[0].ids, []);
  assert.equal(resultado.ambiguos, 1);
  assert.equal(resultado.inexistentes, 1);
  assert.equal(resultado.total, 0);
});

test('a lista cresce e nao perde quem ja estava', async () => {
  const { db, storeRef, registro } = firestoreFalso({
    lista: { version: 1, total: 1, blocos: 1, tamanhoDoBloco: 5000 },
    blocos: { 0: { bloco: 0, ids: ['cliente-antigo'] } },
    pedidos: [{ clientId: 'cliente-1' }],
  });

  const resultado = await gerarListaDeClientes({
    db, storeRef, geradoEm: 'quando', indiceDeUsuarios: INDICE,
  });

  assert.deepEqual(registro.gravados[0].ids.sort(), ['cliente-1', 'cliente-antigo']);
  assert.equal(resultado.total, 2);
  assert.equal(resultado.novos, 1);
});

test('sem indice de usuarios, os ids entram como estao', () => {
  const { documentos, contagem } = traduzirParaDocumentos(new Set(['qualquer-id']), null);

  assert.deepEqual([...documentos], ['qualquer-id']);
  assert.equal(contagem.direto, 1);
});

test('lerListaDeClientes recusa indice ausente e bloco faltando', async () => {
  const sem = firestoreFalso();
  assert.equal((await lerListaDeClientes({ storeRef: sem.storeRef })).motivo, 'sem-indice');

  const faltando = firestoreFalso({
    lista: { version: 1, total: 2, blocos: 2 },
    blocos: { 0: { bloco: 0, ids: ['cliente-1'] } },
  });
  assert.equal((await lerListaDeClientes({ storeRef: faltando.storeRef })).motivo, 'blocos-nao-batem');

  const inteira = firestoreFalso({
    lista: { version: 1, total: 1, blocos: 1 },
    blocos: { 0: { bloco: 0, ids: ['cliente-1'] } },
  });
  const lido = await lerListaDeClientes({ storeRef: inteira.storeRef });
  assert.deepEqual(lido.ids, ['cliente-1']);
});
