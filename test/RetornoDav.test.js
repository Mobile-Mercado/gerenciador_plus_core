import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { RetornoDav } from '../src/application/retornoDav/RetornoDav.js';
import { deduzirEntregas } from '../src/domain/retornoDav/entregaPeloRegistro.js';
import { puladosPelaRegraDoNumero, situacaoDoRetorno } from '../src/domain/retornoDav/situacaoDoRetorno.js';
import { FirestoreRetornoDavRepository } from '../src/infra/firebase/FirestoreRetornoDavRepository.js';
import { ManagerDataAccessPolicy } from '../src/infra/firebase/ManagerDataAccessPolicy.js';
import { createRetornoDavRoutes } from '../src/http/routes/retornoDavRoutes.js';
import { createPermissionGuard } from '../src/http/middlewares/requirePermission.js';
import { createLojaAlvoDoAdmin } from '../src/http/middlewares/lojaAlvoDoAdmin.js';
import { errorHandler } from '../src/http/middlewares/errorHandler.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Itens 5.13 (aba "Retorno DAV") e 4.21 ("Reenviar ao Linear"), aprovados pelo Thay em 23/11. Dados de
// exemplo, numeros como os da Zero Grau e sem dado de cliente. Falham com o codigo de antes: a rota, o
// caso de uso e as situacoes nao existiam, e o BFF lia e gravava ReturnSales.

const AGORA = new Date('2026-11-24T13:00:00Z');
const RS = 'estabelecimentos/loja-1/ReturnSales';
const h = (iso) => new Date(iso);

// Situacoes da tela, uma de cada (prontoEm = updatedAt nos testes; em producao, a criacao do documento).
function vendasDeExemplo() {
  return {
    'estabelecimentos/loja-1': { name: 'Loja 1' },
    // 4.20, gravado e confirmado.
    [`${RS}/v441`]: { numeroPedido: 441, orderNumber: '000441', updatedAt: h('2026-11-24T13:02:00Z'), aguardaGravacao: false, gravadoEm: h('2026-11-24T13:04:00Z') },
    // Antes da 4.20, hora da entrega preenchida pelo script.
    [`${RS}/v439`]: { numeroPedido: 439, orderNumber: '000439', updatedAt: h('2026-11-22T15:29:00Z'), entregueEm: h('2026-11-22T15:31:00Z') },
    // Antes da 4.20, sem a hora (script nao rodou).
    [`${RS}/v438`]: { numeroPedido: 438, orderNumber: '000438', updatedAt: h('2026-11-21T21:44:00Z') },
    // Pronto depois do 434: o integrador antigo nunca buscou (caso real do 432).
    [`${RS}/v434`]: { numeroPedido: 434, orderNumber: '000434', updatedAt: h('2026-11-16T18:05:00Z') },
    [`${RS}/v432`]: { numeroPedido: 432, orderNumber: '000432', updatedAt: h('2026-11-17T11:32:00Z') },
    // 4.20 que saiu para um integrador sem confirmacao (1.0.36).
    [`${RS}/v437`]: { numeroPedido: 437, orderNumber: '000437', updatedAt: h('2026-11-20T12:00:00Z'), aguardaGravacao: false, entregueSemConfirmacaoEm: h('2026-11-20T12:03:00Z') },
    // 4.20 recem-pronto: ainda esperando a busca de 5 min.
    [`${RS}/v442`]: { numeroPedido: 442, orderNumber: '000442', updatedAt: h('2026-11-24T12:50:00Z'), aguardaGravacao: true },
    // 4.20 parado ha mais de 30 min: nao enviado.
    [`${RS}/v440`]: { numeroPedido: 440, orderNumber: '000440', updatedAt: h('2026-11-24T12:15:00Z'), aguardaGravacao: true },
    // Fora dos 30 dias.
    [`${RS}/v300`]: { numeroPedido: 300, orderNumber: '000300', updatedAt: h('2026-09-01T12:00:00Z') },
  };
}

function montar(dados = vendasDeExemplo()) {
  const banco = new FirestoreEmMemoria(dados);
  const retornoDav = new RetornoDav({ repositorio: new FirestoreRetornoDavRepository({ firestore: banco, serverTimestamp: () => AGORA }), clock: () => AGORA });
  return { banco, retornoDav };
}

async function comServidor(usar, dados) {
  const { banco, retornoDav } = montar(dados);
  const contas = {
    'uid-dono': { hasEstablishment: true, establishmentId: 'loja-1', permissions: { isAdmin: true, keys: [] }, userDocument: { nome: 'Fernanda' } },
    'uid-func': { hasEstablishment: true, establishmentId: 'loja-1', permissions: { isAdmin: false, keys: ['requests.view'] } },
  };
  const { requirePermission, accountForRequest } = createPermissionGuard({
    accessRepository: { findAccountByClaims: async ({ uid }) => contas[uid] || { hasEstablishment: false } },
  });
  const isPlatformAdminForRequest = async (request) => request.auth?.uid === 'uid-admin';
  const registrosDoAdmin = [];
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.auth = { uid: request.headers['x-uid'], email: `${request.headers['x-uid']}@mobile.test`, exp: 9999999999 };
    next();
  });
  app.use(
    '/api/retorno-dav',
    createLojaAlvoDoAdmin({ isPlatformAdminForRequest, firestore: banco }),
    createRetornoDavRoutes({ retornoDav, requirePermission, accountForRequest, registrarAcaoDoAdmin: async (r) => registrosDoAdmin.push(r) }),
  );
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const chamar = async (caminho, { metodo = 'GET', uid = 'uid-dono', lojaAlvo } = {}) => {
    const r = await fetch(`http://127.0.0.1:${servidor.address().port}/api/retorno-dav${caminho}`, {
      method: metodo,
      headers: { 'x-uid': uid, ...(lojaAlvo ? { 'x-loja-alvo': lojaAlvo } : {}), ...(metodo === 'POST' ? { 'content-type': 'application/json' } : {}) },
      body: metodo === 'POST' ? '{}' : undefined,
    });
    return { status: r.status, corpo: await r.json() };
  };
  try {
    await usar({ chamar, banco, registrosDoAdmin });
  } finally {
    servidor.closeAllConnections();
    servidor.close();
  }
}

const acoes = (banco) => [...banco.docs.entries()].filter(([c]) => c.startsWith('estabelecimentos/loja-1/AcoesEquipe/')).map(([, d]) => d);

test('5.13: uma linha por pedido pronto, com a situacao, a hora e o arquivo (30 dias por padrao)', async () => {
  await comServidor(async ({ chamar }) => {
    const { status, corpo } = await chamar('/');
    assert.equal(status, 200);
    const porPedido = Object.fromEntries(corpo.data.map((l) => [l.pedido, l]));
    assert.deepEqual(corpo.data.map((l) => l.pedido), ['000441', '000442', '000440', '000439', '000438', '000437', '000432', '000434']);
    assert.deepEqual(
      [porPedido['000441'].rotulo, porPedido['000441'].em, porPedido['000441'].arquivo],
      ['Gravado na pasta', '2026-11-24T13:04:00.000Z', 'VENDAWEB_441.xml'],
    );
    assert.deepEqual([porPedido['000439'].rotulo, porPedido['000439'].em], ['Entregue', '2026-11-22T15:31:00.000Z']);
    assert.deepEqual([porPedido['000438'].rotulo, porPedido['000438'].em], ['Entregue', null]);
    assert.deepEqual([porPedido['000437'].rotulo, porPedido['000437'].em], ['Entregue', '2026-11-20T12:03:00.000Z']);
    assert.deepEqual([porPedido['000432'].rotulo, porPedido['000432'].podeReenviar], ['Não enviado', true]);
    assert.deepEqual([porPedido['000434'].rotulo, porPedido['000434'].podeReenviar], ['Entregue', false]);
    assert.deepEqual([porPedido['000440'].rotulo, porPedido['000440'].podeReenviar], ['Não enviado', true]);
    assert.deepEqual([porPedido['000442'].rotulo, porPedido['000442'].podeReenviar], ['Aguardando o integrador', false]);
    assert.equal(porPedido['000432'].prontoEm, '2026-11-17T11:32:00.000Z');
    // So "Nao enviado" tem o botao.
    assert.deepEqual(corpo.data.filter((l) => l.podeReenviar).map((l) => l.pedido).sort(), ['000432', '000440']);
    // Periodo: todos traz o de setembro; 7 dias, so os da semana.
    assert.equal((await chamar('/?dias=todos')).corpo.data.length, 9);
    assert.deepEqual((await chamar('/?dias=1')).corpo.data.map((l) => l.pedido), ['000441', '000442', '000440']);
  });
});

test('4.21: reenvio so em "Nao enviado", marca para a proxima busca (4.20), registra no Log e nunca se repete', async () => {
  await comServidor(async ({ chamar, banco }) => {
    const r = await chamar('/v432/reenviar', { metodo: 'POST' });
    assert.equal(r.status, 200);
    assert.deepEqual([r.corpo.data.rotulo, r.corpo.data.quem, r.corpo.data.podeReenviar], ['Reenvio pedido', 'Fernanda', false]);
    const doc = banco.dados(`${RS}/v432`);
    assert.equal(doc.aguardaGravacao, true);
    assert.equal(doc.buscadoPor, undefined);
    assert.deepEqual(doc.reenvio, { em: AGORA, uid: 'uid-dono', quem: 'Fernanda', porAdmin: false });
    const log = acoes(banco);
    assert.equal(log.length, 1);
    assert.equal(log[0].acao, 'reenviar_ao_linear');
    assert.equal(log[0].quem, 'uid-dono@mobile.test');
    assert.deepEqual(log[0].alvo, { tipo: 'pedido', id: 'v432', rotulo: '#000432' });
    assert.equal(log[0].em.toISOString(), AGORA.toISOString());

    // A lista mostra "Reenvio pedido" com quem e quando, sem o botao.
    const linha = (await chamar('/')).corpo.data.find((l) => l.pedido === '000432');
    assert.deepEqual([linha.rotulo, linha.quem, linha.em, linha.podeReenviar], ['Reenvio pedido', 'Fernanda', AGORA.toISOString(), false]);

    // De novo: recusado, nada muda e nada entra no Log.
    const outra = await chamar('/v432/reenviar', { metodo: 'POST' });
    assert.equal(outra.status, 409);
    assert.equal(outra.corpo.error.code, 'reenvio_ja_pedido');
    assert.equal(acoes(banco).length, 1);

    // O integrador grava e confirma (confirmSalesFromCompany): vira "Gravado na pasta" e continua sem botao.
    await banco.collection('estabelecimentos').doc('loja-1').collection('ReturnSales').doc('v432')
      .update({ aguardaGravacao: false, gravadoEm: h('2026-11-24T13:05:00Z') });
    const gravada = (await chamar('/')).corpo.data.find((l) => l.pedido === '000432');
    assert.deepEqual([gravada.rotulo, gravada.podeReenviar], ['Gravado na pasta', false]);
    assert.equal((await chamar('/v432/reenviar', { metodo: 'POST' })).status, 409);
  });
});

test('4.21: gravado, entregue e aguardando nao reenviam; pedido inexistente, 404', async () => {
  await comServidor(async ({ chamar, banco }) => {
    for (const id of ['v441', 'v439', 'v438', 'v437', 'v442', 'v434']) {
      // eslint-disable-next-line no-await-in-loop
      const r = await chamar(`/${id}/reenviar`, { metodo: 'POST' });
      assert.equal(r.status, 409, id);
      assert.equal(r.corpo.error.code, 'reenvio_nao_permitido', id);
    }
    assert.equal((await chamar('/vxyz/reenviar', { metodo: 'POST' })).status, 404);
    assert.equal(acoes(banco).length, 0);
    assert.equal(banco.dados(`${RS}/v434`).aguardaGravacao, undefined);
  });
});

test('4.21: dois cliques ao mesmo tempo reenviam uma vez so', async () => {
  const { banco, retornoDav } = montar();
  const ator = { uid: 'uid-dono', quem: 'Fernanda' };
  const resultados = await Promise.allSettled([
    retornoDav.reenviar({ lojaId: 'loja-1', vendaId: 'v432', ator }),
    retornoDav.reenviar({ lojaId: 'loja-1', vendaId: 'v432', ator }),
  ]);
  assert.equal(resultados.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(resultados.find((r) => r.status === 'rejected').reason.code, 'reenvio_ja_pedido');
  assert.equal(acoes(banco).length, 1);
});

test('4.21: a Movel (Admin da plataforma na loja escolhida) tambem reenvia, com o registro do Admin', async () => {
  await comServidor(async ({ chamar, banco, registrosDoAdmin }) => {
    const r = await chamar('/v440/reenviar', { metodo: 'POST', uid: 'uid-admin', lojaAlvo: 'loja-1' });
    assert.equal(r.status, 200);
    assert.equal(r.corpo.data.quem, 'Móbile');
    assert.equal(banco.dados(`${RS}/v440`).reenvio.porAdmin, true);
    assert.equal(acoes(banco)[0].origem, 'admin');
    assert.equal(registrosDoAdmin.length, 1);
    assert.deepEqual(registrosDoAdmin[0].detalhes, { acao: 'reenviar_ao_linear', pedido: '000440' });
    // Sem ser admin, a loja alvo e recusada.
    assert.equal((await chamar('/', { uid: 'uid-dono', lojaAlvo: 'loja-1' })).status, 403);
  });
});

test('5.13 e 4.21: so quem ve os logs (logs.view) ve a aba e reenvia', async () => {
  await comServidor(async ({ chamar }) => {
    assert.equal((await chamar('/', { uid: 'uid-func' })).status, 403);
    assert.equal((await chamar('/v432/reenviar', { metodo: 'POST', uid: 'uid-func' })).status, 403);
  });
});

test('4.21: pedido nao enviado pronto ha mais de 30 dias aparece sem o botao e nao reenvia (os 10 antigos do 2.25)', async () => {
  const dados = {
    'estabelecimentos/loja-1': { name: 'Loja 1' },
    [`${RS}/v371`]: { numeroPedido: 371, orderNumber: '000371', updatedAt: h('2026-07-09T12:00:00Z') },
    [`${RS}/v360`]: { numeroPedido: 360, orderNumber: '000360', updatedAt: h('2026-07-10T10:12:00Z') },
  };
  await comServidor(async ({ chamar, banco }) => {
    const linha = (await chamar('/?dias=todos')).corpo.data.find((l) => l.pedido === '000360');
    assert.deepEqual([linha.rotulo, linha.podeReenviar], ['Não enviado', false]);
    const r = await chamar('/v360/reenviar', { metodo: 'POST' });
    assert.equal(r.status, 409);
    assert.equal(r.corpo.error.code, 'reenvio_nao_permitido');
    assert.equal(banco.dados(`${RS}/v360`).reenvio, undefined);
  }, dados);
});

test('5.14: "Ja lancado no Linear" so ao lado do reenvio, vira "Lancado a mao" com quem e quando, e nunca reenvia', async () => {
  await comServidor(async ({ chamar, banco }) => {
    const lista = (await chamar('/')).corpo.data;
    lista.forEach((l) => assert.equal(l.podeMarcarLancado, l.podeReenviar, l.pedido));
    const r = await chamar('/v432/lancado', { metodo: 'POST' });
    assert.equal(r.status, 200);
    assert.deepEqual(
      [r.corpo.data.rotulo, r.corpo.data.quem, r.corpo.data.em, r.corpo.data.podeReenviar, r.corpo.data.podeMarcarLancado],
      ['Lançado à mão', 'Fernanda', AGORA.toISOString(), false, false],
    );
    const doc = banco.dados(`${RS}/v432`);
    assert.deepEqual(doc.lancadoAMao, { em: AGORA, uid: 'uid-dono', quem: 'Fernanda', porAdmin: false });
    // gravadoEm junto: a nuvem do integrador (foiGravada) nunca mais entrega o pedido.
    assert.equal(doc.gravadoEm.toISOString(), AGORA.toISOString());
    assert.equal(doc.aguardaGravacao, false);
    const log = acoes(banco);
    assert.equal(log.length, 1);
    assert.deepEqual([log[0].acao, log[0].quem, log[0].alvo.rotulo], ['lancado_no_linear', 'uid-dono@mobile.test', '#000432']);
    // A lista mostra "Lancado a mao", sem os dois botoes.
    const linha = (await chamar('/')).corpo.data.find((l) => l.pedido === '000432');
    assert.deepEqual([linha.rotulo, linha.quem, linha.podeReenviar, linha.podeMarcarLancado], ['Lançado à mão', 'Fernanda', false, false]);
    // Uma vez so; e o reenvio fica recusado para sempre.
    const deNovo = await chamar('/v432/lancado', { metodo: 'POST' });
    assert.deepEqual([deNovo.status, deNovo.corpo.error.code], [409, 'lancado_ja_marcado']);
    const reenvio = await chamar('/v432/reenviar', { metodo: 'POST' });
    assert.deepEqual([reenvio.status, reenvio.corpo.error.code], [409, 'reenvio_nao_permitido']);
    assert.equal(banco.dados(`${RS}/v432`).reenvio, undefined);
    assert.equal(acoes(banco).length, 1);
  });
});

test('5.14: pedido da 4.20 parado marcado como lancado sai da busca do integrador (aguardaGravacao false e gravadoEm)', async () => {
  await comServidor(async ({ chamar, banco }) => {
    assert.equal((await chamar('/v440/lancado', { metodo: 'POST' })).status, 200);
    const doc = banco.dados(`${RS}/v440`);
    assert.equal(doc.aguardaGravacao, false);
    assert.ok(doc.gravadoEm);
    assert.equal(doc.buscadoPor, undefined);
  });
});

test('5.14: gravado, entregue, aguardando e reenvio pedido nao marcam; dois cliques marcam uma vez', async () => {
  await comServidor(async ({ chamar, banco }) => {
    assert.equal((await chamar('/v440/reenviar', { metodo: 'POST' })).status, 200);
    for (const id of ['v441', 'v439', 'v438', 'v437', 'v442', 'v434', 'v440']) {
      // eslint-disable-next-line no-await-in-loop
      const r = await chamar(`/${id}/lancado`, { metodo: 'POST' });
      assert.deepEqual([r.status, r.corpo.error.code], [409, 'lancado_nao_permitido'], id);
    }
    assert.equal(acoes(banco).filter((a) => a.acao === 'lancado_no_linear').length, 0);
  });
  const { banco, retornoDav } = montar();
  const ator = { uid: 'uid-dono', quem: 'Fernanda' };
  const resultados = await Promise.allSettled([
    retornoDav.marcarLancado({ lojaId: 'loja-1', vendaId: 'v432', ator }),
    retornoDav.marcarLancado({ lojaId: 'loja-1', vendaId: 'v432', ator }),
  ]);
  assert.equal(resultados.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(resultados.find((r) => r.status === 'rejected').reason.code, 'lancado_ja_marcado');
  assert.equal(acoes(banco).length, 1);
});

test('5.14: a Mobile tambem marca, com o registro do Admin', async () => {
  await comServidor(async ({ chamar, registrosDoAdmin }) => {
    const r = await chamar('/v432/lancado', { metodo: 'POST', uid: 'uid-admin', lojaAlvo: 'loja-1' });
    assert.equal(r.status, 200);
    assert.equal(r.corpo.data.quem, 'Móbile');
    assert.deepEqual(registrosDoAdmin[0].detalhes, { acao: 'lancado_no_linear', pedido: '000432' });
  });
});

test('regra antiga do numero: pronto depois de um pronto maior (com 10 min de folga) nunca saiu', () => {
  const vendas = [
    { id: 'a', numero: 434, prontoEm: h('2026-11-16T18:05:00Z') },
    { id: 'b', numero: 432, prontoEm: h('2026-11-17T11:32:00Z') },
    { id: 'c', numero: 436, prontoEm: h('2026-11-18T14:03:00Z') },
    // Prontos no mesmo minuto saem na mesma busca.
    { id: 'd', numero: 450, prontoEm: h('2026-11-25T10:00:00Z') },
    { id: 'e', numero: 449, prontoEm: h('2026-11-25T10:01:00Z') },
  ];
  assert.deepEqual([...puladosPelaRegraDoNumero(vendas)], ['b']);
  assert.equal(situacaoDoRetorno({ id: 'x', dados: { naoEnviado: true } }).situacao, 'nao_enviado');
});

test('hora da entrega de antes da 4.20 deduzida do registro de getSalesFromCompany', () => {
  const vendas = [
    { id: 'v438', numero: 438, prontoEm: h('2026-11-19T14:11:00Z') },
    { id: 'v432', numero: 432, prontoEm: h('2026-11-17T11:32:00Z') },
  ];
  const buscas = [
    { em: h('2026-11-17T11:36:00Z'), ultimo: 434, status: 200, bytes: 2 },
    { em: h('2026-11-19T14:10:00Z'), ultimo: 436, status: 200, bytes: 2 },
    { em: h('2026-11-19T14:15:00Z'), ultimo: 436, status: 200, bytes: 9000 },
    { em: h('2026-11-19T14:20:00Z'), ultimo: 438, status: 200, bytes: 2 },
  ];
  const entregas = deduzirEntregas(vendas, buscas);
  assert.equal(entregas.get('v438').toISOString(), '2026-11-19T14:15:00.000Z');
  assert.equal(entregas.has('v432'), false);
});

test('o BFF de dados nunca le nem grava ReturnSales (o reenvio passa pela rota do Core)', async () => {
  const policy = new ManagerDataAccessPolicy({ firestore: new FirestoreEmMemoria({}) });
  const actor = { uid: 'uid-dono', establishmentId: 'loja-1', hasEstablishment: true, permissions: { isAdmin: true, keys: [] } };
  const negado = (erro) => erro.statusCode === 403;
  await assert.rejects(policy.assertRead({ actor, target: { kind: 'collection', path: RS } }), negado);
  await assert.rejects(policy.assertMutation({
    actor, mutation: { operation: 'update', target: { kind: 'document', path: `${RS}/v432` }, data: { aguardaGravacao: true } },
  }), negado);
});
