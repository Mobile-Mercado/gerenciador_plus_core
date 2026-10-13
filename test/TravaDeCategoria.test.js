import assert from 'node:assert/strict';
import test from 'node:test';
import { TravasDeCategoria } from '../src/application/catalogo/TravasDeCategoria.js';
import { travadaNaLoja, travadasNaLoja } from '../src/domain/catalogo/regraDaTrava.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

test('travada no padrao e sem liberacao: travada na loja', () => {
  assert.equal(travadaNaLoja('tabacaria', { travadas: ['tabacaria'], liberadas: [] }), true);
});

test('travada no padrao com liberacao para a loja: livre na loja', () => {
  assert.equal(travadaNaLoja('tabacaria', { travadas: ['tabacaria'], liberadas: ['tabacaria'] }), false);
});

test('sem trava no padrao: livre, com ou sem liberacao', () => {
  assert.equal(travadaNaLoja('bebidas', { travadas: ['tabacaria'], liberadas: [] }), false);
  assert.equal(travadasNaLoja({ travadas: ['tabacaria', 'remedios'], liberadas: ['remedios'] }).join(), 'tabacaria');
});

function bancoComTrava() {
  return new FirestoreEmMemoria({
    'categoriasProdutos/tabacaria': { nome: 'Tabacaria', travada: true },
    'categoriasProdutos/remedios': { nome: 'Remédios', travada: true },
    'categoriasProdutos/bebidas': { nome: 'Bebidas', travada: false },
    'liberacoesCategorias/loja-b': { liberadas: { tabacaria: { por: 'thay' } } },
  });
}

test('le a chave travada do padrao e a liberacao da loja', async () => {
  const travas = new TravasDeCategoria({ firestore: bancoComTrava() });
  assert.deepEqual([...await travas.travadasNaLoja('loja-a')].sort(), ['remedios', 'tabacaria']);
  assert.deepEqual([...await travas.travadasNaLoja('loja-b')], ['remedios']);
  assert.equal(await travas.estaTravada('loja-b', 'tabacaria'), false);
  assert.equal(await travas.estaTravada('loja-a', 'tabacaria'), true);
});

test('cache de cinco minutos: a segunda chamada nao le o banco de novo', async () => {
  let agora = 0;
  const banco = bancoComTrava();
  const travas = new TravasDeCategoria({ firestore: banco, clock: () => agora });
  await travas.travadasNaLoja('loja-a');
  const leituras = banco.leituras;
  await travas.travadasNaLoja('loja-a');
  assert.equal(banco.leituras, leituras);
  agora = 5 * 60 * 1000 + 1;
  await travas.travadasNaLoja('loja-a');
  assert.equal(banco.leituras, leituras + 2);
});

test('esquecerLoja faz a liberacao nova valer na hora', async () => {
  const banco = bancoComTrava();
  const travas = new TravasDeCategoria({ firestore: banco });
  assert.equal(await travas.estaTravada('loja-a', 'tabacaria'), true);
  await banco.doc('liberacoesCategorias/loja-a').set({ liberadas: { tabacaria: { por: 'thay' } } });
  travas.esquecerLoja('loja-a');
  assert.equal(await travas.estaTravada('loja-a', 'tabacaria'), false);
});
