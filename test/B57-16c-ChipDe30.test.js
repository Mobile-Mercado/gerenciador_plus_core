import assert from 'node:assert/strict';
import test from 'node:test';
import { MOTIVOS_PADRAO, TAMANHO_DO_CHIP, chipDoMotivo } from '../src/domain/loja/motivosDaSeparacao.js';

// Cola do Thay B57-16c, item 6 (item 3 da mensagem): o chip passa de 24 para 30 caracteres; com 30, os 8
// padroes aparecem inteiros.
test('B57-16c: chip de 30 caracteres, com os 8 padroes inteiros', () => {
  assert.equal(TAMANHO_DO_CHIP, 30);
  for (const padrao of MOTIVOS_PADRAO) assert.equal(chipDoMotivo(padrao.texto), padrao.texto, padrao.texto);
  assert.equal(chipDoMotivo('Separamos o mais parecido que temos na loja'), 'Separamos o mais parecido que …');
  assert.equal([...chipDoMotivo('Separamos o mais parecido que temos na loja').replace('…', '')].length, 30);
  assert.equal(chipDoMotivo('x'.repeat(30)), 'x'.repeat(30));
});
