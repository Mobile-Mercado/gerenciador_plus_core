import assert from 'node:assert/strict';
import test from 'node:test';
import { ManageCatalogoPadrao } from '../src/application/catalogo/ManageCatalogoPadrao.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

const THAY = { uid: 'uid-thay', email: 'thay@teste' };

function banco(extra = {}) {
  return new FirestoreEmMemoria({
    'estabelecimentos/loja-a': { name: 'Loja A' },
    'estabelecimentos/loja-b': { name: 'Loja B' },
    'estabelecimentos/loja-c': { name: 'Loja C' },
    'categoriasProdutos/bebidas': { id: 'bebidas', nome: 'Bebidas', name: 'Bebidas', order: 1, isActive: true },
    'categoriasProdutos/tabacaria': { id: 'tabacaria', nome: 'Tabacaria', name: 'Tabacaria', order: 2, isActive: true },
    'subcategoriasProdutos/refri': { nome: 'Refrigerantes', categoriaProdutoId: 'bebidas', categoriaProdutoNome: 'Bebidas' },
    // Loja A ainda com o nome padrao; loja B mudou o nome; loja C nao tem a categoria.
    'estabelecimentos/loja-a/ProductCategories/bebidas': { id: 'bebidas', name: 'Bebidas', isActive: true },
    'estabelecimentos/loja-b/ProductCategories/bebidas': { name: 'Bebidas da Casa', isActive: true },
    'estabelecimentos/loja-a/Products/p1': { categoriesIds: ['bebidas'] },
    'estabelecimentos/loja-a/Products/p2': { categoriesIds: ['bebidas', 'mercearia'] },
    'estabelecimentos/loja-b/Products/p3': { categoriesIds: ['bebidas'] },
    'estabelecimentos/loja-b/Products/p4': { categoriesIds: ['mercearia'] },
    ...extra,
  });
}

test('criar formata o nome e recusa nome repetido', async () => {
  const firestore = banco();
  const catalogo = new ManageCatalogoPadrao({ firestore });
  const criada = await catalogo.criar('categoria', { nome: '  PET SHOP  c/ racao ' }, THAY);
  assert.equal(criada.nome, 'PET Shop com Racao');
  assert.equal(criada.estado, 'ligada');
  assert.equal(firestore.dados(`categoriasProdutos/${criada.id}`).order, 3);
  await assert.rejects(catalogo.criar('categoria', { nome: 'bebidas' }, THAY), (error) => error.code === 'catalogo_nome_repetido');
});

test('editar o nome guarda o nome anterior e atualiza as subcategorias da lista padrao', async () => {
  const firestore = banco();
  const catalogo = new ManageCatalogoPadrao({ firestore });
  const editada = await catalogo.editar('categoria', 'bebidas', { nome: 'BEBIDAS E SUCOS' }, THAY);
  assert.equal(editada.nome, 'Bebidas e Sucos');
  assert.equal(firestore.dados('categoriasProdutos/bebidas').nomeAnterior, 'Bebidas');
  assert.equal(firestore.dados('categoriasProdutos/bebidas').updatedBy, 'uid-thay');
  assert.equal(firestore.dados('subcategoriasProdutos/refri').categoriaProdutoNome, 'Bebidas e Sucos');
});

test('levar o nome muda so as lojas que ainda tem o nome padrao antigo', async () => {
  const firestore = banco();
  const catalogo = new ManageCatalogoPadrao({ firestore });
  await catalogo.editar('categoria', 'bebidas', { nome: 'Bebidas e Sucos' }, THAY);
  const resultado = await catalogo.levarNome('categoria', 'bebidas');
  assert.deepEqual(resultado.atualizadas, ['loja-a']);
  assert.equal(resultado.lojasComItem, 2);
  assert.equal(resultado.mantidas, 1);
  assert.equal(firestore.dados('estabelecimentos/loja-a/ProductCategories/bebidas').name, 'Bebidas e Sucos');
  assert.equal(firestore.dados('estabelecimentos/loja-b/ProductCategories/bebidas').name, 'Bebidas da Casa');
  assert.equal(firestore.dados('estabelecimentos/loja-c/ProductCategories/bebidas'), undefined);
});

test('loja sem o campo id conta pelo caminho do documento', async () => {
  const catalogo = new ManageCatalogoPadrao({ firestore: banco() });
  // loja-b nao tem o campo id na categoria, e mesmo assim entra.
  const impacto = await catalogo.impacto('categoria', 'bebidas');
  assert.equal(impacto.lojas, 2);
  assert.equal(impacto.produtos, 3);
});

test('arquivar grava arquivada, por e em; restaurar desfaz', async () => {
  const firestore = banco();
  const catalogo = new ManageCatalogoPadrao({ firestore });
  const arquivada = await catalogo.mudarEstado('categoria', 'tabacaria', 'arquivada', THAY);
  assert.equal(arquivada.estado, 'arquivada');
  const dados = firestore.dados('categoriasProdutos/tabacaria');
  assert.equal(dados.arquivada, true);
  assert.equal(dados.arquivadaPor, 'uid-thay');
  assert.ok(dados.arquivadaEm instanceof Date);
  assert.equal((await catalogo.listar('categoria')).some((item) => item.id === 'tabacaria'), false);
  assert.equal((await catalogo.listar('categoria', { arquivadas: true }))[0].id, 'tabacaria');

  const restaurada = await catalogo.mudarEstado('categoria', 'tabacaria', 'restaurada', THAY);
  assert.equal(restaurada.estado, 'ligada');
  assert.equal(firestore.dados('categoriasProdutos/tabacaria').arquivadaPor, undefined);
});

test('item arquivado nao liga nem desliga antes de restaurar', async () => {
  const catalogo = new ManageCatalogoPadrao({ firestore: banco() });
  await catalogo.mudarEstado('categoria', 'tabacaria', 'arquivada', THAY);
  await assert.rejects(catalogo.mudarEstado('categoria', 'tabacaria', 'ligada', THAY), (error) => error.code === 'catalogo_item_arquivado');
});

test('desligar deixa o item na lista do Admin', async () => {
  const catalogo = new ManageCatalogoPadrao({ firestore: banco() });
  await catalogo.mudarEstado('categoria', 'bebidas', 'desligada', THAY);
  const lista = await catalogo.listar('categoria');
  assert.equal(lista.find((item) => item.id === 'bebidas').estado, 'desligada');
});

test('excluir so com 0 lojas e 0 produtos, e registra o documento como estava', async () => {
  const firestore = banco({ 'categoriasProdutos/vinhos': { nome: 'Vinhos', name: 'Vinhos', isActive: true } });
  const catalogo = new ManageCatalogoPadrao({ firestore });
  const resultado = await catalogo.excluir('categoria', 'vinhos', THAY);
  assert.equal(resultado.excluido, true);
  assert.equal(firestore.dados('categoriasProdutos/vinhos'), undefined);
  const registro = firestore.escritas.find((escrita) => escrita.caminho.startsWith('adminAuditLogs/'));
  assert.equal(registro.dados.acao, 'excluir');
  assert.equal(registro.dados.uid, 'uid-thay');
  assert.equal(registro.dados.documento.nome, 'Vinhos');
});

test('excluir recusa item que alguma loja tem ou com produto, e categoria com subcategoria', async () => {
  const firestore = banco({ 'categoriasProdutos/sem_loja': { nome: 'Sem Loja', name: 'Sem Loja' } });
  const catalogo = new ManageCatalogoPadrao({ firestore });
  await assert.rejects(catalogo.excluir('categoria', 'bebidas', THAY), (error) => error.code === 'catalogo_exclusao_recusada' && error.details.lojas === 2);
  firestore.docs.set('subcategoriasProdutos/filha', { nome: 'Filha', categoriaProdutoId: 'sem_loja' });
  await assert.rejects(catalogo.excluir('categoria', 'sem_loja', THAY), (error) => error.code === 'catalogo_exclusao_com_subcategorias');
  assert.ok(firestore.dados('categoriasProdutos/sem_loja'));
  assert.ok(firestore.dados('categoriasProdutos/bebidas'));
});

test('trava: a chave vale para a lista padrao e limpa o cache das travas', async () => {
  const firestore = banco();
  let limpou = false;
  const catalogo = new ManageCatalogoPadrao({ firestore, travas: { esquecerPadrao: () => { limpou = true; } } });
  await catalogo.editar('categoria', 'tabacaria', { travada: true }, THAY);
  assert.equal(firestore.dados('categoriasProdutos/tabacaria').travada, true);
  assert.equal(limpou, true);
});

test('liberacao por loja fica em liberacoesCategorias/{loja} e pode ser revogada', async () => {
  const firestore = banco();
  const esquecidas = [];
  const catalogo = new ManageCatalogoPadrao({ firestore, travas: { esquecerLoja: (loja) => esquecidas.push(loja) } });
  await catalogo.liberar({ lojaId: 'loja-a', categoriaId: 'tabacaria' }, THAY);
  assert.equal(firestore.dados('liberacoesCategorias/loja-a').liberadas.tabacaria.por, 'uid-thay');
  assert.deepEqual((await catalogo.liberacoes('tabacaria')).map((item) => item.lojaId), ['loja-a']);
  await catalogo.revogar({ lojaId: 'loja-a', categoriaId: 'tabacaria' });
  assert.equal(firestore.dados('liberacoesCategorias/loja-a').liberadas.tabacaria, undefined);
  assert.deepEqual(esquecidas, ['loja-a', 'loja-a']);
  await assert.rejects(catalogo.liberar({ lojaId: 'loja-x', categoriaId: 'tabacaria' }, THAY), (error) => error.statusCode === 404);
});

test('fila de sugestoes mostra os produtos e a decisao grava estado, por, em e motivo', async () => {
  const firestore = banco({
    'estabelecimentos/loja-a/SugestoesCategorias/s1': {
      nome: 'Pet', tipo: 'categoria', estado: 'pendente', em: new Date('2026-10-12T10:00:00Z'),
      produtos: [{ id: 'p1', nome: 'Racao' }],
    },
    'estabelecimentos/loja-b/SugestoesCategorias/s2': { nome: 'Velas', tipo: 'categoria', estado: 'recusada' },
  });
  const catalogo = new ManageCatalogoPadrao({ firestore });
  const pendentes = await catalogo.sugestoes();
  assert.equal(pendentes.length, 1);
  assert.equal(pendentes[0].lojaId, 'loja-a');
  assert.equal(pendentes[0].nomeLoja, 'Loja A');
  assert.deepEqual(pendentes[0].produtos, [{ id: 'p1', nome: 'Racao' }]);

  await catalogo.decidirSugestao('loja-a', 's1', { decisao: 'recusada', motivo: 'Ja existe Pet Shop' }, THAY);
  const gravada = firestore.dados('estabelecimentos/loja-a/SugestoesCategorias/s1');
  assert.equal(gravada.estado, 'recusada');
  assert.equal(gravada.decisao.por, 'uid-thay');
  assert.equal(gravada.decisao.motivo, 'Ja existe Pet Shop');
  await assert.rejects(catalogo.decidirSugestao('loja-a', 's1', { decisao: 'aprovada' }, THAY), (error) => error.code === 'catalogo_sugestao_decidida');
});

// ===== Nome repetido, Mercearia e Todos, Estabelecimentos (12/10) =====

test('criar e editar recusam nome igual, inclusive de arquivado, e dizem qual ja existe', async () => {
  const firestore = banco({ 'categoriasProdutos/velha': { nome: 'Pet Shop', name: 'Pet Shop', arquivada: true } });
  const catalogo = new ManageCatalogoPadrao({ firestore });
  await assert.rejects(catalogo.criar('categoria', { nome: ' pét shop ' }, THAY), (error) => error.code === 'catalogo_nome_arquivado' && error.message.includes('Pet Shop'));
  await assert.rejects(catalogo.editar('categoria', 'tabacaria', { nome: 'BEBIDAS' }, THAY), (error) => error.code === 'catalogo_nome_repetido' && error.message.includes('Bebidas'));
  await assert.rejects(catalogo.criar('subcategoria', { nome: 'refrigerantes', categoriaId: 'bebidas' }, THAY), (error) => error.code === 'catalogo_nome_repetido');
});

test('Mercearia e Todos nao mudam de nome, nao desligam, nao arquivam e nao travam', async () => {
  const firestore = banco({
    'categoriasProdutos/mercearia': { nome: 'Mercearia', name: 'Mercearia', isActive: true },
    'categoriasProdutos/outro_id': { nome: 'Todos', name: 'Todos', isActive: true },
  });
  const catalogo = new ManageCatalogoPadrao({ firestore });
  const recusa = (error) => error.code === 'catalogo_categoria_protegida';
  await assert.rejects(catalogo.editar('categoria', 'mercearia', { nome: 'Mercado' }, THAY), recusa);
  await assert.rejects(catalogo.editar('categoria', 'mercearia', { travada: true }, THAY), recusa);
  await assert.rejects(catalogo.mudarEstado('categoria', 'mercearia', 'desligada', THAY), recusa);
  await assert.rejects(catalogo.mudarEstado('categoria', 'outro_id', 'arquivada', THAY), recusa);
  await catalogo.editar('categoria', 'mercearia', { order: 0 }, THAY);
  assert.equal((await catalogo.listar('categoria')).find((item) => item.id === 'mercearia').protegida, true);
});

test('estabelecimentos lista nome, cidade, ativa e produtos; a loja mostra as categorias com a trava', async () => {
  const firestore = banco({
    'estabelecimentos/loja-a': { name: 'Loja A', address: { city: 'Goiânia', uf: 'GO' }, isActive: true },
    'estabelecimentos/loja-c': { name: 'Loja C', isActive: false },
    'categoriasProdutos/tabacaria': { nome: 'Tabacaria', name: 'Tabacaria', travada: true },
    'estabelecimentos/loja-a/ProductCategories/tabacaria': { name: 'Tabacaria', isActive: false },
    'estabelecimentos/loja-a/ProductSubcategories/cigarro': { name: 'Cigarro', categoryId: 'tabacaria' },
  });
  const catalogo = new ManageCatalogoPadrao({ firestore });
  const lista = await catalogo.estabelecimentos();
  const a = lista.find((loja) => loja.id === 'loja-a');
  assert.equal(a.cidade, 'Goiânia');
  assert.equal(a.ativa, true);
  assert.equal(a.produtos, 2);
  assert.equal(lista.find((loja) => loja.id === 'loja-c').ativa, false);

  const detalhe = await catalogo.estabelecimento('loja-a');
  const tabacaria = detalhe.categorias.find((categoria) => categoria.id === 'tabacaria');
  assert.equal(tabacaria.travada, true);
  assert.equal(tabacaria.ligada, false);
  assert.equal(tabacaria.subcategorias, 1);
  await catalogo.liberar({ lojaId: 'loja-a', categoriaId: 'tabacaria' }, THAY);
  const liberada = (await catalogo.estabelecimento('loja-a')).categorias.find((categoria) => categoria.id === 'tabacaria');
  assert.equal(liberada.travada, false);
  assert.equal(liberada.liberada, true);
});
