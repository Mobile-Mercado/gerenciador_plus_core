const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SEM_GIRO_LIMIT,
  atualizarSemGiro,
  calcularSemGiro,
  mesesDaLista,
} = require('./semGiro');

const produto = (id, estoque, extra = {}) => ({ id, name: `Produto ${id}`, isActive: true, isTrashed: false, quantityInStock: estoque, ...extra });
const vendas = (produtos) => ({ produtos });

test('a tabela mostra seis linhas, como no painel', () => {
  assert.equal(SEM_GIRO_LIMIT, 6);
});

test('produto vendido no mes atual ou no anterior sai da lista', () => {
  const { produtos } = calcularSemGiro({
    produtos: [produto('a', 10), produto('b', 20), produto('c', 30)],
    resumoMesAtual: vendas({ a: { nome: 'A', qtd: 1, valor: 5 } }),
    resumoMesAnterior: vendas({ b: { nome: 'B', qtd: 2, valor: 5 } }),
  });
  assert.deepEqual(produtos.map((p) => p.id), ['c']);
});

test('venda que zerou (qtd 0) nao conta como vendido', () => {
  const { produtos } = calcularSemGiro({
    produtos: [produto('a', 10)],
    resumoMesAtual: vendas({ a: { nome: 'A', qtd: 0, valor: 0 } }),
  });
  assert.deepEqual(produtos.map((p) => p.id), ['a']);
});

test('qtd e somada nos dois meses, como o rankingDoPeriodo do painel', () => {
  const { produtos } = calcularSemGiro({
    produtos: [produto('a', 10)],
    resumoMesAtual: vendas({ a: { qtd: 2 } }),
    resumoMesAnterior: vendas({ a: { qtd: -2 } }),
  });
  assert.deepEqual(produtos.map((p) => p.id), ['a'], 'soma zero nao e venda');
});

test('produto inativo e produto na lixeira saem', () => {
  const { produtos, total } = calcularSemGiro({
    produtos: [produto('a', 10, { isActive: false }), produto('b', 20, { isTrashed: true }), produto('c', 5), produto('d', 7, { isActive: 'true' })],
  });
  assert.deepEqual(produtos.map((p) => p.id), ['c']);
  assert.equal(total, 1);
});

test('ordem por estoque do maior para o menor, empate na ordem do catalogo', () => {
  const { produtos } = calcularSemGiro({
    produtos: [produto('a', 5), produto('b', 50), produto('c', 5), produto('d', 999)],
  });
  assert.deepEqual(produtos.map((p) => p.id), ['d', 'b', 'a', 'c']);
});

test('nome cai para o id e estoque que nao e numero vale zero', () => {
  const { produtos } = calcularSemGiro({
    produtos: [produto('a', '12', { name: '' }), produto('b', null), produto('c', 3)],
  });
  assert.deepEqual(produtos, [
    { id: 'c', nome: 'Produto c', estoque: 3 },
    { id: 'a', nome: 'a', estoque: 0 },
    { id: 'b', nome: 'Produto b', estoque: 0 },
  ]);
});

test('corte no limite e total antes do corte', () => {
  const lista = Array.from({ length: 10 }, (_, i) => produto(`p${i}`, i));
  const { produtos, total } = calcularSemGiro({ produtos: lista });
  assert.equal(produtos.length, 6);
  assert.deepEqual(produtos.map((p) => p.estoque), [9, 8, 7, 6, 5, 4]);
  assert.equal(total, 10);
  assert.equal(calcularSemGiro({ produtos: lista, limite: 2 }).produtos.length, 2);
});

test('sem catalogo e sem resumo, lista vazia', () => {
  assert.deepEqual(calcularSemGiro({}), { produtos: [], total: 0 });
});

test('meses no fuso de Sao Paulo, inclusive na virada do ano', () => {
  assert.deepEqual(mesesDaLista(new Date('2026-10-01T01:00:00Z')), ['2026-09', '2026-08']);
  assert.deepEqual(mesesDaLista(new Date('2026-10-03T12:00:00Z')), ['2026-10', '2026-09']);
  assert.deepEqual(mesesDaLista(new Date('2027-01-15T12:00:00Z')), ['2027-01', '2026-12']);
});

test('atualizarSemGiro le so os campos usados, os dois meses, e grava o documento', async () => {
  const registro = { consultas: [], gravado: null };
  const docs = {
    'ResumoVendas/2026-10': { produtos: { a: { qtd: 1 } } },
    'ResumoVendas/2026-09': { produtos: {} },
  };
  const db = {
    collection: () => ({
      doc: () => ({
        collection: (colecao) => ({
          where: (campo, op, valor) => ({
            select: (...campos) => ({
              async get() {
                registro.consultas.push({ colecao, campo, op, valor, campos });
                return { docs: [produto('a', 10), produto('b', 20)].map((p) => ({ id: p.id, data: () => ({ ...p }) })) };
              },
            }),
          }),
          doc: (id) => ({
            async get() { const dados = docs[`${colecao}/${id}`]; return { exists: Boolean(dados), data: () => dados }; },
            async set(dados) { registro.gravado = { caminho: `${colecao}/${id}`, dados }; },
          }),
        }),
      }),
    }),
  };
  const FieldValue = { serverTimestamp: () => ({ serverTimestamp: true }) };
  const resultado = await atualizarSemGiro({ db, FieldValue, lojaId: 'loja-1', agora: new Date('2026-10-03T12:00:00Z') });
  assert.deepEqual(registro.consultas, [{
    colecao: 'Products', campo: 'isTrashed', op: '==', valor: false, campos: ['name', 'isActive', 'isTrashed', 'quantityInStock'],
  }]);
  assert.equal(registro.gravado.caminho, 'Stats/semGiro');
  assert.deepEqual(registro.gravado.dados, {
    produtos: [{ id: 'b', nome: 'Produto b', estoque: 20 }],
    total: 1,
    meses: ['2026-10', '2026-09'],
    versao: 1,
    atualizadoEm: { serverTimestamp: true },
  });
  assert.equal(resultado.catalogo, 2);
});
