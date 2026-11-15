import assert from 'node:assert/strict';
import test from 'node:test';
import { PedidosDeLoja } from '../src/application/admin/PedidosDeLoja.js';
import { AparenciaDaLoja } from '../src/application/loja/AparenciaDaLoja.js';
import { blocoDaLoja, coresPadraoDe } from '../src/domain/loja/primeiroAcesso.js';
import { AuthEmMemoria } from './apoio/authEmMemoria.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Cola B56-25, itens 6 e 7: cor do texto do rodape na Abertura e na Primeira tela, e as cores com
// que as lojas novas nascem (aparenciaPadrao/cores), definidas pelo Admin.
const HORA = () => new Date('2026-11-15T12:00:00Z');

function bancoComPedido(extras = {}) {
  const banco = new FirestoreEmMemoria({
    'Users/uid-dono': { id: 'uid-dono', userAuthId: 'uid-dono', userType: 'UserType.empresa', pedidoDeLojaId: 'pedido-novo' },
    'estabelecimentos/antiga': { name: 'Antiga', primaryColor: '#123456', secondaryColor: '#654321' },
    ...extras,
  });
  banco.docs.set('pedidosDeLoja/pedido-novo', {
    id: 'pedido-novo', uid: 'uid-dono', lojaId: null, name: 'Bom Preço', status: 'em_analise',
    origemCadastro: 'app_gerenciador', userReference: banco.doc('Users/uid-dono'),
  });
  const auth = new AuthEmMemoria([{ uid: 'uid-dono', email: 'ana@bp.com.br', customClaims: {} }]);
  return { banco, auth };
}

test('rodape: abertura.rodapeCor (padrao #FFFFFF) e primeiraTela.rodapeCor (padrao #7A8099)', () => {
  assert.equal(blocoDaLoja('abertura', {}).rodapeCor, '#FFFFFF');
  assert.equal(blocoDaLoja('primeiraTela', {}).rodapeCor, '#7A8099');
  assert.equal(blocoDaLoja('abertura', { abertura: { rodapeCor: '#1b1b1f' } }).rodapeCor, '#1B1B1F');
  assert.equal(blocoDaLoja('abertura', { abertura: { rodapeCor: 'branco' } }).rodapeCor, '#FFFFFF', 'fora do formato vale o padrao');
});

test('cores padrao: sem documento, loja #2E4BD6 e sistema #1F9D4E; gravar muda so o documento', async () => {
  const { banco } = bancoComPedido();
  const aparencia = new AparenciaDaLoja({ firestore: banco, serverTimestamp: HORA });
  assert.deepEqual(await aparencia.coresPadrao(), { loja: '#2E4BD6', sistema: '#1F9D4E' });
  const resultado = await aparencia.mudarCoresPadrao({ loja: '#ff0000', sistema: '#00aa00' }, { uid: 'uid-admin' });
  assert.deepEqual([resultado.loja, resultado.sistema], ['#FF0000', '#00AA00']);
  assert.deepEqual(resultado.antes, { loja: '#2E4BD6', sistema: '#1F9D4E' });
  assert.equal(banco.dados('aparenciaPadrao/cores').atualizadoPor, 'uid-admin');
  assert.deepEqual(await aparencia.coresPadrao(), { loja: '#FF0000', sistema: '#00AA00' });
  const antiga = banco.dados('estabelecimentos/antiga');
  assert.deepEqual([antiga.primaryColor, antiga.secondaryColor], ['#123456', '#654321'], 'as lojas que ja existem nao mudam');
  assert.deepEqual(coresPadraoDe({ loja: 'azul' }), { loja: '#2E4BD6', sistema: '#1F9D4E' });
});

test('loja aprovada nasce com primaryColor = loja e secondaryColor = sistema do padrao; sem padrao, os de fabrica', async () => {
  const semPadrao = bancoComPedido();
  await new PedidosDeLoja({ firestore: semPadrao.banco, auth: semPadrao.auth, serverTimestamp: HORA }).aprovar('pedido-novo', { uid: 'a' });
  const lojaId = semPadrao.banco.dados('pedidosDeLoja/pedido-novo').lojaId;
  const loja = semPadrao.banco.dados(`estabelecimentos/${lojaId}`);
  assert.deepEqual([loja.primaryColor, loja.secondaryColor], ['#2E4BD6', '#1F9D4E']);

  const comPadrao = bancoComPedido({ 'aparenciaPadrao/cores': { loja: '#AA0000', sistema: '#0000AA' } });
  await new PedidosDeLoja({ firestore: comPadrao.banco, auth: comPadrao.auth, serverTimestamp: HORA }).aprovar('pedido-novo', { uid: 'a' });
  const outra = comPadrao.banco.dados(`estabelecimentos/${comPadrao.banco.dados('pedidosDeLoja/pedido-novo').lojaId}`);
  assert.deepEqual([outra.primaryColor, outra.secondaryColor], ['#AA0000', '#0000AA']);
  assert.equal(comPadrao.banco.dados('estabelecimentos/antiga').primaryColor, '#123456');
});

test('rotas do Admin: GET e PUT /aparencia-padrao-cores, com formato conferido e auditoria', async () => {
  const { default: express } = await import('express');
  const { createAdminRoutes } = await import('../src/http/routes/adminRoutes.js');
  const { createAdminAuditMiddleware } = await import('../src/http/middlewares/adminAudit.js');
  const { errorHandler } = await import('../src/http/middlewares/errorHandler.js');
  const { banco } = bancoComPedido();
  const aparencia = new AparenciaDaLoja({ firestore: banco, serverTimestamp: HORA });
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = { uid: 'admin-1', email: 'admin@x' }; next(); });
  app.use('/api/admin', createAdminAuditMiddleware({ firestore: banco, serverTimestamp: HORA }), createAdminRoutes({ aparenciaDaLoja: aparencia }));
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}/api/admin/aparencia-padrao-cores`;
  const chamar = (metodo, corpo) => fetch(base, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: corpo ? JSON.stringify(corpo) : undefined });
  try {
    assert.deepEqual((await (await chamar('GET')).json()).data, { loja: '#2E4BD6', sistema: '#1F9D4E' });
    assert.equal((await chamar('PUT', { loja: 'vermelho', sistema: '#00AA00' })).status, 400);
    assert.equal((await chamar('PUT', { loja: '#FF0000' })).status, 400, 'as duas cores juntas');
    assert.equal((await chamar('PUT', { loja: '#FF0000', sistema: '#00AA00', outra: 1 })).status, 400);
    const ok = await chamar('PUT', { loja: '#ff0000', sistema: '#00aa00' });
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).data, { loja: '#FF0000', sistema: '#00AA00' });
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    const registro = [...banco.docs.values()].find((d) => d.acao === 'cores_padrao_lojas_novas' && d.status === 200);
    assert.ok(registro, 'auditoria');
    assert.deepEqual(registro.depois, { loja: '#FF0000', sistema: '#00AA00' });
    assert.deepEqual(registro.antes, { loja: '#2E4BD6', sistema: '#1F9D4E' });
  } finally {
    servidor.closeAllConnections();
    servidor.close();
  }
});
