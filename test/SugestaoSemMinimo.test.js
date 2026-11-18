import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Cola do Thay B57-01c (18/11), item 1: a sugestao do app do cliente nao tem minimo de caracteres;
// o maximo de 500 fica. A regra sobe so com ok do Thay, junto da publicacao.
test('B57-01c item 1: a regra de Suggestions nao tem minimo de caracteres e mantem o maximo de 500', () => {
  const regras = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const inicio = regras.indexOf('match /Suggestions/{suggestionId}');
  const bloco = regras.slice(inicio, regras.indexOf('allow read, update, delete', inicio));
  assert.ok(inicio > 0);
  assert.ok(bloco.includes('request.resource.data.text is string'));
  assert.ok(bloco.includes('request.resource.data.text.size() <= 500'));
  assert.equal(/text\.size\(\) >=/.test(bloco), false);
});
