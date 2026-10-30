import assert from 'node:assert/strict';
import test from 'node:test';
import { PedidosDeLoja } from '../src/application/admin/PedidosDeLoja.js';
import { JornadaDoCadastro } from '../src/application/cadastro/JornadaDoCadastro.js';
import { AuthEmMemoria } from './apoio/authEmMemoria.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

const AGORA = Date.parse('2026-10-17T15:00:00Z');
const PASSO1 = {
  nome: 'Ana Paula',
  celular: '27998765432',
  email: 'ana@bompreco.com.br',
  erp: { escolhido: 'Linear' },
  aceiteTermos: { aceito: true, em: '2026-10-17T12:00:00-03:00' },
};

async function montar() {
  const banco = new FirestoreEmMemoria();
  const jornada = new JornadaDoCadastro({ firestore: banco, clock: () => AGORA, paraData: (ms) => new Date(ms) });
  const pedidos = new PedidosDeLoja({ firestore: banco, auth: new AuthEmMemoria(), jornada });
  // Parou no passo 2, com o CNPJ e a cidade da Receita.
  await jornada.gravarRascunho({ instalacaoId: 'inst-parou-no-2', passo: 1, dados: PASSO1 });
  await jornada.gravarRascunho({
    instalacaoId: 'inst-parou-no-2',
    passo: 2,
    dados: { cnpj: '11222333000181', receita: { encontrado: true, ativa: true, razaoSocial: 'MERCADO X LTDA', endereco: { city: 'SERRA', uf: 'ES' } } },
  });
  // Parou no passo 1.
  await jornada.gravarRascunho({ instalacaoId: 'inst-parou-no-1', passo: 1, dados: { ...PASSO1, nome: 'Bruno Lima' } });
  // So abriu e tocou em Comecar: sem dado pessoal, nao entra na lista.
  await jornada.registrarEvento({ instalacaoId: 'inst-so-comecou', tipo: 'comecar' });
  // Virou pedido: nao entra na lista de incompletos.
  await jornada.gravarRascunho({ instalacaoId: 'inst-concluida', passo: 1, dados: PASSO1 });
  await jornada.concluir('inst-concluida', 'loja-1');
  return { banco, jornada, pedidos };
}

test('lista de incompletos: etapa em que parou, dados, cidade da Receita e datas', async () => {
  const { pedidos } = await montar();
  const linhas = await pedidos.listar('incompletos');
  assert.deepEqual(linhas.map((linha) => linha.instalacaoId).sort(), ['inst-parou-no-1', 'inst-parou-no-2']);
  const parouNo2 = linhas.find((linha) => linha.instalacaoId === 'inst-parou-no-2');
  assert.equal(parouNo2.tipo, 'incompleto');
  assert.equal(parouNo2.situacao, 'em_andamento');
  assert.equal(parouNo2.etapa, 2);
  assert.equal(parouNo2.dados.nome, 'Ana Paula');
  assert.equal(parouNo2.dados.email, 'ana@bompreco.com.br');
  assert.deepEqual(parouNo2.dados.erp, { escolhido: 'Linear', texto: null });
  assert.equal(parouNo2.dados.cnpj, '11222333000181');
  assert.equal(parouNo2.dados.razaoSocial, 'MERCADO X LTDA');
  assert.equal(parouNo2.cidadeReceita, 'SERRA');
  assert.equal(parouNo2.ufReceita, 'ES');
  assert.equal(parouNo2.cidadeAcesso, null);
  assert.ok(parouNo2.criadoEm && parouNo2.atualizadoEm && parouNo2.comecouEm && parouNo2.aceiteTermosEm);
  assert.equal(linhas.find((linha) => linha.instalacaoId === 'inst-parou-no-1').etapa, 1);
});

test('Em conversa e Descartar so marcam: nada e apagado e o descartado vai para a outra lista', async () => {
  const { banco, pedidos } = await montar();
  const emConversa = await pedidos.marcarIncompleto('inst-parou-no-2', 'em_conversa', { uid: 'uid-admin' });
  assert.equal(emConversa.situacao, 'em_conversa');
  assert.ok((await pedidos.listar('incompletos')).some((linha) => linha.instalacaoId === 'inst-parou-no-2'));

  await pedidos.marcarIncompleto('inst-parou-no-1', 'descartado', { uid: 'uid-admin' });
  assert.deepEqual((await pedidos.listar('incompletos')).map((linha) => linha.instalacaoId), ['inst-parou-no-2']);
  const descartados = await pedidos.listar('descartados');
  assert.deepEqual(descartados.map((linha) => linha.instalacaoId), ['inst-parou-no-1']);
  assert.equal(descartados[0].dados.nome, 'Bruno Lima', 'os dados ficam');
  const doc = banco.dados('jornadasCadastro/inst-parou-no-1');
  assert.equal(doc.marcadoPor, 'uid-admin');
  assert.ok(doc.dados.passo1);
  assert.equal(banco.dados('funilCadastro/2026-10-17').descartados, 1);
  assert.equal(banco.dados('funilCadastro/2026-10-17').emConversa, 1);

  // Volta para em andamento.
  assert.equal((await pedidos.marcarIncompleto('inst-parou-no-1', 'em_andamento', {})).situacao, 'em_andamento');
  await assert.rejects(pedidos.marcarIncompleto('inst-concluida', 'descartado', {}), (erro) => erro.code === 'cadastro_ja_concluido');
  await assert.rejects(pedidos.marcarIncompleto('inst-so-comecou', 'descartado', {}), (erro) => erro.code === 'cadastro_incompleto_nao_encontrado');
  await assert.rejects(pedidos.marcarIncompleto('inst-parou-no-2', 'concluido', {}), (erro) => erro.code === 'cadastro_situacao_invalida');
});

test('rotas do Admin: lista de incompletos e marcar situacao, atras da mesma barreira de admin', async () => {
  const { default: express } = await import('express');
  const { createAdminRoutes } = await import('../src/http/routes/adminRoutes.js');
  const { errorHandler } = await import('../src/http/middlewares/errorHandler.js');
  const { AppError } = await import('../src/domain/errors/AppError.js');
  const { pedidos } = await montar();
  const app = express();
  app.use(express.json());
  // Mesmo papel do requirePlatformAdmin de app.js.
  app.use('/api/admin', (request, _response, next) => {
    if (request.headers['x-admin'] !== 'sim') {
      next(new AppError('Acesso restrito.', { statusCode: 403, code: 'admin_required' }));
      return;
    }
    request.auth = { uid: 'uid-admin' };
    next();
  }, createAdminRoutes({ pedidosDeLoja: pedidos }));
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}/api/admin/pedidos-de-loja`;
  try {
    assert.equal((await fetch(`${base}?lista=incompletos`)).status, 403);
    const lista = await fetch(`${base}?lista=incompletos`, { headers: { 'x-admin': 'sim' } });
    assert.equal(lista.status, 200);
    assert.equal((await lista.json()).data.length, 2);

    const marcar = await fetch(`${base}/incompletos/inst-parou-no-2/situacao`, {
      method: 'POST', headers: { 'x-admin': 'sim', 'Content-Type': 'application/json' }, body: JSON.stringify({ situacao: 'descartado' }),
    });
    assert.equal(marcar.status, 200);
    assert.equal((await marcar.json()).data.situacao, 'descartado');
    const invalida = await fetch(`${base}/incompletos/inst-parou-no-2/situacao`, {
      method: 'POST', headers: { 'x-admin': 'sim', 'Content-Type': 'application/json' }, body: JSON.stringify({ situacao: 'apagado' }),
    });
    assert.equal(invalida.status, 400);
  } finally {
    servidor.close();
  }
});
