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

test('nao existe excluir na lista padrao', () => {
  const catalogo = new ManageCatalogoPadrao({ firestore: banco() });
  const metodos = Object.getOwnPropertyNames(ManageCatalogoPadrao.prototype);
  assert.equal(metodos.some((nome) => /excluir|apagar|remover|delete/i.test(nome)), false);
  assert.equal(typeof catalogo.mudarEstado, 'function');
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
