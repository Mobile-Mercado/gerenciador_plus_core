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

// Cola 65, item 3.5: a importacao do CSV pelo Core grava cada produto criado ou alterado no Log das
// acoes da equipe (estabelecimentos/{loja}/AcoesEquipe), com origem 'implantacao' e quem importou.
// Falha com o codigo de antes: a importacao nao gravava em AcoesEquipe.
test('3.5: importacao registra no Log o produto criado e so os campos que mudaram no que ja existe', async () => {
  const firestore = banco();
  firestore.docs.set('estabelecimentos/loja-a/Products/existente', {
    ...firestore.dados('estabelecimentos/loja-a/Products/existente'),
    name: 'Agua 500ml', description: '', currentPrice: 1.5, agranelValue: 1.5, hasBarCode: true,
  });
  firestore.docs.set('estabelecimentos/loja-a/Products/igual', {
    barCode: '789006', name: 'Sal 1kg', description: '', currentPrice: 3, agranelValue: 3, hasBarCode: true,
  });
  await caso(firestore).execute({
    establishmentId: 'loja-a',
    actorEstablishmentId: 'loja-a',
    csvText: `${CSV}\nSal 1kg;3,00;789006;;`,
    metadata: { firebaseUid: 'uid-dono', firebaseEmail: 'dono@loja.com' },
  });
  const linhas = [...firestore.docs.entries()]
    .filter(([caminho]) => caminho.startsWith('estabelecimentos/loja-a/AcoesEquipe/'))
    .map(([, dados]) => dados);
  const criadas = linhas.filter((linha) => linha.acao === 'produto.criar');
  assert.equal(criadas.length, 4);
  criadas.forEach((linha) => {
    assert.equal(linha.origem, 'implantacao');
    assert.equal(linha.tela, 'implantacao');
    assert.equal(linha.quem, 'dono@loja.com');
    assert.equal(linha.alvo.tipo, 'produto');
    assert.ok(linha.em instanceof Date);
  });
  assert.deepEqual(criadas.map((linha) => linha.depois.name).sort(), ['Arroz 5kg', 'Cigarro X', 'Coca 2L', 'Suco Uva']);
  const editadas = linhas.filter((linha) => linha.acao === 'produto.editar');
  // O produto igual ao CSV nao ganha linha; o existente ganha so preco.
  assert.equal(editadas.length, 1);
  assert.deepEqual(editadas[0].alvo, { tipo: 'produto', id: 'existente', rotulo: 'Agua 500ml' });
  assert.deepEqual(editadas[0].antes, { currentPrice: 1.5, agranelValue: 1.5 });
  assert.deepEqual(editadas[0].depois, { currentPrice: 2, agranelValue: 2 });
});

test('3.5: sem e-mail, quem e o uid de quem importou', async () => {
  const firestore = banco();
  await caso(firestore).execute({
    establishmentId: 'loja-a', actorEstablishmentId: 'loja-a', csvText: CSV, metadata: { firebaseUid: 'uid-dono' },
  });
  const linha = [...firestore.docs.entries()].find(([caminho]) => caminho.startsWith('estabelecimentos/loja-a/AcoesEquipe/'))[1];
  assert.equal(linha.quem, 'uid-dono');
});
