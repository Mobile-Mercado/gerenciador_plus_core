import assert from 'node:assert/strict';
import test from 'node:test';
import { ManagerDataAccessPolicy } from '../src/infra/firebase/ManagerDataAccessPolicy.js';

const LOJA = 'store-1';
const actor = {
  uid: 'uid-manager',
  userId: 'store-1',
  establishmentId: LOJA,
  hasEstablishment: true,
  permissions: { isAdmin: true, groupId: null, keys: [] },
};

// Firestore de mentira: a lista de clientes em blocos, os pedidos da loja, os Chats e as
// conversas do agente. Conta leitura por tipo, que e o que os testes verificam.
function firestoreFalso({
  lista = null,
  blocos = null,
  pedidos = [],
  chats = [],
  conversas = [],
} = {}) {
  const registro = {
    varredurasDePedidos: 0, leiturasDaLista: 0, consultasDeConversa: 0, acrescentados: [],
  };

  const docs = (entradas) => entradas.map((dados, indice) => ({
    id: dados.id || `doc-${indice}`,
    data: () => dados,
    get: (campo) => dados[campo],
  }));

  const blocoDoc = (numero) => ({
    async set(dados, opcoes) {
      if (opcoes?.merge && dados.ids?.arrayUnion) registro.acrescentados.push(...dados.ids.arrayUnion);
    },
    async delete() {},
  });

  const listaDoc = {
    async get() {
      registro.leiturasDaLista += 1;
      return { exists: Boolean(lista), get: (campo) => (lista || {})[campo] };
    },
    async set() {},
    collection: () => ({
      doc: (numero) => blocoDoc(numero),
      async get() {
        const fonte = blocos || {};
        const entradas = Object.entries(fonte).map(([id, dados]) => ({ id, get: (campo) => dados[campo] }));
        return { docs: entradas, size: entradas.length, empty: !entradas.length };
      },
    }),
  };

  const consultaPedidos = () => ({
    where: () => consultaPedidos(),
    select: () => consultaPedidos(),
    async get() {
      registro.varredurasDePedidos += 1;
      const lista = docs(pedidos);
      return { docs: lista, size: lista.length, empty: !lista.length };
    },
  });

  const consultaChats = (campo, valor) => ({
    where: (c, _o, v) => consultaChats(c, v),
    select: () => consultaChats(campo, valor),
    doc: () => ({ async get() { return { exists: false, data: () => ({}) }; } }),
    async get() {
      registro.consultasDeConversa += 1;
      const lista = docs(chats.filter((chat) => chat[campo] === valor));
      return { docs: lista, size: lista.length, empty: !lista.length };
    },
  });

  const firestore = {
    registro,
    collection: (nome) => {
      if (nome === 'PurchaseRequests') return consultaPedidos();
      if (nome === 'Chats') return consultaChats();
      if (nome === 'estabelecimentos') {
        return {
          doc: () => ({
            id: LOJA,
            collection: (sub) => (sub === 'Stats' ? { doc: () => listaDoc } : { doc: () => listaDoc }),
          }),
        };
      }
      return { doc: () => ({ async get() { return { exists: false }; } }) };
    },
    collectionGroup: () => ({
      where: () => ({
        select: () => ({
          async get() {
            registro.consultasDeConversa += 1;
            const lista = docs(conversas);
            return { docs: lista, size: lista.length, empty: !lista.length };
          },
        }),
      }),
    }),
    doc: () => ({ async get() { return { exists: false, data: () => ({}) }; } }),
  };
  return { firestore, registro };
}

const comLista = (ids) => ({
  lista: { version: 1, total: ids.length, blocos: 1, tamanhoDoBloco: 5000 },
  blocos: { 0: { bloco: 0, ids } },
});

test('a lista de clientes vem do documento, sem varrer os pedidos', async () => {
  const { firestore, registro } = firestoreFalso({
    ...comLista(['cliente-1', 'cliente-2']),
    pedidos: [{ clientId: 'cliente-1' }],
  });
  const policy = new ManagerDataAccessPolicy({ firestore });

  const ids = await policy.getCustomerIds(actor);

  assert.deepEqual([...ids].sort(), ['cliente-1', 'cliente-2']);
  assert.equal(registro.varredurasDePedidos, 0, 'nenhuma varredura de pedidos');
  assert.equal(registro.leiturasDaLista, 1, 'uma leitura do indice');
});

test('sem o documento, cai na varredura direta, como antes', async () => {
  const { firestore, registro } = firestoreFalso({ pedidos: [{ clientId: 'cliente-9' }] });
  const policy = new ManagerDataAccessPolicy({ firestore });

  const ids = await policy.getCustomerIds(actor);

  assert.deepEqual([...ids], ['cliente-9']);
  assert.equal(registro.varredurasDePedidos, 1);
});

test('id fora da lista entra por verificacao pontual e e acrescentado ao documento', async () => {
  const { firestore, registro } = firestoreFalso({
    ...comLista(['cliente-1']),
    pedidos: [{ clientId: 'cliente-1' }, { clientId: 'cliente-novo' }],
  });
  const policy = new ManagerDataAccessPolicy({ firestore, arrayUnion: (valores) => ({ arrayUnion: valores }) });

  assert.equal(await policy.isCustomer(actor, 'cliente-novo'), true);
  assert.equal(registro.varredurasDePedidos, 1, 'uma varredura pontual');
  assert.deepEqual(registro.acrescentados, ['cliente-novo'], 'gravado por arrayUnion');
  // ja esta na memoria: nao varre de novo
  assert.equal(await policy.isCustomer(actor, 'cliente-novo'), true);
  assert.equal(registro.varredurasDePedidos, 1);
});

test('segunda falta dentro de dez minutos nao varre de novo', async () => {
  let agora = 1_000_000;
  const { firestore, registro } = firestoreFalso({
    ...comLista(['cliente-1']),
    pedidos: [{ clientId: 'cliente-1' }],
  });
  const policy = new ManagerDataAccessPolicy({ firestore, clock: () => agora });

  assert.equal(await policy.isCustomer(actor, 'intruso-1'), false);
  assert.equal(registro.varredurasDePedidos, 1);

  assert.equal(await policy.isCustomer(actor, 'intruso-2'), false);
  assert.equal(registro.varredurasDePedidos, 1, 'a segunda falta nao varreu');

  agora += 11 * 60 * 1000;
  assert.equal(await policy.isCustomer(actor, 'intruso-3'), false);
  assert.equal(registro.varredurasDePedidos, 2, 'passados dez minutos, varre de novo');
});

test('id que nunca apareceu em pedido nem em conversa continua recusado', async () => {
  const { firestore } = firestoreFalso({
    ...comLista(['cliente-1']),
    pedidos: [{ clientId: 'cliente-1' }],
    conversas: [{ userId: 'conversou-1' }],
  });
  const policy = new ManagerDataAccessPolicy({ firestore });

  assert.equal(await policy.isCustomer(actor, 'ninguem'), false);
  await assert.rejects(
    policy.assertUserPath(actor, 'Users/ninguem'),
    (error) => error.code === 'data_access_forbidden',
  );
});

test('participante de conversa sem pedido volta na leitura de Users', async () => {
  const { firestore, registro } = firestoreFalso({
    ...comLista(['cliente-1']),
    chats: [{ senderId: LOJA, receiverId: 'conversou-chat' }],
    conversas: [{ userId: 'conversou-agente' }],
  });
  const policy = new ManagerDataAccessPolicy({ firestore });

  const documentos = ['cliente-1', 'conversou-chat', 'conversou-agente', 'estranho']
    .map((id) => ({ id, data: () => ({ name: 'x' }) }));
  const passaram = await policy.filterDocuments({
    actor, target: { kind: 'collection', path: 'Users' }, documents: documentos,
  });

  assert.deepEqual(passaram.map((d) => d.id), ['cliente-1', 'conversou-chat', 'conversou-agente']);
  assert.equal(registro.consultasDeConversa, 3, 'duas em Chats e uma em conversas');

  // os campos continuam peneirados pelo sanitizeDocument, sem ampliacao
  const peneirado = policy.sanitizeDocument('Users/conversou-chat', {
    name: 'Fulano', isTestAccount: true, provedoresDeLogin: ['phone'], cpf: '000', senha: 'x',
  });
  assert.deepEqual(
    Object.keys(peneirado).sort(),
    ['isTestAccount', 'name', 'provedoresDeLogin'],
  );
});

test('participante de conversa aceita isTestAccount e recusa campo fora da lista', async () => {
  const { firestore } = firestoreFalso({
    ...comLista([]),
    conversas: [{ userId: 'conversou-agente' }],
  });
  const policy = new ManagerDataAccessPolicy({ firestore });
  const mutacao = (data) => ({
    operation: 'update', target: { path: 'Users/conversou-agente' }, data,
  });

  await policy.assertMutation({ actor, mutation: mutacao({ isTestAccount: true }) });
  await policy.assertMutation({ actor, mutation: mutacao({ segmento: 'vip' }) });
  await assert.rejects(
    policy.assertMutation({ actor, mutation: mutacao({ name: 'outro' }) }),
    (error) => error.code === 'data_user_fields_forbidden',
  );
  await assert.rejects(
    policy.assertMutation({ actor, mutation: mutacao({ isTestAccount: 'sim' }) }),
    (error) => error.code === 'data_user_fields_forbidden',
  );
});

test('a lista de clientes e a de conversas ficam em cache por trinta minutos', async () => {
  let agora = 1_000_000;
  const { firestore, registro } = firestoreFalso({
    ...comLista(['cliente-1']),
    conversas: [{ userId: 'conversou-agente' }],
  });
  const policy = new ManagerDataAccessPolicy({ firestore, clock: () => agora });

  await policy.getReadableUserIds(actor);
  await policy.getReadableUserIds(actor);
  assert.equal(registro.leiturasDaLista, 1);
  assert.equal(registro.consultasDeConversa, 3);

  agora += 31 * 60 * 1000;
  await policy.getReadableUserIds(actor);
  assert.equal(registro.leiturasDaLista, 2, 'passados trinta minutos, le de novo');
  assert.equal(registro.consultasDeConversa, 6);
});
