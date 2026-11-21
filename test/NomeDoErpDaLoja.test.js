import assert from 'node:assert/strict';
import test from 'node:test';
import { chaveDoErp, nomeDoErp, nomeDoErpDaLoja } from '../src/application/produtos/nomeDoErp.js';
import { HistoricoDoProduto } from '../src/application/produtos/HistoricoDoProduto.js';
import { ProdutosForaDoApp } from '../src/application/produtos/ProdutosForaDoApp.js';
import { FirestoreHistoricoDoProdutoRepository } from '../src/infra/firebase/FirestoreHistoricoDoProdutoRepository.js';
import { FirestoreProdutosForaDoAppRepository } from '../src/infra/firebase/FirestoreProdutosForaDoAppRepository.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Cola 71, item 3: o Core manda o nome do ERP da loja (nomeDoErp) na rota do historico (5.4) e no
// resumo do painel 5.1, para o motivo fora_do_erp ("fora do Linear"). Regra da nuvem do Log do ERP
// (log-do-erp.ts): integradorConfigs.erpKey ou erpKey da loja; sem ela, IntegrationStatus/current.erpKey;
// so linear_v1 vira "Linear". Falha com o codigo de antes (nomeDoErp nao existia). Dados de exemplo.

const LOJA = 'loja-1';
const ator = { establishmentId: LOJA, hasEstablishment: true };

test('Cola 71, item 3: regra do nome do ERP igual a da nuvem do Log do ERP', () => {
  assert.equal(nomeDoErpDaLoja({ integradorConfigs: { erpKey: 'linear_v1' } }, null), 'Linear');
  assert.equal(nomeDoErpDaLoja({ erpKey: ' linear_v1 ' }, null), 'Linear');
  // A chave do painel vence a do sinal de vida, mesmo desconhecida.
  assert.equal(chaveDoErp({ integradorConfigs: { erpKey: 'outro_v2' } }, { erpKey: 'linear_v1' }), 'outro_v2');
  assert.equal(nomeDoErpDaLoja({ integradorConfigs: { erpKey: 'outro_v2' } }, { erpKey: 'linear_v1' }), null);
  assert.equal(nomeDoErpDaLoja({ integradorConfigs: { erpKey: 'linear_v1' } }, { erpKey: 'outro_v2' }), 'Linear');
  // integradorConfigs.erpKey vence erpKey.
  assert.equal(chaveDoErp({ integradorConfigs: { erpKey: 'a' }, erpKey: 'b' }, null), 'a');
  // Sem chave na loja: a do sinal de vida.
  assert.equal(nomeDoErpDaLoja({ integradorConfigs: { erpKey: '  ' } }, { erpKey: 'linear_v1' }), 'Linear');
  assert.equal(nomeDoErpDaLoja(null, { erpKey: 'linear_v1' }), 'Linear');
  // Sem chave conhecida: null.
  assert.equal(nomeDoErpDaLoja(null, null), null);
  assert.equal(nomeDoErpDaLoja({}, {}), null);
  assert.equal(nomeDoErp('Linear'), null);
  assert.equal(nomeDoErp('LINEAR_V1'), null);
  assert.equal(nomeDoErp(123), null);
});

function banco({ loja = {}, status = null } = {}) {
  return new FirestoreEmMemoria(Object.fromEntries([
    [`estabelecimentos/${LOJA}`, { name: 'Loja 1', ...loja }],
    ...(status ? [[`estabelecimentos/${LOJA}/IntegrationStatus/current`, status]] : []),
    [`estabelecimentos/${LOJA}/AcoesEquipe/l1`, {
      em: new Date(Date.UTC(2026, 10, 20, 12)), quem: 'Linear', tela: 'integrador', acao: 'produto.editar', origem: 'integrador',
      alvo: { tipo: 'produto', id: 'p1', rotulo: 'Batata' }, antes: { isActive: true }, depois: { isActive: false, offReasons: ['fora_do_erp'] },
    }],
  ]));
}

const historico = (b) => new HistoricoDoProduto({ repositorio: new FirestoreHistoricoDoProdutoRepository({ firestore: b }) });
const painel = (b) => new ProdutosForaDoApp({ repositorio: new FirestoreProdutosForaDoAppRepository({ firestore: b }), agora: () => Date.parse('2026-11-20T15:00:00Z') });

test('Cola 71, item 3: historico e resumo do 5.1 mandam o nome do ERP da loja', async () => {
  const casos = [
    [{ loja: { integradorConfigs: { erpKey: 'linear_v1' } } }, 'Linear'],
    [{ loja: { erpKey: 'linear_v1' } }, 'Linear'],
    [{ status: { erpKey: 'linear_v1', lastSeenAt: new Date('2026-11-20T14:59:00Z') } }, 'Linear'],
    [{ loja: { integradorConfigs: { erpKey: 'outro_v2' } }, status: { erpKey: 'linear_v1' } }, null],
    [{}, null],
  ];
  for (const [dados, esperado] of casos) {
    const b = banco(dados);
    const h = await historico(b).listar({ ator, produtoId: 'p1' });
    assert.equal(h.nomeDoErp, esperado, JSON.stringify(dados));
    const r = await painel(b).resumo({ ator });
    assert.equal(r.nomeDoErp, esperado, JSON.stringify(dados));
  }
});

test('Cola 71, item 3: so o nome sai; a chave e a configuracao da loja nao', async () => {
  const b = banco({ loja: { integradorConfigs: { erpKey: 'linear_v1', segredo: 'SEGREDO-X' }, erpKey: 'linear_v1' } });
  const corpo = JSON.stringify([await historico(b).listar({ ator, produtoId: 'p1' }), await painel(b).resumo({ ator })]);
  assert.ok(!corpo.includes('linear_v1'));
  assert.ok(!corpo.includes('SEGREDO-X'));
  assert.ok(!corpo.includes('integradorConfigs'));
});

test('Cola 71, item 3: leitura da configuracao que falha deixa nomeDoErp null sem derrubar a rota', async () => {
  const b = banco({ loja: { erpKey: 'linear_v1' } });
  const repoH = new FirestoreHistoricoDoProdutoRepository({ firestore: b });
  repoH.configuracaoDoErp = async () => { throw new Error('falhou'); };
  const h = await new HistoricoDoProduto({ repositorio: repoH }).listar({ ator, produtoId: 'p1' });
  assert.equal(h.nomeDoErp, null);
  assert.equal(h.linhas.length, 1);
  const repoP = new FirestoreProdutosForaDoAppRepository({ firestore: b });
  repoP.configuracaoDoErp = async () => { throw new Error('falhou'); };
  const r = await new ProdutosForaDoApp({ repositorio: repoP, agora: () => Date.parse('2026-11-20T15:00:00Z') }).resumo({ ator });
  assert.equal(r.nomeDoErp, null);
});
