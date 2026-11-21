import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import express from 'express';
import {
  FECHADO_DEPOIS_MS, ProdutosForaDoApp, faixaDoIntegrador, promocaoValendo,
} from '../src/application/produtos/ProdutosForaDoApp.js';
import { FirestoreProdutosForaDoAppRepository } from '../src/infra/firebase/FirestoreProdutosForaDoAppRepository.js';
import { HistoricoDoProduto } from '../src/application/produtos/HistoricoDoProduto.js';
import { FirestoreHistoricoDoProdutoRepository } from '../src/infra/firebase/FirestoreHistoricoDoProdutoRepository.js';
import { createProdutosRoutes } from '../src/http/routes/produtosRoutes.js';
import { errorHandler } from '../src/http/middlewares/errorHandler.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Cola 65, item 5.1: resumo do painel "Produtos fora do app" numa rota so do Core. Falham com o
// codigo de antes: o caso de uso, o repositorio e a rota nao existiam.

const LOJA = 'loja-1';
const OUTRA = 'loja-2';
const AGORA = Date.parse('2026-11-20T15:00:00Z');
const dia = (iso) => new Date(iso);
const produto = (id, dados, loja = LOJA) => [`estabelecimentos/${loja}/Products/${id}`, { isTrashed: false, ...dados }];

function banco(extra = []) {
  return new FirestoreEmMemoria(Object.fromEntries([
    [`estabelecimentos/${LOJA}`, { name: 'Loja 1' }],
    produto('ok1', { name: 'ARROZ', isActive: true, currentPrice: 10 }),
    produto('ok2', { name: 'FEIJAO', isActive: true, currentPrice: 8 }),
    produto('l1', {
      name: 'AMACIANTE YPE 2 LT', externalId: '000257', barCode: '7896098900697', isActive: false, currentPrice: 10.99,
      quantityInStock: 84, offReasons: ['inativo_na_web'], offReasonsSince: { inativo_na_web: dia('2026-11-05T12:00:00Z') },
      promotionalPrice: 10.25, promotionStartAt: dia('2026-11-17T03:00:00Z'), promotionEndAt: dia('2026-11-30T02:59:59Z'),
    }),
    produto('l2', { name: 'UVA PASSA', isActive: false, currentPrice: 6.25, quantityInStock: 22, offReasons: ['inativo_na_web'], offReasonsSince: { inativo_na_web: null } }),
    produto('l3', { name: 'NA LIXEIRA', isActive: false, isTrashed: true, offReasons: ['inativo_na_web', 'lixeira'] }),
    produto('p0', { name: 'CHICLE', isActive: false, currentPrice: 0, offReasons: ['sem_preco'], offReasonsSince: { sem_preco: dia('2026-11-11T12:00:00Z') } }),
    produto('z1', { name: 'SABAO', isActive: false, currentPrice: 8.49, quantityInStock: 0, offReasons: ['estoque_zerado'], promotionalPrice: 7.99, promotionEndAt: dia('2026-11-30T02:59:59Z') }),
    produto('n1', { name: 'NEGATIVO', isActive: false, quantityInStock: -2, offReasons: ['estoque_negativo'] }),
    produto('s1', { name: 'SEGURANCA', isActive: false, quantityInStock: 3, offReasons: ['abaixo_estoque_seguranca'] }),
    produto('m1', { name: 'AGUA SANITARIA', isActive: false, quantityInStock: 40, retiradoPelaEquipe: { tipo: 'ateRepor', quem: 'func@loja.com', em: dia('2026-11-15T12:00:00Z'), pedido: '#1' } }),
    produto('a1', { name: 'BISCOITO', isActive: true, currentPrice: 2.69, promotionalPrice: 3.18, promotionEndAt: dia('2026-11-30T02:59:59Z') }),
    produto('a2', { name: 'PROMO VENCIDA', isActive: true, currentPrice: 2, promotionalPrice: 3, promotionEndAt: dia('2026-11-10T02:59:59Z') }),
    produto('d0', { name: 'NESCAU', barCode: '7891000104101', isActive: true, currentPrice: 16.79 }),
    produto('d1', { name: 'NESCAU', barCode: '7891000347942', isActive: true, currentPrice: 16.89, duplicateOf: 'd0', duplicateMarkedAt: dia('2026-10-02T12:00:00Z') }),
    [`estabelecimentos/${LOJA}/ResumoDeProdutos/duplicados`, { quantidade: 1, atualizadoEm: dia('2026-11-19T12:00:00Z') }],
    [`estabelecimentos/${LOJA}/IntegrationStatus/current`, { version: '1.0.37', lastSeenAt: dia('2026-11-20T14:58:00Z'), readyFilesOnDisk: 0, quarantinedFiles: 1 }],
    [`estabelecimentos/${LOJA}/IntegrationLogs/r1`, { receivedAt: dia('2026-11-20T14:00:00Z') }],
    // Outra loja: nunca entra.
    produto('x1', { name: 'OUTRA', isActive: false, offReasons: ['inativo_na_web'] }, OUTRA),
    ...extra,
  ]));
}

const ator = { establishmentId: LOJA, hasEstablishment: true };
const casoDeUso = (b = banco()) => new ProdutosForaDoApp({ repositorio: new FirestoreProdutosForaDoAppRepository({ firestore: b }), agora: () => AGORA });

test('5.1: grupos lidos de offReasons e offReasonsSince, so da loja e fora da lixeira', async () => {
  const { grupos } = await casoDeUso().resumo({ ator });
  const g = Object.fromEntries(grupos.map((grupo) => [grupo.chave, grupo]));
  assert.equal(g.desligadosNoLinear.quantidade, 2);
  assert.deepEqual(g.desligadosNoLinear.produtos.map((p) => p.id).sort(), ['l1', 'l2']);
  const amaciante = g.desligadosNoLinear.produtos.find((p) => p.id === 'l1');
  assert.deepEqual(amaciante, {
    id: 'l1', nome: 'AMACIANTE YPE 2 LT', codigo: '000257', ean: '7896098900697', preco: 10.99, foto: null,
    motivo: { estoque: 84, desde: '2026-11-05T12:00:00.000Z' },
  });
  // Ja estava desligado antes do 1.0.35: "desde" em branco.
  assert.equal(g.desligadosNoLinear.produtos.find((p) => p.id === 'l2').motivo.desde, null);
  assert.equal(g.semPreco.quantidade, 1);
  assert.equal(g.semPreco.produtos[0].motivo.desde, '2026-11-11T12:00:00.000Z');
  assert.equal(g.estoqueZerado.quantidade, 1);
  assert.equal(g.estoqueNegativo.quantidade, 1);
  assert.equal(g.abaixoEstoqueSeguranca.quantidade, 1);
  assert.deepEqual(g.abaixoEstoqueSeguranca.produtos, []); // "Para acompanhar": so o numero no resumo
});

test('5.1: desligados a mao pela marca da equipe (4.4), com quem, quando e o estoque', async () => {
  const { grupos } = await casoDeUso().resumo({ ator });
  const mao = grupos.find((g) => g.chave === 'desligadosAMao');
  assert.equal(mao.quantidade, 1);
  assert.deepEqual(mao.produtos[0].motivo, { tipo: 'ateRepor', por: 'func@loja.com', em: '2026-11-15T12:00:00.000Z', estoque: 40 });
});

test('5.1: duplicados pela contagem guardada (3.1), com o produto que fica e o repetido; nada e apagado', async () => {
  const b = banco();
  const { grupos } = await casoDeUso(b).resumo({ ator });
  const dup = grupos.find((g) => g.chave === 'duplicados');
  assert.equal(dup.quantidade, 1);
  assert.deepEqual(dup.produtos.map((p) => [p.id, p.motivo.duplicado]), [['d0', 'atual'], ['d1', 'parado']]);
  assert.equal(dup.produtos[1].motivo.desde, '2026-10-02T12:00:00.000Z');
  assert.ok(b.dados(`estabelecimentos/${LOJA}/Products/d1`));
  const semResumo = new FirestoreEmMemoria({ [`estabelecimentos/${LOJA}`]: {} });
  const vazio = await casoDeUso(semResumo).resumo({ ator });
  assert.equal(vazio.grupos.find((g) => g.chave === 'duplicados').quantidade, 0);
});

test('5.1: promocao que nao aparece (com o motivo) e promocao acima do preco cheio, so as valendo', async () => {
  const { grupos, resumo } = await casoDeUso().resumo({ ator });
  const fora = grupos.find((g) => g.chave === 'promocaoNaoAparece');
  assert.deepEqual(fora.produtos.map((p) => [p.id, p.motivo.por]).sort(), [['l1', 'inativo_na_web'], ['z1', 'estoque_zerado']]);
  assert.equal(fora.produtos.find((p) => p.id === 'l1').motivo.ate, '2026-11-30T02:59:59.000Z');
  assert.equal(resumo.promocoesQueNaoAparecem, 2);
  const acima = grupos.find((g) => g.chave === 'promocaoAcimaDoPreco');
  assert.deepEqual(acima.produtos.map((p) => [p.id, p.preco, p.motivo.promocao]), [['a1', 2.69, 3.18]]);
  assert.equal(promocaoValendo({ promotionalPrice: 3, promotionEndAt: dia('2026-11-10T02:59:59Z') }, AGORA), false);
  assert.equal(promocaoValendo({ promotionalPrice: 3, promotionStartAt: dia('2026-11-25T03:00:00Z') }, AGORA), false);
});

test('5.1: resumo do topo e "Sem código" sem fonte no banco', async () => {
  const dados = await casoDeUso().resumo({ ator });
  assert.equal(dados.resumo.aVendaNoApp, 6); // ligados fora da lixeira: ok1, ok2, a1, a2, d0 e d1
  const semCodigo = dados.grupos.find((g) => g.chave === 'semCodigo');
  assert.deepEqual(semCodigo, { chave: 'semCodigo', secao: 'acao', quantidade: null, indisponivel: true, produtos: [] });
  // Precisam de acao: Linear 2 + promo fora 2 + promo acima 1 + sem preco 1 + a mao 1 + duplicados 1.
  assert.equal(dados.resumo.precisamDeAcao, 8);
  assert.equal(dados.resumo.desligadosPeloEstoque, 3);
  assert.equal(dados.arquivosSeparados, 1);
});

test('5.1: faixa do integrador: fechado, parado, sem exportar (24 h sem arquivo) e arquivo com defeito', () => {
  const agora = AGORA;
  const ha = (ms) => new Date(agora - ms);
  assert.equal(faixaDoIntegrador({ status: null, agora }), null); // loja sem integrador
  assert.deepEqual(faixaDoIntegrador({ status: { lastSeenAt: ha(FECHADO_DEPOIS_MS + 1000) }, agora }), { tipo: 'fechado', desde: ha(FECHADO_DEPOIS_MS + 1000).toISOString() });
  const vivo = { lastSeenAt: ha(60_000) };
  assert.deepEqual(faixaDoIntegrador({ status: { ...vivo, readyFilesOnDisk: 3, oldestReadyFileAt: ha(45 * 60_000) }, ultimaLeitura: ha(60 * 60_000), agora }),
    { tipo: 'parado', desde: ha(45 * 60_000).toISOString() });
  assert.deepEqual(faixaDoIntegrador({ status: { ...vivo, readStuck: true, readStuckSince: ha(20 * 60_000) }, agora }), { tipo: 'parado', desde: ha(20 * 60_000).toISOString() });
  assert.deepEqual(faixaDoIntegrador({ status: { ...vivo, readyFilesOnDisk: 0 }, ultimaLeitura: ha(25 * 3600_000), agora }), { tipo: 'semExportar', desde: ha(25 * 3600_000).toISOString() });
  assert.equal(faixaDoIntegrador({ status: { ...vivo, readyFilesOnDisk: 0 }, ultimaLeitura: ha(23 * 3600_000), agora }), null);
  assert.deepEqual(faixaDoIntegrador({ status: { ...vivo, readyFilesOnDisk: 0, quarantinedFiles: 2 }, ultimaLeitura: ha(3600_000), agora }), { tipo: 'defeito', desde: null });
});

test('5.1: sem o indice composto (offReasons + isTrashed) a leitura repete sem o filtro da lixeira', async () => {
  const b = banco();
  const consultaOriginal = FirestoreProdutosForaDoAppRepository.prototype.consulta;
  const avisos = [];
  const repositorio = new FirestoreProdutosForaDoAppRepository({ firestore: b, logger: { warn: (m) => avisos.push(m) } });
  repositorio.consulta = function (lojaId, filtros) {
    const temArray = filtros.some(([, op]) => op === 'array-contains');
    const temLixeira = filtros.some(([campo]) => campo === 'isTrashed');
    if (temArray && temLixeira) {
      const falha = Object.assign(new Error('9 FAILED_PRECONDITION: The query requires an index.'), { code: 9 });
      return { count: () => ({ get: async () => { throw falha; } }), limit: () => ({ get: async () => { throw falha; } }) };
    }
    return consultaOriginal.call(this, lojaId, filtros);
  };
  const lista = await repositorio.produtos({ lojaId: LOJA, filtros: [['offReasons', 'array-contains', 'inativo_na_web'], ['isTrashed', '==', false]], limite: 10 });
  assert.deepEqual(lista.map((p) => p.id).sort(), ['l1', 'l2']); // a da lixeira sai na memoria
  assert.equal(await repositorio.contarProdutos({ lojaId: LOJA, filtros: [['offReasons', 'array-contains', 'inativo_na_web'], ['isTrashed', '==', false]] }), 3);
  assert.ok(avisos.includes('produtos_fora_do_app_sem_indice'));
});

async function subirRota(conta = ator) {
  const b = banco();
  const app = express();
  app.use('/api/produtos', createProdutosRoutes({
    historicoDoProduto: new HistoricoDoProduto({ repositorio: new FirestoreHistoricoDoProdutoRepository({ firestore: b }) }),
    produtosForaDoApp: casoDeUso(b),
    accountForRequest: async () => conta,
  }));
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}/api/produtos`;
  return { base, fechar: () => new Promise((resolve) => servidor.close(resolve)) };
}

test('5.1: rotas GET /api/produtos/fora-do-app e /fora-do-app/:grupo; sem loja, 403', async () => {
  const rota = await subirRota();
  try {
    const resumo = await (await fetch(`${rota.base}/fora-do-app`)).json();
    assert.equal(resumo.data.grupos.length, 10);
    const grupo = await (await fetch(`${rota.base}/fora-do-app/abaixoEstoqueSeguranca?limite=50`)).json();
    assert.deepEqual(grupo.data.produtos.map((p) => p.id), ['s1']); // "Ver todos" traz os produtos
    assert.equal((await fetch(`${rota.base}/fora-do-app/naoExiste`)).status, 400);
    assert.equal((await fetch(`${rota.base}/fora-do-app/a-b`)).status, 400);
  } finally {
    await rota.fechar();
  }
  const semLoja = await subirRota({ hasEstablishment: false });
  try {
    assert.equal((await fetch(`${semLoja.base}/fora-do-app`)).status, 403);
  } finally {
    await semLoja.fechar();
  }
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.ok(server.includes('produtosForaDoApp: new ProdutosForaDoApp({ repositorio: new FirestoreProdutosForaDoAppRepository({ firestore }) }),'));
});
