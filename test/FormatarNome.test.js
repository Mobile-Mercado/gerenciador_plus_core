import assert from 'node:assert/strict';
import test from 'node:test';
import { chaveDoNome, formatarNome } from '../src/domain/catalogo/formatarNome.js';

test('tira espacos nas pontas e espacos duplos', () => {
  assert.equal(formatarNome('   leite    em   po  '), 'Leite em Po');
});

test('abre P/, C/ e S/', () => {
  assert.equal(formatarNome('P/ CAFE DA MANHA'), 'Para Cafe da Manha');
  assert.equal(formatarNome('biscoito c/ recheio'), 'Biscoito com Recheio');
  assert.equal(formatarNome('cerveja s/ alcool'), 'Cerveja sem Alcool');
});

test('siglas da lista em maiusculas', () => {
  assert.equal(formatarNome('flv organicos'), 'FLV Organicos');
  assert.equal(formatarNome('refrigerante pet'), 'Refrigerante PET');
});

test('conectivos em minusculo, menos na primeira palavra', () => {
  assert.equal(formatarNome('CIGARRO E FUMO'), 'Cigarro e Fumo');
  assert.equal(formatarNome('DE MAO EM MAO'), 'De Mao em Mao');
});

test('unidade em minusculo', () => {
  assert.equal(formatarNome('agua 500 ML'), 'Agua 500 ml');
  assert.equal(formatarNome('refri 2L'), 'Refri 2l');
  assert.equal(formatarNome('ovos UN'), 'Ovos un');
});

test('primeira letra maiuscula e o resto minusculo, com acento', () => {
  assert.equal(formatarNome('ÁGUA MINERAL'), 'Água Mineral');
  assert.equal(formatarNome('açúcar'), 'Açúcar');
});

test('palavra nova depois de barra e hifen', () => {
  assert.equal(formatarNome('achocolatados/pó'), 'Achocolatados/Pó');
  assert.equal(formatarNome('pre-pronto'), 'Pre-Pronto');
});

test('nao poe acento', () => {
  assert.equal(formatarNome('cafe'), 'Cafe');
});

test('Mercearia e Todos ficam como vieram', () => {
  assert.equal(formatarNome('MERCEARIA'), 'MERCEARIA');
  assert.equal(formatarNome(' todos '), 'todos');
});

test('nome vazio vira vazio', () => {
  assert.equal(formatarNome('   '), '');
  assert.equal(formatarNome(null), '');
});

test('chave do nome ignora acento, caixa e espacos', () => {
  assert.equal(chaveDoNome(' Água  Mineral '), chaveDoNome('agua mineral'));
});
