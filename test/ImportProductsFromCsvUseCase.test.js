import assert from 'node:assert/strict';
import test from 'node:test';
import { ImportProductsFromCsvUseCase } from '../src/application/implantacao/ImportProductsFromCsvUseCase.js';
import { TravasDeCategoria } from '../src/application/catalogo/TravasDeCategoria.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

const CSV = [
  'Nome;Preço;EAN;Mercadológico nível 1;Mercadológico nível 2',
  'Coca 2L;9,90;789001;BEBIDAS;REFRIGERANTES',
  'Arroz 5kg;25,00;789002;CEREAIS;ARROZ',
  'Cigarro X;12,00;789003;TABACARIA;CIGARRO E FUMO',
  'Suco Uva;7,00;789004;BEBIDAS DESLIGADAS;SUCOS',
  'Agua 500ml;2,00;789005;BEBIDAS;AGUAS',
].join('\n');

function banco() {
  return new FirestoreEmMemoria({
    'categoriasProdutos/tabacaria': { nome: 'Tabacaria', travada: true },
    'estabelecimentos/loja-a': { name: 'Loja A' },
    'estabelecimentos/loja-a/ProductCategories/bebidas': { name: 'BEBIDAS', isActive: true },
    'estabelecimentos/loja-a/ProductCategories/tabacaria': { name: 'TABACARIA', isActive: true },
    'estabelecimentos/loja-a/ProductCategories/desligada': { name: 'BEBIDAS DESLIGADAS', isActive: false },
    'estabelecimentos/loja-a/ProductSubcategories/refri': { name: 'REFRIGERANTES', categoryId: 'bebidas', isActive: true },
    'estabelecimentos/loja-a/ProductSubcategories/aguas': { name: 'AGUAS', categoryId: 'bebidas', isActive: false },
    'estabelecimentos/loja-a/ProductSubcategories/cigarro_e_fumo': { name: 'CIGARRO E FUMO', categoryId: 'tabacaria', isActive: true },
    'estabelecimentos/loja-a/ProductSubcategories/sucos': { name: 'SUCOS', categoryId: 'desligada', isActive: true },
    // Produto que ja existe, com prateleira escolhida pelo lojista.
    'estabelecimentos/loja-a/Products/existente': {
      barCode: '789005',
      shelves: [{ id: 'mercearia_agua', productCategoryId: 'mercearia', productSubcategoryId: 'agua' }],
      shelvesIds: ['mercearia_agua'],
    },
  });
}

function caso(firestore) {
  return new ImportProductsFromCsvUseCase({ firestore, travas: new TravasDeCategoria({ firestore }) });
}

function produtoPeloCodigo(firestore, codigo) {
  return [...firestore.docs.entries()].find(([caminho, dados]) => (
    caminho.startsWith('estabelecimentos/loja-a/Products/') && caminho.split('/').length === 4 && dados.barCode === codigo
  ))?.[1];
}

test('nao cria categoria nem subcategoria', async () => {
  const firestore = banco();
  await caso(firestore).execute({ establishmentId: 'loja-a', actorEstablishmentId: 'loja-a', csvText: CSV });
  const criadas = firestore.escritas.filter((escrita) => /\/(ProductCategories|ProductSubcategories)\//.test(escrita.caminho));
  assert.equal(criadas.length, 0);
});

test('par ativo existente vira a prateleira; o resto vai para todos_todos', async () => {
  const firestore = banco();
  await caso(firestore).execute({ establishmentId: 'loja-a', actorEstablishmentId: 'loja-a', csvText: CSV });
  assert.deepEqual(produtoPeloCodigo(firestore, '789001').shelvesIds, ['bebidas_refri']);
  // Categoria que nao existe, categoria desligada e categoria travada: Todos.
  assert.deepEqual(produtoPeloCodigo(firestore, '789002').shelvesIds, ['todos_todos']);
  assert.deepEqual(produtoPeloCodigo(firestore, '789004').shelvesIds, ['todos_todos']);
  assert.deepEqual(produtoPeloCodigo(firestore, '789003').shelvesIds, ['todos_todos']);
  assert.deepEqual(produtoPeloCodigo(firestore, '789003').categoriesIds, ['todos']);
});

test('produto que ja existe mantem as prateleiras', async () => {
  const firestore = banco();
  await caso(firestore).execute({ establishmentId: 'loja-a', actorEstablishmentId: 'loja-a', csvText: CSV });
  assert.deepEqual(firestore.dados('estabelecimentos/loja-a/Products/existente').shelvesIds, ['mercearia_agua']);
});

test('recusa importar em loja que nao e a de quem chama', async () => {
  const firestore = banco();
  await assert.rejects(
    caso(firestore).execute({ establishmentId: 'loja-a', actorEstablishmentId: 'loja-b', csvText: CSV }),
    (error) => error.statusCode === 403 && error.code === 'implantacao_loja_de_outro',
  );
  assert.equal(firestore.escritas.length, 0);
});
