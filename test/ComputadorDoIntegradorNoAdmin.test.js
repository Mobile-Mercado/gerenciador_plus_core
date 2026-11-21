import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { IntegradorDaLoja, hashDoComputador } from '../src/application/admin/IntegradorDaLoja.js';
import { FirestoreIntegradorDaLojaRepository } from '../src/infra/firebase/FirestoreIntegradorDaLojaRepository.js';
import { createAdminRoutes } from '../src/http/routes/adminRoutes.js';
import { createAdminAuditMiddleware } from '../src/http/middlewares/adminAudit.js';
import { createPlatformAdminGuard } from '../src/http/middlewares/requirePlatformAdmin.js';
import { errorHandler } from '../src/http/middlewares/errorHandler.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Cola 70 (4.11, tela A do Admin): card "Computador do integrador" na loja aberta.
// GET /api/admin/lojas/:establishmentId/integrador, so admin da plataforma (usersAdmin/{uid}.isAdmin,
// a barreira do /api/admin). Dados de exemplo; hash e nomes de computador falsos.

const AGORA = new Date('2026-11-20T15:00:00Z');
const REGISTRO = 'estabelecimentos/loja-1/IntegradorDaLoja/atual';
const STATUS = 'estabelecimentos/loja-1/IntegrationStatus/current';
const HASH = 'a'.repeat(64);

async function comAdmin(usar, dados = {}) {
  const banco = new FirestoreEmMemoria({ 'estabelecimentos/loja-1': { name: 'Loja 1' }, ...dados });
  const integradorDaLoja = new IntegradorDaLoja({
    repositorio: new FirestoreIntegradorDaLojaRepository({ firestore: banco, serverTimestamp: () => AGORA }),
  });
  const { requirePlatformAdmin } = createPlatformAdminGuard({
    platformAdminRepository: { isPlatformAdmin: async (uid) => uid === 'uid-admin' },
  });
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.auth = { uid: request.headers['x-uid'] || undefined, email: 'ana@mobile.test', exp: 9999999999 };
    next();
  });
  app.use(
    '/api/admin',
    requirePlatformAdmin,
    createAdminAuditMiddleware({ firestore: banco, serverTimestamp: () => AGORA }),
    createAdminRoutes({ integradorDaLoja }),
  );
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const ler = async (loja, uid = 'uid-admin') => {
    const resposta = await fetch(`http://127.0.0.1:${servidor.address().port}/api/admin/lojas/${loja}/integrador`, {
      headers: { 'x-uid': uid },
    });
    return { status: resposta.status, corpo: await resposta.json() };
  };
  try {
    await usar({ ler, banco });
  } finally {
    servidor.closeAllConnections();
    servidor.close();
  }
}

test('cola 70, item 1: Desde, Ultimo sinal e versao do integrador; o hash nunca sai', async () => {
  await comAdmin(async ({ ler }) => {
    const { status, corpo } = await ler('loja-1');
    assert.equal(status, 200);
    assert.equal(corpo.data.establishmentId, 'loja-1');
    assert.equal(corpo.data.registrado, true);
    assert.equal(corpo.data.registradoEm, '2026-11-20T11:13:00.000Z');
    assert.equal(corpo.data.ultimoSinalEm, '2026-11-20T14:58:00.000Z');
    assert.equal(corpo.data.versao, '1.0.37');
    assert.equal(corpo.data.trocaLiberadaEm, null);
    assert.ok(!JSON.stringify(corpo).includes(HASH));
  }, {
    [REGISTRO]: {
      maquina: HASH, registradoEm: new Date('2026-11-20T11:13:00Z'), ultimoUsoEm: new Date('2026-11-20T14:50:00Z'),
      trocaLiberadaEm: null, trocaLiberadaPor: null,
    },
    [STATUS]: { lastSeenAt: new Date('2026-11-20T14:58:00Z'), version: '1.0.37', erpKey: 'linear' },
  });
});

test('cola 70, item 1: loja sem registro e sem sinal de vida devolve os campos vazios', async () => {
  await comAdmin(async ({ ler }) => {
    const { status, corpo } = await ler('loja-1');
    assert.equal(status, 200);
    assert.equal(corpo.data.registrado, false);
    assert.equal(corpo.data.registradoEm, null);
    assert.equal(corpo.data.ultimoSinalEm, null);
    assert.equal(corpo.data.versao, null);
  });
});

test('cola 70, item 1: so admin da plataforma le; loja inexistente, 404; GET nao entra na auditoria', async () => {
  await comAdmin(async ({ ler, banco }) => {
    assert.equal((await ler('loja-1', 'uid-dono')).status, 403);
    const inexistente = await ler('loja-x');
    assert.equal(inexistente.status, 404);
    assert.equal(inexistente.corpo.error.code, 'loja_nao_encontrada');
    await ler('loja-1');
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    assert.equal([...banco.docs.keys()].filter((caminho) => caminho.startsWith('adminAuditLogs/')).length, 0);
  });
});

// --- Cola 70, item 2: o nome vem de IntegrationStatus/current.machineName ---

test('cola 70, item 2: o nome do computador vem de IntegrationStatus.machineName quando o hash confere com o registrado', async () => {
  const nome = 'CAIXA-01';
  await comAdmin(async ({ ler }) => {
    const { corpo } = await ler('loja-1');
    assert.equal(corpo.data.computador, nome);
  }, {
    [REGISTRO]: { maquina: hashDoComputador(nome), registradoEm: new Date('2026-11-20T11:13:00Z'), trocaLiberadaEm: null },
    [STATUS]: { lastSeenAt: new Date('2026-11-20T14:58:00Z'), version: '1.0.37', machineName: nome },
  });
});

test('cola 70, item 2: sinal de vida de outro computador nao da nome ao registrado; sem registro, vale o do sinal', async () => {
  await comAdmin(async ({ ler }) => {
    assert.equal((await ler('loja-1')).corpo.data.computador, null);
  }, {
    [REGISTRO]: { maquina: hashDoComputador('CAIXA-01'), registradoEm: new Date('2026-11-20T11:13:00Z'), trocaLiberadaEm: null },
    [STATUS]: { lastSeenAt: new Date('2026-11-20T14:58:00Z'), machineName: 'ENTREGA-02' },
  });
  await comAdmin(async ({ ler }) => {
    assert.equal((await ler('loja-1')).corpo.data.computador, 'ENTREGA-02');
  }, {
    [STATUS]: { lastSeenAt: new Date('2026-11-20T14:58:00Z'), machineName: 'ENTREGA-02' },
  });
});

// --- Cola 70, item 3: ultima tentativa recusada ---

const OUTRO = 'b'.repeat(64);

test('cola 70, item 3: a ultima tentativa recusada sai com nome e hora, sem o hash', async () => {
  await comAdmin(async ({ ler }) => {
    const { corpo } = await ler('loja-1');
    assert.deepEqual(corpo.data.tentativaRecusada, { nome: 'DELIVERY-PC', em: '2026-11-20T10:56:00.000Z' });
    assert.ok(!JSON.stringify(corpo).includes(OUTRO));
  }, {
    [REGISTRO]: {
      maquina: HASH, registradoEm: new Date('2026-11-20T11:13:00Z'), trocaLiberadaEm: null,
      tentativaRecusada: { maquina: OUTRO, nome: 'DELIVERY-PC', em: new Date('2026-11-20T10:56:00Z') },
    },
  });
});

test('cola 70, item 3: tentativa sem nome (chamada recusada sem o nome) sai com nome null; sem tentativa, null', async () => {
  await comAdmin(async ({ ler }) => {
    assert.deepEqual((await ler('loja-1')).corpo.data.tentativaRecusada, { nome: null, em: '2026-11-20T10:56:00.000Z' });
  }, {
    [REGISTRO]: {
      maquina: HASH, registradoEm: new Date('2026-11-20T11:13:00Z'), trocaLiberadaEm: null,
      tentativaRecusada: { maquina: OUTRO, nome: null, em: new Date('2026-11-20T10:56:00Z') },
    },
  });
  await comAdmin(async ({ ler }) => {
    assert.equal((await ler('loja-1')).corpo.data.tentativaRecusada, null);
  }, { [REGISTRO]: { maquina: HASH, registradoEm: new Date('2026-11-20T11:13:00Z'), trocaLiberadaEm: null } });
});

test('cola 70, item 3: trocar o computador apaga a tentativa recusada e mantem o resto do registro', async () => {
  await comAdmin(async ({ banco }) => {
    const repositorio = new FirestoreIntegradorDaLojaRepository({ firestore: banco, serverTimestamp: () => AGORA });
    await new IntegradorDaLoja({ repositorio }).trocarComputador({ establishmentId: 'loja-1', adminUid: 'uid-admin' });
    const registro = banco.dados(REGISTRO);
    assert.equal(registro.tentativaRecusada, undefined);
    assert.equal(registro.maquina, HASH);
    assert.equal(registro.trocaLiberadaPor, 'uid-admin');
  }, {
    [REGISTRO]: {
      maquina: HASH, registradoEm: new Date('2026-11-20T11:13:00Z'), trocaLiberadaEm: null,
      tentativaRecusada: { maquina: OUTRO, nome: 'DELIVERY-PC', em: new Date('2026-11-20T10:56:00Z') },
    },
  });
});
