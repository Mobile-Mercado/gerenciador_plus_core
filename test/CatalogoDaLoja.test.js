import assert from 'node:assert/strict';
import test from 'node:test';
import { CatalogoDaLoja } from '../src/application/catalogo/CatalogoDaLoja.js';
import { TravasDeCategoria } from '../src/application/catalogo/TravasDeCategoria.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

const ATOR = { uid: 'uid-dono', establishmentId: 'loja-a', hasEstablishment: true };

function banco(extra = {}) {
  return new FirestoreEmMemoria({
    'categoriasProdutos/bebidas': { nome: 'Bebidas', name: 'Bebidas', icon: 'https://icone/bebidas.svg', order: 4, isActive: true },
    'categoriasProdutos/tabacaria': { nome: 'Tabacaria', name: 'Tabacaria', icon: 'https://icone/tabacaria.svg', isActive: true, travada: true },
    'categoriasProdutos/limpeza': { nome: 'Limpeza', name: 'Limpeza', isActive: false },
    'categoriasProdutos/antiga': { nome: 'Antiga', name: 'Antiga', isActive: true, arquivada: true },
    'categoriasProdutos/padaria': { nome: 'Padaria', name: 'Padaria', isActive: true },
    'subcategoriasProdutos/refri': { nome: 'Refrigerantes', categoriaProdutoId: 'bebidas' },
    'subcategoriasProdutos/cigarro_e_fumo': { nome: 'Cigarro e Fumo', categoriaProdutoId: 'tabacaria' },
    'subcategoriasProdutos/paes': { nome: 'Pães', categoriaProdutoId: 'padaria' },
    // A loja ja tem a Padaria, desligada e sem o campo id.
    'estabelecimentos/loja-a/ProductCategories/padaria': { name: 'Padaria', isActive: false },
    ...extra,
  });
}

function catalogo(firestore) {
  return new CatalogoDaLoja({ firestore, travas: new TravasDeCategoria({ firestore }) });
}

test('a lista para ativar tem so o que esta ligado no padrao, sem trava e fora da loja', async () => {
  const disponivel = await catalogo(banco()).padraoDisponivel(ATOR);
  assert.deepEqual(disponivel.categorias.map((item) => item.id), ['bebidas']);
  assert.deepEqual(disponivel.subcategorias.map((item) => item.id).sort(), ['paes', 'refri']);
  assert.equal(disponivel.subcategorias.find((item) => item.id === 'paes').categoriaNaLoja, true);
});

test('ativar copia por id, com o nome e o icone da lista padrao', async () => {
  const firestore = banco();
  await catalogo(firestore).ativar(ATOR, { tipo: 'categoria', id: 'bebidas' });
  const criada = firestore.dados('estabelecimentos/loja-a/ProductCategories/bebidas');
  assert.equal(criada.id, 'bebidas');
  assert.equal(criada.name, 'Bebidas');
  assert.equal(criada.icon, 'https://icone/bebidas.svg');
  assert.equal(criada.isActive, true);
});

test('ativar subcategoria traz a categoria quando a loja nao tem', async () => {
  const firestore = banco();
  const resultado = await catalogo(firestore).ativar(ATOR, { tipo: 'subcategoria', id: 'refri' });
  assert.deepEqual(resultado.criadas.map((item) => item.id), ['bebidas', 'refri']);
  assert.equal(firestore.dados('estabelecimentos/loja-a/ProductSubcategories/refri').categoryId, 'bebidas');
});

test('ativar recusa o que a loja ja tem, ligado ou desligado, pelo caminho do documento', async () => {
  const firestore = banco();
  await assert.rejects(
    catalogo(firestore).ativar(ATOR, { tipo: 'categoria', id: 'padaria' }),
    (error) => error.code === 'catalogo_ja_na_loja',
  );
  const escritas = firestore.escritas.length;
  await catalogo(firestore).ativar(ATOR, { tipo: 'categoria', id: 'bebidas' });
  await assert.rejects(catalogo(firestore).ativar(ATOR, { tipo: 'categoria', id: 'bebidas' }), (error) => error.code === 'catalogo_ja_na_loja');
  assert.equal(firestore.escritas.length, escritas + 1);
});

test('ativar recusa categoria travada e subcategoria de categoria travada', async () => {
  const firestore = banco();
  await assert.rejects(catalogo(firestore).ativar(ATOR, { tipo: 'categoria', id: 'tabacaria' }), (error) => error.code === 'categoria_travada');
  await assert.rejects(catalogo(firestore).ativar(ATOR, { tipo: 'subcategoria', id: 'cigarro_e_fumo' }), (error) => error.code === 'categoria_travada');
});

test('com liberacao para a loja, a travada ativa', async () => {
  const firestore = banco({ 'liberacoesCategorias/loja-a': { liberadas: { tabacaria: { por: 'uid-thay' } } } });
  await catalogo(firestore).ativar(ATOR, { tipo: 'categoria', id: 'tabacaria' });
  assert.equal(firestore.dados('estabelecimentos/loja-a/ProductCategories/tabacaria').icon, 'https://icone/tabacaria.svg');
});

test('ativar recusa item desligado ou arquivado na lista padrao', async () => {
  const firestore = banco();
  await assert.rejects(catalogo(firestore).ativar(ATOR, { tipo: 'categoria', id: 'limpeza' }), (error) => error.code === 'catalogo_indisponivel');
  await assert.rejects(catalogo(firestore).ativar(ATOR, { tipo: 'categoria', id: 'antiga' }), (error) => error.code === 'catalogo_indisponivel');
});

test('nome de exibicao e formatado, unico na loja e vazio volta ao padrao', async () => {
  const firestore = banco({ 'estabelecimentos/loja-a/ProductCategories/bebidas': { name: 'Bebidas', isActive: true } });
  const loja = catalogo(firestore);
  const resultado = await loja.nomeDeExibicao(ATOR, { tipo: 'categoria', id: 'bebidas', nome: 'BEBIDAS GELADAS' });
  assert.equal(resultado.nomeExibicao, 'Bebidas Geladas');
  assert.equal(resultado.nomePadrao, 'Bebidas');
  assert.equal(firestore.dados('estabelecimentos/loja-a/ProductCategories/bebidas').name, 'Bebidas');
  await assert.rejects(
    loja.nomeDeExibicao(ATOR, { tipo: 'categoria', id: 'padaria', nome: 'bebidas geladas' }),
    (error) => error.code === 'catalogo_nome_repetido',
  );
  await loja.nomeDeExibicao(ATOR, { tipo: 'categoria', id: 'bebidas', nome: '' });
  assert.equal(firestore.dados('estabelecimentos/loja-a/ProductCategories/bebidas').nomeExibicao, undefined);
});

test('conta sem loja nao usa o catalogo da loja', async () => {
  await assert.rejects(catalogo(banco()).padraoDisponivel({ uid: 'x', establishmentId: null }), (error) => error.statusCode === 403);
});
