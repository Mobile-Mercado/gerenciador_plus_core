const assert = require('node:assert/strict');
const test = require('node:test');
const {
  GRUPOS, GRUPOS_VERSAO, atualizarGruposDoPedido, classificarPedido, grupoDaCategoria, grupoDoProduto, precisaClassificar, valorDoItem,
} = require('./resumoDoMes');

test('tabela aprovada: categoria inteira, excecoes por prateleira e o resto em pet_e_outros', () => {
  assert.equal(grupoDaCategoria('FLV'), 'hortifruti');
  assert.equal(grupoDaCategoria('AÇOUGUE'), 'carnes_e_frios', 'sem acento e sem maiuscula');
  assert.equal(grupoDaCategoria('Pães & Bolos'), 'padaria_e_quitandas');
  assert.equal(grupoDaCategoria('Biscoitos'), 'mercearia');
  assert.equal(grupoDaCategoria('Sorvetes'), 'balas_doces_e_chocolates');
  assert.equal(grupoDaCategoria('Churrasco'), 'carnes_e_frios');
  assert.equal(grupoDaCategoria('Categoria Inventada'), 'pet_e_outros');
  // Por prateleira
  assert.equal(grupoDaCategoria('Laticínios', ['Iogurte']), 'carnes_e_frios');
  assert.equal(grupoDaCategoria('Laticínios', ['Manteiga/Margarina']), 'mercearia');
  assert.equal(grupoDaCategoria('Frios e Lácteos', ['Leite Pasteurizado']), 'mercearia');
  assert.equal(grupoDaCategoria('Padaria', ['Chocolate']), 'balas_doces_e_chocolates');
  assert.equal(grupoDaCategoria('Padaria', ['Café']), 'mercearia');
  assert.equal(grupoDaCategoria('Padaria', ['Pão Francês']), 'padaria_e_quitandas');
  assert.equal(grupoDaCategoria('Hortifruti', ['Mercearia']), 'mercearia');
  assert.equal(grupoDaCategoria('Mercearia', ['Água Mineral']), 'bebidas');
  assert.equal(grupoDaCategoria('Mercearia', ['Arroz']), 'mercearia', 'demais');
  assert.equal(grupoDaCategoria('Matinal', ['Doces']), 'balas_doces_e_chocolates');
  assert.equal(grupoDaCategoria('Matinal', ['Café']), 'mercearia');
  assert.equal(grupoDaCategoria('Congelados', ['Pão de Queijo']), 'padaria_e_quitandas');
  assert.equal(grupoDaCategoria('Congelados', ['Sorvete/Açaí']), 'balas_doces_e_chocolates');
  assert.equal(grupoDaCategoria('Congelados', ['Gelo']), 'pet_e_outros', 'prateleira fora da tabela');
  assert.equal(grupoDaCategoria('ILHAS E CONGELADOS', ['Pratos Prontos']), 'mercearia');
  assert.equal(grupoDaCategoria('Ilhas e Congelados', ['Hambúrguer']), 'carnes_e_frios');
  // Produto em "Todos" e numa categoria de verdade: vale a de verdade.
  assert.equal(grupoDoProduto([{ nome: 'Todos', prateleiras: [] }, { nome: 'Bebidas', prateleiras: [] }]), 'bebidas');
  assert.equal(grupoDoProduto([]), 'pet_e_outros');
  assert.equal(GRUPOS.length, 8);
});

test('valor do item: o mesmo totalSeparated do app (removido 0, pesado pelas medidas, margem de erro)', () => {
  assert.equal(valorDoItem({ quantity: 3, product: { price: 2.5 } }), 7.5);
  assert.equal(valorDoItem({ quantity: 2, quantityChosen: { maxQuantity: 3 }, product: { price: 1 } }), 6);
  assert.equal(valorDoItem({ quantity: 1, product: { price: 10, quantityInterval: { marginOfError: 10 } } }), 11);
  assert.equal(valorDoItem({ quantity: 1, product: { price: 40 }, separated: { measures: [0.5, 0.25] } }), 30);
  assert.equal(valorDoItem({ quantity: 4, product: { price: 9 }, separated: { hasRemoved: true } }), 0);
});

const META = {
  produtos: new Map([
    ['p-leite', { categroyIds: ['cat-latic'], subcategoriesIds: ['sub-leite'] }],
    ['p-queijo', { categoriesIds: ['cat-latic'], subcategoriesIds: ['sub-queijo'] }],
    ['p-cerveja', { category: 'cat-bebidas' }],
    ['p-sem-categoria', {}],
  ]),
  categorias: new Map([['cat-latic', 'Laticínios'], ['cat-bebidas', 'Bebidas']]),
  prateleiras: new Map([['sub-leite', { nome: 'Leite', categoriaId: 'cat-latic' }], ['sub-queijo', { nome: 'Queijos', categoriaId: 'cat-latic' }]]),
};

test('pedido: gruposDosItens pelo id do item e resumoPorGrupo com os 8 grupos', () => {
  const pedido = {
    productsCart: [
      { id: 'i1', productRef: 'estabelecimentos/l/Products/p-leite', quantity: 2, product: { price: 5 } },
      { id: 'i2', productRef: { id: 'p-queijo' }, quantity: 1, product: { price: 20 } },
      { id: 'i3', product: { id: 'p-cerveja', price: 3 }, quantity: 6 },
      { id: 'i4', productRef: { id: 'p-sem-categoria' }, quantity: 1, product: { price: 7 } },
      { id: 'i5', productRef: { id: 'p-queijo' }, quantity: 1, product: { price: 99 }, separated: { hasRemoved: true } },
    ],
  };
  const resultado = classificarPedido(pedido, META);
  assert.deepEqual(resultado.gruposDosItens, { i1: 'mercearia', i2: 'carnes_e_frios', i3: 'bebidas', i4: 'pet_e_outros', i5: 'carnes_e_frios' });
  assert.deepEqual(resultado.resumoPorGrupo, {
    hortifruti: 0, carnes_e_frios: 20, padaria_e_quitandas: 0, higiene_e_limpeza: 0, mercearia: 10, balas_doces_e_chocolates: 0, bebidas: 18, pet_e_outros: 7,
  });
  assert.equal(resultado.gruposVersao, GRUPOS_VERSAO);
});

test('quando classificar: pedido novo, productsCart mudou ou tabela nova; a propria gravacao nao dispara de novo', () => {
  const cart = [{ id: 'i1', quantity: 1 }];
  assert.equal(precisaClassificar(null, null), false, 'pedido apagado');
  assert.equal(precisaClassificar(null, { productsCart: cart }), true, 'pedido novo');
  const classificado = { productsCart: cart, resumoPorGrupo: {}, gruposVersao: GRUPOS_VERSAO };
  assert.equal(precisaClassificar({ productsCart: cart }, classificado), false, 'so os campos do grupo mudaram');
  assert.equal(precisaClassificar(classificado, { ...classificado, currentPurchaseStatus: 'x' }), false, 'mudou o status');
  assert.equal(precisaClassificar(classificado, { ...classificado, productsCart: [{ id: 'i1', quantity: 2 }] }), true, 'separacao');
  assert.equal(precisaClassificar(classificado, { ...classificado, gruposVersao: 0 }), true, 'tabela nova');
});

test('gatilho: le produto, lista padrao e loja e grava so os tres campos', async () => {
  const docs = new Map([
    ['estabelecimentos/loja-1/Products/p1', { categroyIds: ['padrao-bebidas', 'cat-loja'] }],
    ['categoriasProdutos/padrao-bebidas', { nome: 'Bebidas' }],
    ['estabelecimentos/loja-1/ProductCategories/cat-loja', { name: 'Todos' }],
  ]);
  const snap = (caminho) => ({
    id: caminho.split('/').at(-1), exists: docs.has(caminho), data: () => docs.get(caminho), get: (campo) => docs.get(caminho)?.[campo],
  });
  const ref = (caminho) => ({ path: caminho, collection: (nome) => colecao(`${caminho}/${nome}`) });
  const colecao = (caminho) => ({ doc: (id) => ref(`${caminho}/${id}`) });
  const db = { collection: (nome) => colecao(nome), getAll: async (...refs) => refs.map((r) => snap(r.path)) };
  const gravacoes = [];
  const pedido = { companyReference: { id: 'loja-1' }, productsCart: [{ id: 'i1', productRef: { id: 'p1' }, quantity: 2, product: { price: 4 } }] };
  const resultado = await atualizarGruposDoPedido({ db, ref: { update: async (dados) => gravacoes.push(dados) }, antes: null, depois: pedido });
  assert.deepEqual(resultado.gruposDosItens, { i1: 'bebidas' });
  assert.equal(gravacoes.length, 1);
  assert.deepEqual(Object.keys(gravacoes[0]).sort(), ['gruposDosItens', 'gruposVersao', 'resumoPorGrupo']);
  assert.equal(gravacoes[0].resumoPorGrupo.bebidas, 8);
  // Gravado o grupo, a mesma lista de itens nao grava de novo.
  assert.equal(await atualizarGruposDoPedido({ db, ref: { update: async () => assert.fail('gravou de novo') }, antes: pedido, depois: { ...pedido, ...gravacoes[0] } }), null);
});
