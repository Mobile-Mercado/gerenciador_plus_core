import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Cola do Thay B57-02 (18/11), item A8: o App Gerenciador grava o registro das acoes direto em
// estabelecimentos/{loja}/AcoesEquipe. Antes, nenhuma regra cobria a colecao (o web grava pelo
// servidor) e a gravacao do app era recusada. A regra sobe so com ok do Thay, junto da publicacao.
test('B57-02 item A8: o admin da loja so cria em AcoesEquipe, com origem app e a hora do servidor', () => {
  const regras = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const inicio = regras.indexOf('match /AcoesEquipe/{acaoId}');
  assert.ok(inicio > 0, 'falta a regra de AcoesEquipe');
  const bloco = regras.slice(inicio, regras.indexOf('allow update, delete: if false;', inicio) + 40);
  assert.match(bloco, /allow create: if isAdminOf\(estabId\)/);
  assert.match(bloco, /request\.resource\.data\.origem == 'app'/);
  assert.match(bloco, /request\.resource\.data\.em == request\.time/);
  for (const campo of ['em', 'quem', 'tela', 'acao', 'alvo', 'antes', 'depois', 'origem', 'versaoDoApp', 'aparelho']) {
    assert.ok(bloco.includes(`'${campo}'`), campo);
  }
  assert.match(bloco, /allow update, delete: if false;/);
  // A regra fica dentro da loja (estabelecimentos/{estabId}), antes da base publica.
  assert.ok(inicio < regras.indexOf('match /produtos/{productId}'));
});
