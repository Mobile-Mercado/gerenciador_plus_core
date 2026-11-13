import assert from 'node:assert/strict';
import test from 'node:test';
import { escolherArquivosPadrao, montarListaPadrao, objetoNoStorage } from '../scripts/montarConjuntoPadrao.mjs';

// Cola B56-17, 2.2: colecao "Padrao" com os SVG de hoje da lista padrao (categoriasProdutos).
const url = (bucket, caminho) => `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(caminho)}?alt=media&token=segredo`;

test('padrao: bucket e caminho do endereco, sem token; sem endereco ou endereco de fora, fora da lista', () => {
  assert.deepEqual(objetoNoStorage(url('b', 'categoriasProdutos/bebidas.svg'), 'x'), { bucket: 'b', caminho: 'categoriasProdutos/bebidas.svg' });
  assert.deepEqual(objetoNoStorage('gs://b/categoriasProdutos/a.svg', 'x'), { bucket: 'b', caminho: 'categoriasProdutos/a.svg' });
  assert.equal(objetoNoStorage('', 'x'), null);
  assert.equal(objetoNoStorage('https://outro.site/a.svg', 'x'), null);
  const { itens, semIcone } = montarListaPadrao([
    { id: 'bebidas', nome: 'Bebidas', icon: url('b', 'categoriasProdutos/bebidas.svg') },
    { id: 'acougue', nome: 'Açougue', icon: url('b', 'categoriasProdutos/acougue.svg') },
    { id: 'vazia', nome: 'Vazia', icon: '' },
  ], 'x');
  assert.deepEqual(itens.map((item) => item.categoriaId), ['acougue', 'bebidas']);
  assert.deepEqual(semIcone.map((item) => item.categoriaId), ['vazia']);
  assert.equal(JSON.stringify(itens).includes('segredo'), false, 'nenhum token');
});

test('padrao: arquivo que nao existe (o todos.svg) fica fora, sem icone; fora do tamanho vai para foraDaRegra; tipo fora para tudo', async () => {
  const { itens } = montarListaPadrao([
    { id: 'bebidas', nome: 'Bebidas', icon: url('b', 'categoriasProdutos/bebidas.svg') },
    { id: 'todos', nome: 'TODOS', icon: url('b', 'categoriasProdutos/todos.svg') },
    { id: 'grande', nome: 'Grande', icon: url('b', 'categoriasProdutos/grande.svg') },
    { id: 'foto', nome: 'Foto', icon: url('b', 'categoriasProdutos/foto.jpg') },
  ], 'x');
  const arquivos = { 'categoriasProdutos/bebidas.svg': Buffer.from('<svg/>'), 'categoriasProdutos/grande.svg': Buffer.alloc(30000), 'categoriasProdutos/foto.jpg': Buffer.from('jpg') };
  const conferir = async (conteudo) => { if (conteudo.length > 20480) throw new Error('acima de 20 KB'); };
  const { escolhidos, semArquivo, foraDaRegra, problemas } = await escolherArquivosPadrao(itens, async (item) => arquivos[item.caminho] || null, conferir);
  assert.deepEqual(escolhidos.map((item) => [item.categoriaId, item.tipoArquivo]), [['bebidas', 'image/svg+xml']]);
  assert.deepEqual(semArquivo.map((item) => item.categoriaId), ['todos']);
  assert.deepEqual(foraDaRegra.map((item) => [item.categoriaId, item.motivo, item.bytes]), [['grande', 'acima de 20 KB', 30000]]);
  assert.deepEqual(problemas, ['foto: tipo .jpg fora de SVG, PNG ou WEBP']);
});
