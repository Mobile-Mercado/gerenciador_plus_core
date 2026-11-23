import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import express from 'express';
import { GUARDA_DA_SITUACAO_MS, SessoesWeb } from '../src/application/sessoes/SessoesWeb.js';
import { navegadorDoAgente, sistemaDoAgente } from '../src/domain/sessoes/navegadorDoAgente.js';
import { FirestoreSessoesWebRepository } from '../src/infra/firebase/FirestoreSessoesWebRepository.js';
import { ManagerDataAccessPolicy } from '../src/infra/firebase/ManagerDataAccessPolicy.js';
import { createAdminRoutes } from '../src/http/routes/adminRoutes.js';
import { createSessoesWebRoutes } from '../src/http/routes/sessoesWebRoutes.js';
import { createAdminAuditMiddleware } from '../src/http/middlewares/adminAudit.js';
import { createPlatformAdminGuard } from '../src/http/middlewares/requirePlatformAdmin.js';
import { createSessaoWebGuard, fimDaTransicao } from '../src/http/middlewares/sessaoWeb.js';
import { errorHandler } from '../src/http/middlewares/errorHandler.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Item 5.10 "Acessos conectados" (plano construcao-acessos-conectados.md, mockup aprovado sem a cidade).
// Falham com o codigo de antes: o Core nao guardava sessao, nao conferia X-Sessao e nao tinha as rotas.

const INICIO = new Date('2026-11-24T12:00:00Z');
const CHROME_11 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const EDGE = `${CHROME_11} Edg/131.0.0.0`;
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const RETRATO_A = 'a'.repeat(64);
const RETRATO_B = 'b'.repeat(64);
const IP_LOJA = '203.0.113.24';
const IP_CASA = '198.51.100.7';

function relogio(inicio = INICIO) {
  let agora = inicio.getTime();
  return { agora: () => new Date(agora), andar: (ms) => { agora += ms; } };
}

function montar({ dados = {}, clock = relogio(), ids = null } = {}) {
  const banco = new FirestoreEmMemoria({ 'estabelecimentos/loja-1': { name: 'Loja 1' }, ...dados });
  let n = 0;
  const novoId = ids || (() => { n += 1; return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`; });
  const repositorio = new FirestoreSessoesWebRepository({ firestore: banco, serverTimestamp: () => clock.agora() });
  const sessoesWeb = new SessoesWeb({ repositorio, clock: clock.agora, novoId });
  return { banco, repositorio, sessoesWeb, clock };
}

// Servidor com o caminho de verdade: login falso por cabecalho, rotas da loja, barreira do X-Sessao numa
// rota da loja e o /api/admin com barreira e auditoria.
async function comServidor(usar, { publicadoEm = null, ...opcoes } = {}) {
  const montado = montar(opcoes);
  const { banco, sessoesWeb, clock } = montado;
  const accountForRequest = async (request) => {
    if (request.auth?.uid === 'uid-sem-loja') {
      throw Object.assign(new Error('sem loja'), { code: 'data_establishment_required' });
    }
    return { establishmentId: 'loja-1' };
  };
  const { requirePlatformAdmin } = createPlatformAdminGuard({ platformAdminRepository: { isPlatformAdmin: async (uid) => uid === 'uid-admin' } });
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.auth = request.headers['x-uid'] ? { uid: request.headers['x-uid'], email: 'ana@mobile.test', exp: 9999999999 } : undefined;
    next();
  });
  app.use('/api/sessoes-web', createSessoesWebRoutes({ sessoesWeb, accountForRequest }));
  app.get(
    '/api/coupons',
    createSessaoWebGuard({ accountForRequest, sessoesWeb, publicadoEm, clock: () => clock.agora().getTime() }),
    (_request, response) => response.json({ data: [] }),
  );
  app.use(
    '/api/admin',
    requirePlatformAdmin,
    createAdminAuditMiddleware({ firestore: banco, serverTimestamp: () => clock.agora() }),
    createAdminRoutes({ sessoesWeb }),
  );
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const chamar = async (caminho, { metodo = 'GET', uid = 'uid-dono', sessao = null, origem = 'https://gerenciador.test', agente = CHROME_11, corpo, ip = IP_LOJA } = {}) => {
    const resposta = await fetch(`http://127.0.0.1:${servidor.address().port}${caminho}`, {
      method: metodo,
      headers: {
        'x-uid': uid || '',
        'user-agent': agente,
        'x-forwarded-for': `${ip}, 10.0.0.1`,
        ...(origem ? { origin: origem } : {}),
        ...(sessao ? { 'x-sessao': sessao } : {}),
        ...(corpo !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    return { status: resposta.status, corpo: await resposta.json() };
  };
  try {
    await usar({ ...montado, chamar });
  } finally {
    servidor.closeAllConnections();
    servidor.close();
  }
}

const sessoesNoBanco = (banco) => [...banco.docs.entries()].filter(([caminho]) => caminho.startsWith('estabelecimentos/loja-1/SessoesWeb/'));
const esperarAuditoria = () => new Promise((resolve) => { setTimeout(resolve, 20); });

test('5.10: abas do mesmo navegador sao uma linha so (mesmo sessaoId do localStorage)', async () => {
  await comServidor(async ({ banco, chamar }) => {
    const primeira = await chamar('/api/sessoes-web/registrar', { metodo: 'POST', corpo: { retrato: RETRATO_A, versaoDoSistema: '15.0.0' } });
    assert.equal(primeira.status, 200);
    const { sessaoId } = primeira.corpo.data;
    assert.equal(primeira.corpo.data.nome, null);
    // Outras duas abas: o mesmo id do localStorage no registro e no sinal.
    for (let aba = 0; aba < 2; aba += 1) {
      // eslint-disable-next-line no-await-in-loop
      const outra = await chamar('/api/sessoes-web/registrar', { metodo: 'POST', corpo: { sessaoId, retrato: RETRATO_A, versaoDoSistema: '15.0.0' } });
      assert.equal(outra.corpo.data.sessaoId, sessaoId);
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await chamar('/api/sessoes-web/sinal', { metodo: 'POST', sessao: sessaoId })).status, 200);
    }
    assert.equal(sessoesNoBanco(banco).length, 1);
    const lista = await chamar('/api/admin/lojas/loja-1/acessos', { uid: 'uid-admin' });
    assert.equal(lista.corpo.data.navegadores, 1);
    assert.equal(lista.corpo.data.grupos.length, 1);
    assert.deepEqual(lista.corpo.data.grupos[0].sessoes.map((s) => [s.navegador, s.sistema]), [['Chrome', 'Windows 11']]);
    // Outro navegador do mesmo computador (outro localStorage): outra linha.
    await chamar('/api/sessoes-web/registrar', { metodo: 'POST', agente: EDGE, corpo: { retrato: RETRATO_A } });
    assert.equal(sessoesNoBanco(banco).length, 2);
  });
});

test('5.10: nome do computador na primeira entrada, guardado na sessao e devolvido na volta', async () => {
  await comServidor(async ({ chamar }) => {
    const { sessaoId } = (await chamar('/api/sessoes-web/registrar', { metodo: 'POST', corpo: {} })).corpo.data;
    const nomeado = await chamar('/api/sessoes-web/nome', { metodo: 'PATCH', sessao: sessaoId, corpo: { nome: '  Caixa  ' } });
    assert.equal(nomeado.status, 200);
    assert.equal(nomeado.corpo.data.nome, 'Caixa');
    const volta = await chamar('/api/sessoes-web/registrar', { metodo: 'POST', corpo: { sessaoId } });
    assert.deepEqual(volta.corpo.data, { sessaoId, nome: 'Caixa' });
    assert.equal((await chamar('/api/sessoes-web/nome', { metodo: 'PATCH', sessao: sessaoId, corpo: { nome: '   ' } })).status, 400);
    // Conta sem loja nao entra na lista.
    const semLoja = await chamar('/api/sessoes-web/registrar', { metodo: 'POST', uid: 'uid-sem-loja', corpo: {} });
    assert.deepEqual(semLoja.corpo.data, { sessaoId: null, nome: null });
  });
});

test('5.10: Sair encerra em ate 30 s: o sinal recebe 401 sessao_encerrada e a barreira tambem, ate em outra instancia', async () => {
  await comServidor(async ({ chamar, repositorio, clock, banco }) => {
    const { sessaoId } = (await chamar('/api/sessoes-web/registrar', { metodo: 'POST', corpo: {} })).corpo.data;
    // Outra instancia do Core, que ja guardou "ativa" para esta sessao.
    const outraInstancia = new SessoesWeb({ repositorio, clock: clock.agora });
    assert.equal(await outraInstancia.situacao({ lojaId: 'loja-1', sessaoId }), 'ativa');
    assert.equal((await chamar('/api/coupons', { sessao: sessaoId })).status, 200);

    const sair = await chamar(`/api/admin/lojas/loja-1/acessos/${sessaoId}/sair`, { metodo: 'POST', uid: 'uid-admin' });
    assert.equal(sair.status, 200);
    assert.equal(sair.corpo.data.encerradas, 1);
    // O sinal seguinte (no maximo 30 s depois) ja recebe 401.
    clock.andar(30_000);
    const sinal = await chamar('/api/sessoes-web/sinal', { metodo: 'POST', sessao: sessaoId });
    assert.equal(sinal.status, 401);
    assert.equal(sinal.corpo.error.code, 'sessao_encerrada');
    const cupons = await chamar('/api/coupons', { sessao: sessaoId });
    assert.equal(cupons.status, 401);
    assert.equal(cupons.corpo.error.code, 'sessao_encerrada');
    // A outra instancia deixa de aceitar quando a guarda (10 s) acaba, antes dos 30 s.
    assert.ok(GUARDA_DA_SITUACAO_MS <= 30_000);
    assert.equal(await outraInstancia.situacao({ lojaId: 'loja-1', sessaoId }), 'encerrada');
    const doc = banco.dados(`estabelecimentos/loja-1/SessoesWeb/${sessaoId}`);
    assert.equal(doc.motivo, 'admin');
    assert.equal(doc.encerradaPor, 'uid-admin');
    // Entrar de novo no mesmo navegador cria outra sessao (pergunta o nome de novo).
    const volta = await chamar('/api/sessoes-web/registrar', { metodo: 'POST', corpo: { sessaoId } });
    assert.notEqual(volta.corpo.data.sessaoId, sessaoId);
    assert.equal(volta.corpo.data.nome, null);
    await esperarAuditoria();
    const auditoria = [...banco.docs.entries()].filter(([caminho]) => caminho.startsWith('adminAuditLogs/')).map(([, dados]) => dados);
    assert.equal(auditoria.length, 1);
    assert.equal(auditoria[0].uid, 'uid-admin');
    assert.equal(auditoria[0].acao, 'acessos_sair');
    assert.deepEqual(auditoria[0].lojas, ['loja-1']);
    assert.equal([...banco.docs.keys()].filter((caminho) => caminho.startsWith('estabelecimentos/loja-1/AdminAuditLogs/')).length, 1);
  });
});

test('5.10: Sair de todos deste IP e Sair de todos encerram so o que devem; quem nao e admin recebe 403', async () => {
  await comServidor(async ({ chamar, banco }) => {
    const naLoja = [];
    for (let i = 0; i < 2; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      naLoja.push((await chamar('/api/sessoes-web/registrar', { metodo: 'POST', corpo: {}, ip: IP_LOJA })).corpo.data.sessaoId);
    }
    const emCasa = (await chamar('/api/sessoes-web/registrar', { metodo: 'POST', corpo: {}, ip: IP_CASA })).corpo.data.sessaoId;
    assert.equal((await chamar('/api/admin/lojas/loja-1/acessos/sair-do-ip', { metodo: 'POST', uid: 'uid-dono', corpo: { ip: IP_LOJA } })).status, 403);
    const doIp = await chamar('/api/admin/lojas/loja-1/acessos/sair-do-ip', { metodo: 'POST', uid: 'uid-admin', corpo: { ip: IP_LOJA } });
    assert.equal(doIp.corpo.data.encerradas, 2);
    assert.equal((await chamar('/api/sessoes-web/sinal', { metodo: 'POST', sessao: emCasa, ip: IP_CASA })).status, 200);
    naLoja.forEach((id) => assert.equal(banco.dados(`estabelecimentos/loja-1/SessoesWeb/${id}`).motivo, 'admin'));
    const todos = await chamar('/api/admin/lojas/loja-1/acessos/sair-de-todos', { metodo: 'POST', uid: 'uid-admin', corpo: {} });
    assert.equal(todos.corpo.data.encerradas, 1);
    assert.equal((await chamar('/api/sessoes-web/sinal', { metodo: 'POST', sessao: emCasa, ip: IP_CASA })).status, 401);
    assert.equal((await chamar('/api/admin/lojas/loja-x/acessos', { uid: 'uid-admin' })).status, 404);
  });
});

test('5.10: transicao de 7 dias sem X-Sessao; depois so o navegador e barrado (o App Gerenciador continua)', async () => {
  const PUBLICADO = '2026-11-24T12:00:00Z';
  assert.equal(fimDaTransicao(PUBLICADO).toISOString(), '2026-12-01T12:00:00.000Z');
  assert.equal(fimDaTransicao(null), null);
  await comServidor(async ({ chamar, clock }) => {
    assert.equal((await chamar('/api/coupons')).status, 200);
    clock.andar(7 * 86_400_000 - 1000);
    assert.equal((await chamar('/api/coupons')).status, 200);
    clock.andar(1000);
    const barrado = await chamar('/api/coupons');
    assert.equal(barrado.status, 401);
    assert.equal(barrado.corpo.error.code, 'sessao_obrigatoria');
    // Sem Origin (App Gerenciador do celular, que chama /api/coupons sem navegador): passa.
    assert.equal((await chamar('/api/coupons', { origem: null })).status, 200);
    // Com a sessao registrada, o navegador passa.
    const { sessaoId } = (await chamar('/api/sessoes-web/registrar', { metodo: 'POST', corpo: {} })).corpo.data;
    assert.equal((await chamar('/api/coupons', { sessao: sessaoId })).status, 200);
    // Conta sem loja nao e barrada pela sessao (a rota decide).
    assert.equal((await chamar('/api/coupons', { uid: 'uid-sem-loja' })).status, 200);
  }, { publicadoEm: PUBLICADO });
  // Sem a data de publicacao, a transicao nao acaba.
  await comServidor(async ({ chamar, clock }) => {
    clock.andar(400 * 86_400_000);
    assert.equal((await chamar('/api/coupons')).status, 200);
  });
});

test('5.10: limpeza de 7 dias sem uso: a sessao apagada vale como encerrada e sai da lista', async () => {
  await comServidor(async ({ chamar, clock, banco }) => {
    const velha = (await chamar('/api/sessoes-web/registrar', { metodo: 'POST', corpo: {} })).corpo.data.sessaoId;
    clock.andar(6 * 86_400_000);
    const nova = (await chamar('/api/sessoes-web/registrar', { metodo: 'POST', corpo: {}, agente: EDGE })).corpo.data.sessaoId;
    clock.andar(86_400_000 + 1000);
    const lista = await chamar('/api/admin/lojas/loja-1/acessos', { uid: 'uid-admin' });
    assert.deepEqual(lista.corpo.data.grupos.flatMap((g) => g.sessoes.map((s) => s.sessaoId)), [nova]);
    // A rotina diaria (functions/sessoesWeb.js) apaga o documento: o navegador recebe 401.
    banco.docs.delete(`estabelecimentos/loja-1/SessoesWeb/${velha}`);
    const sinal = await chamar('/api/sessoes-web/sinal', { metodo: 'POST', sessao: velha });
    assert.equal(sinal.status, 401);
    assert.equal(sinal.corpo.error.code, 'sessao_encerrada');
    assert.equal((await chamar('/api/coupons', { sessao: velha })).corpo.error.code, 'sessao_encerrada');
  });
});

test('5.10: lista por IP, IP sem nome primeiro, "mesmo computador" pelo retrato, nomes editaveis', async () => {
  await comServidor(async ({ chamar, clock }) => {
    const fernanda = (await chamar('/api/sessoes-web/registrar', { metodo: 'POST', corpo: { retrato: RETRATO_A }, ip: IP_LOJA })).corpo.data.sessaoId;
    await chamar('/api/sessoes-web/registrar', { metodo: 'POST', agente: EDGE, corpo: { retrato: RETRATO_A }, ip: IP_LOJA });
    await chamar('/api/sessoes-web/registrar', { metodo: 'POST', corpo: { retrato: RETRATO_B }, ip: IP_LOJA });
    clock.andar(60_000);
    await chamar('/api/sessoes-web/registrar', { metodo: 'POST', agente: IPHONE, corpo: {}, ip: IP_CASA });
    const nomeIp = await chamar('/api/admin/lojas/loja-1/acessos/ips', { metodo: 'PUT', uid: 'uid-admin', corpo: { ip: IP_LOJA, nome: 'Loja' } });
    assert.deepEqual(nomeIp.corpo.data, { ip: IP_LOJA, nome: 'Loja' });
    const renomeado = await chamar(`/api/admin/lojas/loja-1/acessos/${fernanda}`, { metodo: 'PATCH', uid: 'uid-admin', corpo: { nome: 'Fernanda' } });
    assert.equal(renomeado.corpo.data.nome, 'Fernanda');
    // Mesmo o grupo nomeado tendo uso mais antigo, o IP sem nome vem primeiro.
    clock.andar(60_000);
    await chamar('/api/sessoes-web/sinal', { metodo: 'POST', sessao: fernanda, ip: IP_LOJA });
    const { grupos } = (await chamar('/api/admin/lojas/loja-1/acessos', { uid: 'uid-admin' })).corpo.data;
    assert.deepEqual(grupos.map((g) => [g.ip, g.nome]), [[IP_CASA, null], [IP_LOJA, 'Loja']]);
    assert.deepEqual(grupos[0].sessoes.map((s) => [s.navegador, s.sistema, s.mesmoComputador]), [['Safari', 'iPhone', false]]);
    const loja = grupos[1].sessoes;
    assert.equal(loja[0].nome, 'Fernanda');
    assert.equal(loja[0].mesmoComputador, true);
    assert.deepEqual(loja.filter((s) => s.mesmoComputador).map((s) => s.navegador).sort(), ['Chrome', 'Edge']);
    assert.deepEqual(loja.filter((s) => !s.mesmoComputador).map((s) => s.navegador), ['Chrome']);
    // Tirar o nome do IP volta o grupo a "IP sem nome".
    await chamar('/api/admin/lojas/loja-1/acessos/ips', { metodo: 'PUT', uid: 'uid-admin', corpo: { ip: IP_LOJA, nome: '' } });
    const depois = (await chamar('/api/admin/lojas/loja-1/acessos', { uid: 'uid-admin' })).corpo.data.grupos;
    assert.ok(depois.every((g) => g.nome === null));
  });
});

test('5.10: navegador e sistema pelo User-Agent; sem "anonimo"', () => {
  assert.equal(navegadorDoAgente(CHROME_11), 'Chrome');
  assert.equal(navegadorDoAgente(EDGE), 'Edge');
  assert.equal(navegadorDoAgente(IPHONE), 'Safari');
  assert.equal(navegadorDoAgente('Mozilla/5.0 (Windows NT 10.0; rv:133.0) Gecko/20100101 Firefox/133.0'), 'Firefox');
  assert.equal(sistemaDoAgente(CHROME_11, '15.0.0'), 'Windows 11');
  assert.equal(sistemaDoAgente(CHROME_11, '10.0.0'), 'Windows 10');
  assert.equal(sistemaDoAgente(CHROME_11, null), 'Windows');
  assert.equal(sistemaDoAgente(IPHONE), 'iPhone');
});

test('5.10: o BFF de dados nunca le nem grava SessoesWeb nem IpsNomeados; rotas ligadas no app.js', async () => {
  const policy = new ManagerDataAccessPolicy({ firestore: new FirestoreEmMemoria({}) });
  const actor = { uid: 'uid-dono', establishmentId: 'loja-1', hasEstablishment: true };
  const negado = (erro) => erro.statusCode === 403;
  for (const colecao of ['SessoesWeb', 'IpsNomeados']) {
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(policy.assertRead({ actor, target: { kind: 'collection', path: `estabelecimentos/loja-1/${colecao}` } }), negado);
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(policy.assertMutation({
      actor, mutation: { operation: 'set', options: { merge: true }, target: { kind: 'document', path: `estabelecimentos/loja-1/${colecao}/x` }, data: { nome: 'x' } },
    }), negado);
  }
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  for (const rota of ['/api/session', '/api/data', '/api/coupons', '/api/loja/entregadores', '/api/catalogo']) {
    const bloco = app.slice(app.indexOf(`'${rota}',`), app.indexOf(`'${rota}',`) + 200);
    assert.match(bloco, /createFirebaseAuthMiddleware\(\{ required: [^}]+\}\),\s+sessaoWeb,/, rota);
  }
  const admin = app.slice(app.indexOf("'/api/admin',"), app.indexOf('app.use(notFoundHandler)'));
  assert.ok(admin.includes('sessoesWeb,'));
  assert.ok(!admin.includes('sessaoWeb,'));
});
