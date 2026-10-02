const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RESUMO_COLLECTION,
  RESUMO_VERSION,
  TOTAL_DE_BLOCOS,
  blocoDoCliente,
  resumirCliente,
  segmentoDoCliente,
} = require('./resumoClientes');

const DIA = 86400000;
const AGORA = new Date('2026-10-02T15:00:00.000Z');
const diasAtras = (dias) => new Date(AGORA.getTime() - dias * DIA);
// Timestamp de mentira, como o Firestore entrega.
const ts = (date) => ({ toDate: () => date });

function pedido(extra = {}) {
  return {
    clientId: 'cliente-1',
    clientName: 'Nome do Pedido',
    currentPurchaseStatus: 'PurchaseStatus.completed',
    createdAt: ts(diasAtras(1)),
    total: 50,
    ...extra,
  };
}

test('constantes do resumo', () => {
  assert.equal(RESUMO_VERSION, 1);
  assert.equal(RESUMO_COLLECTION, 'ResumoClientes');
  assert.equal(TOTAL_DE_BLOCOS, 16);
});

test('pedido cancelado, negado ou pendente nao conta', () => {
  const resumo = resumirCliente({
    pedidos: [
      pedido({ total: 10 }),
      pedido({ currentPurchaseStatus: 'PurchaseStatus.canceled', total: 1000 }),
      pedido({ currentPurchaseStatus: 'PurchaseStatus.denied', total: 1000 }),
      pedido({ currentPurchaseStatus: 'PurchaseStatus.pending', total: 1000 }),
    ],
    usuario: null,
  });
  assert.equal(resumo.pedidos, 1);
  assert.equal(resumo.ltv, 10);
});

test('sem pedido valido devolve null', () => {
  assert.equal(resumirCliente({ pedidos: [pedido({ currentPurchaseStatus: 'PurchaseStatus.giveUp' })], usuario: null }), null);
  assert.equal(resumirCliente({ pedidos: [], usuario: null }), null);
});

test('isTest nao conta e isTestAccount marca contaDeTeste sem tirar o pedido', () => {
  assert.equal(resumirCliente({ pedidos: [pedido({ isTest: true })], usuario: null }), null);

  const marcado = resumirCliente({ pedidos: [pedido({ isTestAccount: true }), pedido()], usuario: null });
  assert.equal(marcado.contaDeTeste, true);
  assert.equal(marcado.pedidos, 2);

  const peloUsuario = resumirCliente({ pedidos: [pedido()], usuario: { isTestAccount: true } });
  assert.equal(peloUsuario.contaDeTeste, true);

  assert.equal(resumirCliente({ pedidos: [pedido()], usuario: {} }).contaDeTeste, false);
});

test('LTV soma os totais e o total sem campo direto vem dos itens', () => {
  const semTotal = pedido({
    total: undefined,
    productsCart: [
      { quantity: 2, price: 10 },
      { totalPrice: '7,50' },
      { product: { price: 3 } },
    ],
  });
  const resumo = resumirCliente({ pedidos: [pedido({ total: '100,25' }), semTotal], usuario: null });
  assert.equal(resumo.ltv, 100.25 + 20 + 7.5 + 3);
});

test('primeira e ultima compra e frequencia com 1, 2 e 3 pedidos', () => {
  const um = resumirCliente({ pedidos: [pedido({ createdAt: ts(diasAtras(5)) })], usuario: null });
  assert.deepEqual(um.primeiroPedidoEm, diasAtras(5));
  assert.deepEqual(um.ultimoPedidoEm, diasAtras(5));
  assert.equal(um.frequenciaDias, null);

  const dois = resumirCliente({
    pedidos: [pedido({ createdAt: ts(diasAtras(2)) }), pedido({ createdAt: ts(diasAtras(12)) })],
    usuario: null,
  });
  assert.deepEqual(dois.primeiroPedidoEm, diasAtras(12));
  assert.deepEqual(dois.ultimoPedidoEm, diasAtras(2));
  assert.equal(dois.frequenciaDias, 10);

  const tres = resumirCliente({
    pedidos: [
      pedido({ createdAt: ts(diasAtras(10)) }),
      pedido({ createdAt: ts(diasAtras(1)) }),
      pedido({ createdAt: ts(diasAtras(20)) }),
    ],
    usuario: null,
  });
  assert.deepEqual(tres.primeiroPedidoEm, diasAtras(20));
  assert.deepEqual(tres.ultimoPedidoEm, diasAtras(1));
  assert.equal(tres.frequenciaDias, (10 + 9) / 2);
});

test('data do pedido cai para scheduling e depois para updatedAt', () => {
  const resumo = resumirCliente({
    pedidos: [
      pedido({ createdAt: null, scheduling: ts(diasAtras(3)) }),
      pedido({ createdAt: null, updatedAt: ts(diasAtras(9)) }),
    ],
    usuario: null,
  });
  assert.deepEqual(resumo.ultimoPedidoEm, diasAtras(3));
  assert.deepEqual(resumo.primeiroPedidoEm, diasAtras(9));
});

test('nome, email e telefone vem do usuario e, sem usuario, do pedido mais recente', () => {
  const pedidos = [
    pedido({ createdAt: ts(diasAtras(9)), clientEmail: 'velho@exemplo.test', clientPhone: '111' }),
    pedido({ createdAt: ts(diasAtras(1)), clientEmail: 'novo@exemplo.test', clientPhone: '222' }),
  ];

  const comUsuario = resumirCliente({
    pedidos,
    usuario: { name: 'Nome do Cadastro', email: 'cadastro@exemplo.test', telefone: '333' },
  });
  assert.equal(comUsuario.nome, 'Nome do Cadastro');
  assert.equal(comUsuario.email, 'cadastro@exemplo.test');
  assert.equal(comUsuario.telefone, '333');

  const semUsuario = resumirCliente({ pedidos, usuario: null });
  assert.equal(semUsuario.nome, 'Nome do Pedido');
  assert.equal(semUsuario.email, 'novo@exemplo.test');
  assert.equal(semUsuario.telefone, '222');
});

test('demais campos do usuario: chave, endereco, cpf, cadastro, provedores e aniversario', () => {
  const nascimento = ts(new Date('1990-05-04T03:00:00.000Z'));
  const resumo = resumirCliente({
    pedidos: [pedido({ createdAt: ts(diasAtras(4)) })],
    usuario: {
      nome: 'Nome em Portugues',
      cpf: '000.000.000-00',
      createAt: ts(diasAtras(400)),
      deliveryAddressSelected: { street: 'Rua A', number: '10', city: 'Cidade', uf: 'UF' },
      provedoresDeLogin: ['google'],
      birthday: nascimento,
      dataNascimento: 'ignorado',
    },
  });
  assert.equal(resumo.chave, 'cliente-1');
  assert.equal(resumo.userId, 'cliente-1');
  assert.equal(resumo.nome, 'Nome em Portugues');
  assert.equal(resumo.endereco, 'Rua A, 10, Cidade, UF');
  assert.equal(resumo.cpf, '000.000.000-00');
  assert.deepEqual(resumo.cadastroEm, diasAtras(400));
  assert.deepEqual(resumo.provedoresDeLogin, ['google']);
  assert.equal(resumo.aniversario, nascimento);
  assert.equal(resumo.versaoResumo, RESUMO_VERSION);

  const semUsuario = resumirCliente({ pedidos: [pedido({ createdAt: ts(diasAtras(4)) })], usuario: null });
  assert.deepEqual(semUsuario.cadastroEm, diasAtras(4));
  assert.deepEqual(semUsuario.provedoresDeLogin, []);
  assert.equal(semUsuario.aniversario, null);
  assert.equal(semUsuario.cpf, '');
});

test('pedido sem cliente agrupa pelo nome normalizado', () => {
  const resumo = resumirCliente({ pedidos: [pedido({ clientId: undefined, clientName: '  José Ávila ' })], usuario: { name: 'Nao usado' } });
  assert.equal(resumo.chave, 'name:jose avila');
  assert.equal(resumo.userId, '');
  assert.equal(resumo.nome, '  José Ávila ');
});

test('blocoDoCliente e estavel e fica entre 00 e 15', () => {
  // FNV-1a 32 bits de 'a' e 0xe40c292c; 0xe40c292c % 16 = 12.
  assert.equal(blocoDoCliente('a'), '12');
  assert.equal(blocoDoCliente('cliente-1'), blocoDoCliente('cliente-1'));
  const vistos = new Set();
  for (let i = 0; i < 2000; i += 1) {
    const bloco = blocoDoCliente(`cliente-${i}`);
    assert.match(bloco, /^(0\d|1[0-5])$/);
    vistos.add(bloco);
  }
  assert.equal(vistos.size, TOTAL_DE_BLOCOS);
});

function resumoDe({ pedidos, ltv, diasDesdeUltimo, frequenciaDias = null }) {
  return { pedidos, ltv, ultimoPedidoEm: diasAtras(diasDesdeUltimo), frequenciaDias };
}

test('os seis segmentos', () => {
  const segmento = (resumo, ltvMedio = 100) => segmentoDoCliente({ resumo, ltvMedio, agora: AGORA });

  assert.equal(segmento(resumoDe({ pedidos: 12, ltv: 900, diasDesdeUltimo: 60 })), 'Inativo');
  assert.equal(segmento(resumoDe({ pedidos: 2, ltv: 100, diasDesdeUltimo: 30 })), 'Em risco');
  assert.equal(segmento(resumoDe({ pedidos: 10, ltv: 125, diasDesdeUltimo: 2 })), 'VIP');
  assert.equal(segmento(resumoDe({ pedidos: 2, ltv: 100, diasDesdeUltimo: 2, frequenciaDias: 3 })), 'Novo');
  assert.equal(segmento(resumoDe({ pedidos: 5, ltv: 10, diasDesdeUltimo: 2, frequenciaDias: 40 })), 'Fiel');
  assert.equal(segmento(resumoDe({ pedidos: 3, ltv: 100, diasDesdeUltimo: 2, frequenciaDias: 20 })), 'Regular');
});

test('segmento: um pedido so com 30 dias ainda e Novo, e frequencia curta vira Fiel', () => {
  const segmento = (resumo) => segmentoDoCliente({ resumo, ltvMedio: 100, agora: AGORA });
  assert.equal(segmento(resumoDe({ pedidos: 1, ltv: 100, diasDesdeUltimo: 45 })), 'Novo');
  assert.equal(segmento(resumoDe({ pedidos: 3, ltv: 100, diasDesdeUltimo: 2, frequenciaDias: 14 })), 'Fiel');
});

test('segmento sem data de ultimo pedido conta como Inativo', () => {
  assert.equal(segmentoDoCliente({ resumo: { pedidos: 1, ltv: 10, ultimoPedidoEm: null, frequenciaDias: null }, ltvMedio: 10, agora: AGORA }), 'Inativo');
});

// ----- cadastroMudou e recalcularCliente -----

const { cadastroMudou, recalcularCliente } = require('./resumoClientes');

test('cadastroMudou: nome muda, segmento nao conta, sem mudanca e falso', () => {
  const antes = { name: 'Ana', segmento: 'Novo', createdAt: ts(diasAtras(10)), lastSeen: 1 };
  assert.equal(cadastroMudou(antes, { ...antes, name: 'Ana Maria' }), true);
  assert.equal(cadastroMudou(antes, { ...antes, segmento: 'Fiel' }), false);
  assert.equal(cadastroMudou(antes, { ...antes, lastSeen: 2 }), false);
  assert.equal(cadastroMudou(antes, { ...antes, createdAt: ts(diasAtras(10)) }), false);
  assert.equal(cadastroMudou(antes, { ...antes }), false);
  assert.equal(cadastroMudou(null, { name: 'Ana' }), true);
});

// FieldValue e Firestore de mentira. O set com merge mescla o mapa clientes como o
// Firestore faz, e o sentinela de delete tira a entrada. Gravacao em Stats (o marcador)
// fica separada, em registro.marcas.
const DELETE = { delete: true };
const FieldValueFalso = {
  delete: () => DELETE,
  increment: (n) => ({ increment: n }),
  serverTimestamp: () => ({ serverTimestamp: true }),
};

function firestoreDoResumo({ pedidos = [], usuarios = {}, blocos = {} } = {}) {
  const registro = { blocos: JSON.parse(JSON.stringify(blocos)), sets: [], consultas: [], marcas: [] };
  const consulta = (filtros = []) => ({
    where: (campo, _op, valor) => consulta([...filtros, [campo, valor]]),
    async get() {
      registro.consultas.push(filtros.map(([campo, valor]) => [campo, valor?.path || valor]));
      const achados = pedidos.filter((p) => filtros.every(([campo, valor]) => (
        campo === 'companyReference' ? p.companyReference.path === valor.path : p[campo] === valor
      )));
      return { docs: achados.map((dados) => ({ data: () => dados })) };
    },
  });
  const lojaDoc = (lojaId) => ({
    path: `estabelecimentos/${lojaId}`,
    collection: (subcolecao) => (subcolecao === 'Stats' ? {
      doc: (documento) => ({
        async set(dados, opcoes) {
          registro.marcas.push({ caminho: `estabelecimentos/${lojaId}/Stats/${documento}`, dados, opcoes });
        },
      }),
    } : {
      doc: (bloco) => {
        const chave = `${lojaId}/${bloco}`;
        return {
          async get() {
            const dados = registro.blocos[chave];
            return { exists: Boolean(dados), get: (campo) => dados?.[campo] };
          },
          async set(dados, opcoes) {
            registro.sets.push({ chave, dados, opcoes });
            const atual = registro.blocos[chave] || {};
            const clientes = { ...(atual.clientes || {}) };
            Object.entries(dados.clientes || {}).forEach(([id, entrada]) => {
              if (entrada === DELETE) delete clientes[id];
              else clientes[id] = { ...(clientes[id] || {}), ...entrada };
            });
            registro.blocos[chave] = { ...atual, ...dados, clientes };
          },
        };
      },
    }),
  });
  const db = {
    collection: (nome) => {
      if (nome === 'estabelecimentos') return { doc: lojaDoc };
      if (nome === 'Users') {
        return {
          doc: (id) => ({
            async get() { return { exists: Boolean(usuarios[id]), id, data: () => usuarios[id] }; },
          }),
        };
      }
      return consulta();
    },
  };
  return { db, registro };
}

const LOJA_REF = { path: 'estabelecimentos/loja-1' };
const pedidoDaLoja = (extra = {}) => pedido({ companyReference: LOJA_REF, ...extra });

test('recalcularCliente grava no bloco certo, com todos os campos e o segmento que ja existia', async () => {
  const bloco = blocoDoCliente('cliente-1');
  const { db, registro } = firestoreDoResumo({
    pedidos: [
      pedidoDaLoja({ total: 30 }),
      pedidoDaLoja({ total: 20 }),
      pedidoDaLoja({ clientId: 'outro', total: 999 }),
      pedidoDaLoja({ companyReference: { path: 'estabelecimentos/loja-2' }, total: 999 }),
    ],
    usuarios: { 'cliente-1': { name: 'Ana' } },
    blocos: { [`loja-1/${bloco}`]: { clientes: { 'cliente-1': { segmento: 'Fiel', pedidos: 1, campoVelho: 'x' } } } },
  });

  const resultado = await recalcularCliente({ db, FieldValue: FieldValueFalso, lojaId: 'loja-1', clienteId: 'cliente-1' });
  assert.deepEqual(resultado, { acao: 'gravou', bloco });
  assert.deepEqual(registro.consultas, [[['companyReference', 'estabelecimentos/loja-1'], ['clientId', 'cliente-1']]]);

  const { dados, opcoes } = registro.sets[0];
  assert.deepEqual(opcoes, { merge: true });
  assert.equal(dados.versaoResumo, RESUMO_VERSION);
  assert.deepEqual(dados.atualizadoEm, { serverTimestamp: true });
  const entrada = dados.clientes['cliente-1'];
  assert.equal(entrada.nome, 'Ana');
  assert.equal(entrada.pedidos, 2);
  assert.equal(entrada.ltv, 50);
  assert.equal(entrada.segmento, 'Fiel');
  assert.equal(entrada.aniversario, null);
  assert.equal(entrada.frequenciaDias, 0);
  assert.equal(entrada.campoVelho, undefined, 'a entrada gravada nao carrega campo de fora do resumo');
  assert.ok(Object.values(entrada).every((valor) => valor !== undefined));
});

test('recalcularCliente sem segmento anterior grava segmento null', async () => {
  const { db, registro } = firestoreDoResumo({ pedidos: [pedidoDaLoja()] });
  await recalcularCliente({ db, FieldValue: FieldValueFalso, lojaId: 'loja-1', clienteId: 'cliente-1' });
  assert.equal(registro.sets[0].dados.clientes['cliente-1'].segmento, null);
});

test('recalcularCliente remove o cliente que ficou sem pedido valido', async () => {
  const bloco = blocoDoCliente('cliente-1');
  const { db, registro } = firestoreDoResumo({
    pedidos: [pedidoDaLoja({ currentPurchaseStatus: 'PurchaseStatus.canceled' })],
    blocos: { [`loja-1/${bloco}`]: { clientes: { 'cliente-1': { segmento: 'Novo' }, 'cliente-2': { segmento: 'VIP' } } } },
  });

  const resultado = await recalcularCliente({ db, FieldValue: FieldValueFalso, lojaId: 'loja-1', clienteId: 'cliente-1' });
  assert.deepEqual(resultado, { acao: 'removeu', bloco });
  assert.deepEqual(registro.sets[0].dados, { clientes: { 'cliente-1': DELETE } });
  assert.deepEqual(registro.sets[0].opcoes, { merge: true });
  assert.deepEqual(Object.keys(registro.blocos[`loja-1/${bloco}`].clientes), ['cliente-2']);
});

test('recalcularCliente nao cria bloco so para remover', async () => {
  const { db, registro } = firestoreDoResumo({ pedidos: [] });
  const resultado = await recalcularCliente({ db, FieldValue: FieldValueFalso, lojaId: 'loja-1', clienteId: 'cliente-1' });
  assert.deepEqual(resultado, { acao: 'nada', bloco: blocoDoCliente('cliente-1') });
  assert.equal(registro.sets.length, 0);
});

const MARCA_DE_CLIENTES = {
  caminho: 'estabelecimentos/loja-1/Stats/marcador',
  dados: { clientes: { increment: 1 }, clientesEm: { serverTimestamp: true }, versaoMarcador: 1 },
  opcoes: { merge: true },
};

test('recalcularCliente soma clientes no marcador quando grava', async () => {
  const { db, registro } = firestoreDoResumo({ pedidos: [pedidoDaLoja()] });
  const { acao } = await recalcularCliente({ db, FieldValue: FieldValueFalso, lojaId: 'loja-1', clienteId: 'cliente-1' });
  assert.equal(acao, 'gravou');
  assert.deepEqual(registro.marcas, [MARCA_DE_CLIENTES]);
});

test('recalcularCliente soma clientes no marcador quando remove', async () => {
  const bloco = blocoDoCliente('cliente-1');
  const { db, registro } = firestoreDoResumo({
    pedidos: [],
    blocos: { [`loja-1/${bloco}`]: { clientes: { 'cliente-1': { segmento: 'Novo' } } } },
  });
  const { acao } = await recalcularCliente({ db, FieldValue: FieldValueFalso, lojaId: 'loja-1', clienteId: 'cliente-1' });
  assert.equal(acao, 'removeu');
  assert.deepEqual(registro.marcas, [MARCA_DE_CLIENTES]);
});

test('recalcularCliente nao soma clientes quando a acao e nada', async () => {
  const { db, registro } = firestoreDoResumo({ pedidos: [pedidoDaLoja({ isTest: true })] });
  const { acao } = await recalcularCliente({ db, FieldValue: FieldValueFalso, lojaId: 'loja-1', clienteId: 'cliente-1' });
  assert.equal(acao, 'nada');
  assert.deepEqual(registro.marcas, []);
});
