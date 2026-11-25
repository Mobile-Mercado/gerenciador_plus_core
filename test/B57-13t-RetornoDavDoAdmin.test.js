import assert from 'node:assert/strict';
import test from 'node:test';
import { ehAcaoDoAdmin } from '../src/domain/logs/acaoDoAdmin.js';

// Cola do Thay B57-13t, item 35: as acoes do Admin no Retorno DAV ("Reenviar ao Linear" e "Ja lancado
// no Linear") sao gravadas pelo proprio Core com origem 'admin' e sem autor, fora do registro do Admin
// na loja; apareciam para a loja. Agora somem; as da loja (origem 'manual') continuam.
const linha = (origem) => ({ quem: 'pessoa@loja.test', tela: 'logs', acao: 'reenviar_ao_linear', alvo: { tipo: 'pedido', id: 'v1' }, origem });

test('B57-13t item 35: a acao do Admin no Retorno DAV some para a loja; a da loja aparece', () => {
  assert.equal(ehAcaoDoAdmin(linha('admin'), { caminho: 'estabelecimentos/loja-1/AcoesEquipe/r1', caminhosDoAdmin: new Set(), contas: new Set() }), true);
  assert.equal(ehAcaoDoAdmin(linha('manual'), { caminho: 'estabelecimentos/loja-1/AcoesEquipe/r2', caminhosDoAdmin: new Set(), contas: new Set() }), false);
});
