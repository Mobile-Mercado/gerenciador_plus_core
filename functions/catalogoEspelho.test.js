const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CAMPOS_LIDOS,
  ESPELHO_VERSION,
  emBlocos,
  gerarEspelho,
  lerEspelho,
  produtoDoEspelho,
  produtosDoEspelho,
} = require('./catalogoEspelho');
const { runEstablishmentPass } = require('./productImageFileCheck');
const { loadAgentConversationData, summarizeConversations } = require('./agenteConversas');
const { rodarResumoDeBuscas } = require('./buscasResumo');

const HOJE = new Date('2026-10-01T06:00:00Z');
const ONTEM = new Date('2026-09-30T06:00:00Z');

// Catalogo de mentira, com os casos que as tres rotinas olham.
const PRODUTOS = [
  {
    id: 'p1',
    name: 'Leite Integral Italac 1L',
    images: [{ fileUrl: 'https://firebasestorage.googleapis.com/v0/b/b/o/p1.jpg?alt=media' }, { fileUrl: 'https://x/segunda.jpg' }],
    tags: ['leite'],
    categoriesIds: ['bebidas'],
    isActive: true,
    currentPrice: 7.5,
    quantityInStock: 10,
    shelvesIds: ['bebidas_leites'],
    wordKeys: ['LEITE', 'INTEGRAL', 'ITALAC', '1L'],
    searchIndex: ['LEITE', 'INTEGRAL', 'ITALAC', '1L'],
    isTrashed: false,
  },
  {
    id: 'p2',
    name: 'Batatinha Frita 100g',
    images: [],
    tags: [],
    categoriesIds: [],
    isActive: true,
    currentPrice: 4,
    quantityInStock: 0,
    shelvesIds: [],
    wordKeys: [],
    searchIndex: [],
    isTrashed: false,
  },
  {
    id: 'p3',
    name: 'Arroz Branco 5kg',
    images: [{ fileUrl: 'https://firebasestorage.googleapis.com/v0/b/b/o/p3.jpg?alt=media' }],
    tags: ['arroz'],
    categoriesIds: ['mercearia'],
    isActive: true,
    currentPrice: 25,
    quantityInStock: 30,
    shelvesIds: ['mercearia_arroz'],
    wordKeys: ['ARROZ'],
    searchIndex: ['ARROZ'],
    isTrashed: false,
  },
];

// Firestore de mentira: Products, o espelho com seus blocos, SearchLogs, conversas,
// pedidos e as colecoes que a rotina de imagens consulta.
function firestoreFalso({ espelho = null, blocos = null, buscas = [] } = {}) {
  const registro = { leiturasDeProducts: 0, blocosGravados: {}, indice: espelho, blocosRemovidos: [] };

  const docDeProduto = (produto) => ({
    id: produto.id,
    data: () => produto,
    get: (campo) => produto[campo],
  });

  const consultaProdutos = (filtros = [], limite = null, depois = null) => ({
    where: () => consultaProdutos(filtros, limite, depois),
    orderBy: () => consultaProdutos(filtros, limite, depois),
    select: () => consultaProdutos(filtros, limite, depois),
    limit: (n) => consultaProdutos(filtros, n, depois),
    startAfter: (documento) => consultaProdutos(filtros, limite, documento),
    async get() {
      let lista = PRODUTOS.filter((produto) => !produto.isTrashed);
      if (depois) lista = lista.slice(lista.findIndex((p) => p.id === depois.id) + 1);
      if (limite) lista = lista.slice(0, limite);
      registro.leiturasDeProducts += lista.length;
      const docs = lista.map(docDeProduto);
      return { docs, size: docs.length, empty: !docs.length };
    },
  });

  const blocosDoEspelho = () => ({
    doc: (numero) => ({
      async set(dados) { registro.blocosGravados[numero] = dados; },
      async delete() { registro.blocosRemovidos.push(numero); delete registro.blocosGravados[numero]; },
    }),
    async get() {
      const fonte = blocos || registro.blocosGravados;
      const docs = Object.entries(fonte).map(([id, dados]) => ({ id, get: (campo) => dados[campo] }));
      return { docs, size: docs.length, empty: !docs.length };
    },
  });

  const docEspelho = {
    async get() {
      return { exists: Boolean(registro.indice), get: (campo) => (registro.indice || {})[campo] };
    },
    async set(dados) { registro.indice = dados; },
    collection: () => blocosDoEspelho(),
  };

  const docSimples = (guardado = {}) => ({
    async get() { return { exists: false, get: () => undefined, data: () => ({}) }; },
    async set(dados) { Object.assign(guardado, dados); },
    async delete() {},
    collection: () => ({ doc: () => docSimples(), async get() { return { docs: [], size: 0, empty: true }; } }),
  });

  const consultaBuscas = (filtros = []) => ({
    where: (campo, operador, valor) => consultaBuscas([...filtros, { campo, operador, valor }]),
    limit: () => consultaBuscas(filtros),
    async get() {
      const docs = buscas
        .filter((b) => filtros.every(({ operador, valor }) => {
          const quando = b.em.toDate();
          if (operador === '>=') return quando >= valor;
          if (operador === '<') return quando < valor;
          return true;
        }))
        .map((dados, i) => ({ id: `b${i}`, data: () => dados, get: (c) => dados[c], ref: { delete: async () => {} } }));
      return { docs, size: docs.length, empty: !docs.length };
    },
  });

  const colecoesVazias = (nome) => ({
    where: () => colecoesVazias(nome),
    orderBy: () => colecoesVazias(nome),
    select: () => colecoesVazias(nome),
    limit: () => colecoesVazias(nome),
    startAfter: () => colecoesVazias(nome),
    doc: () => docSimples(),
    async get() { return { docs: [], size: 0, empty: true }; },
    count: () => ({ get: async () => ({ data: () => ({ count: 0 }) }) }),
  });

  const storeRef = {
    id: 'loja-1',
    collection: (nome) => {
      if (nome === 'Products') return consultaProdutos();
      if (nome === 'SearchLogs') return consultaBuscas();
      if (nome === 'Stats') return { doc: (id) => (id === 'catalogoEspelho' ? docEspelho : docSimples()) };
      return colecoesVazias(nome);
    },
  };

  return { registro, storeRef };
}

function indiceDeHoje(extra = {}) {
  return {
    version: ESPELHO_VERSION, geradoEm: HOJE, total: 3, blocos: 1, tamanhoDoBloco: 1000, ...extra,
  };
}

function blocoUnico() {
  return { 0: { bloco: 0, produtos: PRODUTOS.map((p) => produtoDoEspelho(p.id, p)) } };
}

test('a linha do espelho guarda resultado, nao campo cru', () => {
  const linha = produtoDoEspelho('p2', PRODUTOS[1]);

  assert.equal(linha.buscaQuebrada, true, 'nome com palavras e chaves vazias: busca quebrada');
  assert.equal('wordKeys' in linha, false);
  assert.equal('searchIndex' in linha, false);
  assert.equal(produtoDoEspelho('p1', PRODUTOS[0]).buscaQuebrada, false);
  // so a primeira imagem, e so o fileUrl
  assert.deepEqual(produtoDoEspelho('p1', PRODUTOS[0]).images, [{ fileUrl: PRODUTOS[0].images[0].fileUrl }]);
  assert.deepEqual(
    Object.keys(linha).sort(),
    ['buscaQuebrada', 'categoriesIds', 'currentPrice', 'id', 'images', 'isActive', 'name', 'quantityInStock', 'shelvesIds', 'tags'],
  );
});

test('a lista de campos lidos cobre os tres consumidores', () => {
  ['name', 'images', 'tags', 'categoriesIds', 'isActive', 'currentPrice', 'quantityInStock', 'shelvesIds', 'wordKeys', 'searchIndex']
    .forEach((campo) => assert.ok(CAMPOS_LIDOS.includes(campo), campo));
});

test('gerarEspelho grava os blocos e o indice, e apara bloco que sobrou', async () => {
  const { storeRef, registro } = firestoreFalso({ espelho: { blocos: 3, total: 5000 } });

  const resultado = await gerarEspelho({ storeRef, geradoEm: HOJE, tamanhoDoBloco: 2 });

  assert.equal(resultado.total, 3);
  assert.equal(resultado.blocos, 2);
  assert.equal(resultado.blocosRemovidos, 1, 'o bloco 2 da passada anterior sai');
  assert.deepEqual(registro.blocosRemovidos, ['2']);
  assert.equal(registro.indice.total, 3);
  assert.equal(registro.indice.blocos, 2);
  assert.equal(registro.blocosGravados[0].produtos.length, 2);
  assert.equal(registro.blocosGravados[1].produtos.length, 1);
});

test('emBlocos nunca devolve lista vazia, para loja sem produto ter indice', () => {
  assert.deepEqual(emBlocos([], 2000), [[]]);
});

test('lerEspelho recusa indice ausente, de outro dia, bloco faltando e total errado', async () => {
  const semIndice = firestoreFalso();
  assert.equal((await lerEspelho({ storeRef: semIndice.storeRef, agora: HOJE })).motivo, 'sem-indice');

  const deOntem = firestoreFalso({ espelho: indiceDeHoje({ geradoEm: ONTEM }), blocos: blocoUnico() });
  assert.equal((await lerEspelho({ storeRef: deOntem.storeRef, agora: HOJE })).motivo, 'espelho-de-outro-dia');

  const semBlocos = firestoreFalso({ espelho: indiceDeHoje({ blocos: 2 }), blocos: blocoUnico() });
  assert.equal((await lerEspelho({ storeRef: semBlocos.storeRef, agora: HOJE })).motivo, 'blocos-nao-batem');

  const totalErrado = firestoreFalso({ espelho: indiceDeHoje({ total: 99 }), blocos: blocoUnico() });
  assert.equal((await lerEspelho({ storeRef: totalErrado.storeRef, agora: HOJE })).motivo, 'total-nao-bate');

  const bom = firestoreFalso({ espelho: indiceDeHoje(), blocos: blocoUnico() });
  const lido = await lerEspelho({ storeRef: bom.storeRef, agora: HOJE });
  assert.equal(lido.produtos.length, 3);
  assert.equal(lido.motivo, undefined);
});

test('produtosDoEspelho devolve a origem para o relatorio da noite', async () => {
  const bom = firestoreFalso({ espelho: indiceDeHoje(), blocos: blocoUnico() });
  const comEspelho = await produtosDoEspelho({ storeRef: bom.storeRef, agora: HOJE });
  assert.equal(comEspelho.origemDosProdutos, 'espelho');
  assert.equal(comEspelho.produtos.length, 3);

  const velho = firestoreFalso({ espelho: indiceDeHoje({ geradoEm: ONTEM }), blocos: blocoUnico() });
  const comRecuo = await produtosDoEspelho({ storeRef: velho.storeRef, agora: HOJE });
  assert.equal(comRecuo.produtos, null);
  assert.equal(comRecuo.origemDosProdutos, 'recuo:espelho-de-outro-dia');
});

// As tres rotinas: mesmo resultado lendo do espelho e lendo direto.
const checkerFalso = { check: async () => ({ reason: 'ok', status: 200 }), stats: () => ({}) };
const indiceDeImagens = { exists: async () => true, stats: () => ({}) };

async function passadaDeImagens({ storeRef, mirroredProducts }) {
  return runEstablishmentPass({
    storeRef,
    documentIdPath: 'id',
    index: indiceDeImagens,
    checker: checkerFalso,
    sampleSize: 0,
    random: () => 0,
    loadOrders: async () => [],
    loadTestAccountIds: async () => new Set(),
    now: HOJE,
    mirroredProducts,
  });
}

test('rotina de imagens: espelho e leitura direta dao o mesmo resumo', async () => {
  const direto = firestoreFalso();
  const comEspelho = firestoreFalso({ espelho: indiceDeHoje(), blocos: blocoUnico() });

  const semEspelho = await passadaDeImagens({ storeRef: direto.storeRef, mirroredProducts: null });
  const lido = await produtosDoEspelho({ storeRef: comEspelho.storeRef, agora: HOJE });
  const doEspelho = await passadaDeImagens({ storeRef: comEspelho.storeRef, mirroredProducts: lido.produtos });

  assert.ok(direto.registro.leiturasDeProducts > 0, 'o caminho direto le Products');
  assert.deepEqual(doEspelho, semEspelho);
  // a excecao nomeada: buscaQuebradaAVenda passa a medir nos dois caminhos
  assert.equal(semEspelho.buscaQuebradaAVenda, 1, 'p2 esta a venda sem chaves de busca');
  assert.equal(doEspelho.buscaQuebradaAVenda, 1);
});

test('rotina do agente: espelho e leitura direta dao o mesmo resumo', async () => {
  const bd = { collectionGroup: () => ({ where: () => ({ get: async () => ({ docs: [] }) }) }), collection: () => ({ where: () => ({ get: async () => ({ docs: [] }) }) }) };
  const direto = firestoreFalso();
  const comEspelho = firestoreFalso({ espelho: indiceDeHoje(), blocos: blocoUnico() });

  const dadosDiretos = await loadAgentConversationData({ db: bd, storeRef: direto.storeRef, documentIdPath: 'id' });
  const lido = await produtosDoEspelho({ storeRef: comEspelho.storeRef, agora: HOJE });
  const dadosDoEspelho = await loadAgentConversationData({
    db: bd, storeRef: comEspelho.storeRef, documentIdPath: 'id', mirroredProducts: lido.produtos,
  });

  assert.equal(dadosDiretos.origemDosProdutos, 'recuo');
  assert.equal(dadosDoEspelho.origemDosProdutos, 'espelho');
  assert.deepEqual([...dadosDoEspelho.dictionary].sort(), [...dadosDiretos.dictionary].sort());
  assert.deepEqual(
    summarizeConversations(dadosDoEspelho),
    summarizeConversations(dadosDiretos),
  );
});

test('rotina de buscas: espelho e leitura direta marcam o mesmo termo', async () => {
  const em = { toDate: () => new Date('2026-09-30T15:00:00Z') };
  const buscas = [
    { termo: 'BATATINHA', clienteId: 'c1', resultados: 0, em },
    { termo: 'QUIBOA', clienteId: 'c1', resultados: 0, em },
  ];
  const direto = firestoreFalso({ buscas });
  const comEspelho = firestoreFalso({ espelho: indiceDeHoje(), blocos: blocoUnico(), buscas });

  const semEspelho = await rodarResumoDeBuscas({
    storeRef: direto.storeRef, agora: HOJE, atualizadoEm: 'quando', limpar: false,
  });
  const lido = await produtosDoEspelho({ storeRef: comEspelho.storeRef, agora: HOJE });
  const doEspelho = await rodarResumoDeBuscas({
    storeRef: comEspelho.storeRef,
    agora: HOJE,
    atualizadoEm: 'quando',
    limpar: false,
    mirroredProducts: lido.produtos,
  });

  assert.equal(semEspelho.origemDosProdutos, 'recuo');
  assert.equal(doEspelho.origemDosProdutos, 'espelho');
  assert.equal(doEspelho.catalogoLido, semEspelho.catalogoLido);
  assert.equal(doEspelho.buscas, semEspelho.buscas);
  assert.equal(doEspelho.termosDistintos, semEspelho.termosDistintos);
});
