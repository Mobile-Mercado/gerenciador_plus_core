import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { SessoesWeb } from '../src/application/sessoes/SessoesWeb.js';
import * as navegador from '../src/domain/sessoes/navegadorDoAgente.js';
import { autorDaAcao } from '../src/domain/logs/autorDaAcao.js';
import { FirestoreSessoesWebRepository } from '../src/infra/firebase/FirestoreSessoesWebRepository.js';
import { nomeDoComputadorNaLoja } from '../src/infra/firebase/nomeDoComputador.js';
import { createSessoesWebRoutes } from '../src/http/routes/sessoesWebRoutes.js';
import { errorHandler } from '../src/http/middlewares/errorHandler.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Cola do Thay B57-18l, item 2 (diferenca B57-18j-5, aprovada com ajuste): o nome dado fica no
// navegador e vai em todo registro; sem nome dado, o nome automatico "{sistema} · {navegador}"; com
// nome dado, o nome e, ao lado, o automatico. A janela "Nome deste computador" sai.
// Falham com o codigo de antes: nao havia nomeAutomatico, o registro ignorava o nome do corpo e o
// autor dos Logs nao levava o automatico.

const INICIO = new Date('2026-11-28T12:00:00Z');
const CHROME_11 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ID_ANTIGO = '11111111-1111-4111-8111-111111111111';
const ID_DADO = '22222222-2222-4222-8222-222222222222';

function montar(dados = {}) {
  const banco = new FirestoreEmMemoria({ 'estabelecimentos/loja-1': { name: 'Loja 1' }, ...dados });
  let n = 0;
  const novoId = () => { n += 1; return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`; };
  const repositorio = new FirestoreSessoesWebRepository({ firestore: banco, serverTimestamp: () => INICIO });
  return { banco, sessoesWeb: new SessoesWeb({ repositorio, clock: () => INICIO, novoId }) };
}

const doc = (banco, id) => banco.docs.get(`estabelecimentos/loja-1/SessoesWeb/${id}`);
const registrar = (sessoesWeb, extra = {}) => sessoesWeb.registrar({
  lojaId: 'loja-1', uid: 'uid-dono', userAgent: CHROME_11, versaoDoSistema: '15.0.0', ip: '203.0.113.24', ...extra,
});

test('B57-18l item 2: formato do nome automatico "{sistema} · {navegador}"', () => {
  assert.equal(typeof navegador.nomeAutomatico, 'function');
  assert.equal(navegador.nomeAutomatico({ sistema: 'Windows 11', navegador: 'Chrome' }), 'Windows 11 · Chrome');
  assert.equal(navegador.nomeAutomatico({ sistema: 'Sistema desconhecido', navegador: 'Chrome' }), 'Chrome');
  assert.equal(navegador.nomeAutomatico({ sistema: null, navegador: 'Firefox' }), 'Firefox');
});

test('B57-18l item 2: sessao nova nasce com o nome guardado no navegador; sem ele, nome null e o automatico', async () => {
  const { banco, sessoesWeb } = montar();
  const comNome = await registrar(sessoesWeb, { nome: '  Caixa 1 ' });
  assert.deepEqual(comNome, { sessaoId: comNome.sessaoId, nome: 'Caixa 1', nomeAutomatico: 'Windows 11 · Chrome' });
  assert.equal(doc(banco, comNome.sessaoId).nome, 'Caixa 1');
  const semNome = await registrar(sessoesWeb);
  assert.deepEqual(semNome, { sessaoId: semNome.sessaoId, nome: null, nomeAutomatico: 'Windows 11 · Chrome' });
  // O documento guarda so o nome dado: o automatico e calculado na leitura.
  assert.equal(doc(banco, semNome.sessaoId).nome, null);
});

test('B57-18l item 2: sessao antiga sem nome recebe o guardado; nome ja dado nao e trocado', async () => {
  const { banco, sessoesWeb } = montar({
    [`estabelecimentos/loja-1/SessoesWeb/${ID_ANTIGO}`]: { uid: 'uid-dono', nome: null, encerradaEm: null },
    [`estabelecimentos/loja-1/SessoesWeb/${ID_DADO}`]: { uid: 'uid-dono', nome: 'Escritório', encerradaEm: null },
  });
  const antiga = await registrar(sessoesWeb, { sessaoId: ID_ANTIGO, nome: 'Caixa 1' });
  assert.deepEqual(antiga, { sessaoId: ID_ANTIGO, nome: 'Caixa 1', nomeAutomatico: 'Windows 11 · Chrome' });
  assert.equal(doc(banco, ID_ANTIGO).nome, 'Caixa 1');
  const dada = await registrar(sessoesWeb, { sessaoId: ID_DADO, nome: 'Caixa 1' });
  assert.equal(dada.nome, 'Escritório');
  assert.equal(doc(banco, ID_DADO).nome, 'Escritório');
});

test('B57-18l item 2: nome guardado invalido (mais de 40 letras) e ignorado, sem 400, pela rota', async () => {
  const { banco, sessoesWeb } = montar();
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = { uid: 'uid-dono' }; next(); });
  app.use('/api/sessoes-web', createSessoesWebRoutes({ sessoesWeb, accountForRequest: async () => ({ establishmentId: 'loja-1' }) }));
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const chamar = (corpo) => fetch(`http://127.0.0.1:${servidor.address().port}/api/sessoes-web/registrar`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': CHROME_11 }, body: JSON.stringify(corpo),
    }).then(async (r) => ({ status: r.status, corpo: await r.json() }));
    const longo = await chamar({ nome: 'x'.repeat(41) });
    assert.equal(longo.status, 200);
    assert.equal(longo.corpo.data.nome, null);
    const certo = await chamar({ nome: 'Delivery' });
    assert.equal(certo.corpo.data.nome, 'Delivery');
    assert.equal(doc(banco, certo.corpo.data.sessaoId).nome, 'Delivery');
  } finally {
    servidor.closeAllConnections();
    servidor.close();
  }
});

test('B57-18l item 2: a lista do Admin traz o nome automatico em cada navegador', async () => {
  const { sessoesWeb } = montar();
  await registrar(sessoesWeb, { nome: 'Caixa 1' });
  await registrar(sessoesWeb);
  const lista = await sessoesWeb.listar({ lojaId: 'loja-1' });
  const linhas = lista.grupos.flatMap((grupo) => grupo.sessoes);
  const porNome = (a, b) => String(a[0]).localeCompare(String(b[0]));
  assert.deepEqual(linhas.map((linha) => [linha.nome, linha.nomeAutomatico]).sort(porNome), [['Caixa 1', 'Windows 11 · Chrome'], [null, 'Windows 11 · Chrome']]);
});

test('B57-18l item 2: o autor dos Logs leva o nome dado e o automatico (sem sessao, nenhum)', async () => {
  const banco = new FirestoreEmMemoria({
    'estabelecimentos/loja-1/SessoesWeb/s-dado': { nome: 'Caixa 1', navegador: 'Chrome', sistema: 'Windows 11' },
    'estabelecimentos/loja-1/SessoesWeb/s-sem': { nome: null, navegador: 'Edge', sistema: 'Windows 10' },
  });
  const dado = await nomeDoComputadorNaLoja(banco, 'loja-1', 's-dado');
  const sem = await nomeDoComputadorNaLoja(banco, 'loja-1', 's-sem');
  assert.deepEqual(dado, { nome: 'Caixa 1', automatico: 'Windows 11 · Chrome' });
  assert.deepEqual(sem, { nome: null, automatico: 'Windows 10 · Edge' });
  assert.equal(await nomeDoComputadorNaLoja(banco, 'loja-1', null), null);
  assert.equal(await nomeDoComputadorNaLoja(banco, 'loja-1', 's-nao-existe'), null);

  const actor = { uid: 'f-ana', userDocument: { name: 'Ana', email: 'ana@loja.test' } };
  assert.deepEqual(autorDaAcao(actor, dado), {
    tipo: 'funcionario', nome: 'Ana', email: 'ana@loja.test', computador: 'Caixa 1', computadorAutomatico: 'Windows 11 · Chrome',
  });
  assert.deepEqual(autorDaAcao(actor, sem), {
    tipo: 'funcionario', nome: 'Ana', email: 'ana@loja.test', computador: null, computadorAutomatico: 'Windows 10 · Edge',
  });
  assert.deepEqual(autorDaAcao(actor, null), { tipo: 'funcionario', nome: 'Ana', email: 'ana@loja.test', computador: null });
});
