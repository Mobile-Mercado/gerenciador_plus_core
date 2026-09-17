import assert from 'node:assert/strict';
import test from 'node:test';
import { productSearchKeys, searchKeysForName } from '../src/application/implantacao/catalogSearchIndex.js';

test('chaves do nome saem em maiúsculas, sem acento, com prefixos a partir de 4 letras', () => {
  assert.deepEqual(searchKeysForName('Café Torrado'), ['CAFE', 'TORR', 'TORRA', 'TORRAD', 'TORRADO']);
});

test('palavra curta só entra quando tem dígito', () => {
  assert.deepEqual(searchKeysForName('Coca 2l de 350ml'), ['COCA', '2L', '350M', '350ML']);
});

test('código de barras vem primeiro nas chaves do produto', () => {
  assert.deepEqual(productSearchKeys({ name: 'Leite', barCode: '7891000100103' }), ['7891000100103', 'LEIT', 'LEITE']);
});

test('código de barras vazio não vira chave', () => {
  assert.deepEqual(productSearchKeys({ name: 'Pão Francês', barCode: '' }), ['PAO', 'FRAN', 'FRANC', 'FRANCE', 'FRANCES']);
});

test('nome vazio gera lista vazia', () => {
  assert.deepEqual(productSearchKeys({ name: '' }), []);
  assert.deepEqual(productSearchKeys({}), []);
});

test('barra, vírgula, ponto e hífen separam palavras, e o apóstrofo some', () => {
  assert.deepEqual(searchKeysForName('Ruffles C/cebola'), ['RUFF', 'RUFFL', 'RUFFLE', 'RUFFLES', 'CEBO', 'CEBOL', 'CEBOLA']);
  assert.deepEqual(searchKeysForName('Pimenta-do-reino N.8'), ['PIME', 'PIMEN', 'PIMENT', 'PIMENTA', 'REIN', 'REINO', '8']);
  assert.deepEqual(searchKeysForName("Hellmann's bacon,"), ['HELL', 'HELLM', 'HELLMA', 'HELLMAN', 'HELLMANN', 'HELLMANNS', 'BACO', 'BACON']);
});
