import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import express from 'express';
import { IntegradorDaLoja } from '../src/application/admin/IntegradorDaLoja.js';
import { FirestoreIntegradorDaLojaRepository } from '../src/infra/firebase/FirestoreIntegradorDaLojaRepository.js';
import { ManagerDataAccessPolicy } from '../src/infra/firebase/ManagerDataAccessPolicy.js';
import { createAdminRoutes } from '../src/http/routes/adminRoutes.js';
import { createAdminAuditMiddleware } from '../src/http/middlewares/adminAudit.js';
import { createPlatformAdminGuard } from '../src/http/middlewares/requirePlatformAdmin.js';
import { errorHandler } from '../src/http/middlewares/errorHandler.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Cola 65, item 4.11 (contrato D:\ferramentas-integrador\contrato-4.11-4.6.md): rota do Admin
// POST /api/admin/lojas/:establishmentId/integrador/trocar-computador, so admin da plataforma, com
// registro em adminAuditLogs, gravando trocaLiberadaEm/trocaLiberadaPor em
// estabelecimentos/{loja}/IntegradorDaLoja/atual. Falham com o codigo de antes: a rota, o caso de uso
// e o repositorio nao existiam, e o BFF lia e gravava IntegradorDaLoja da propria loja.

const AGORA = new Date('2026-11-20T15:00:00Z');
const REGISTRO = 'estabelecimentos/loja-1/IntegradorDaLoja/atual';

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
  const chamar = async (loja, uid) => {
    const resposta = await fetch(`http://127.0.0.1:${servidor.address().port}/api/admin/lojas/${loja}/integrador/trocar-computador`, {
      method: 'POST', headers: { 'x-uid': uid || '' },
    });
    return { status: resposta.status, corpo: await resposta.json() };
  };
  try {
    await usar({ chamar, banco });
  } finally {
    servidor.closeAllConnections();
    servidor.close();
  }
}

const esperarAuditoria = () => new Promise((resolve) => { setTimeout(resolve, 20); });

test('4.11: admin da plataforma libera a troca; maquina e datas do registro ficam', async () => {
  await comAdmin(async ({ chamar, banco }) => {
    const { status, corpo } = await chamar('loja-1', 'uid-admin');
    assert.equal(status, 200);
    assert.deepEqual(corpo.data, { establishmentId: 'loja-1', trocaLiberada: true, computadorRegistrado: true });
    const registro = banco.dados(REGISTRO);
    assert.equal(registro.maquina, 'a'.repeat(64));
    assert.equal(registro.registradoEm.toISOString(), '2026-11-01T10:00:00.000Z');
    assert.equal(registro.trocaLiberadaEm.toISOString(), AGORA.toISOString());
    assert.equal(registro.trocaLiberadaPor, 'uid-admin');
    await esperarAuditoria();
    const auditoria = [...banco.docs.entries()].filter(([caminho]) => caminho.startsWith('adminAuditLogs/')).map(([, dados]) => dados);
    assert.equal(auditoria.length, 1);
    assert.equal(auditoria[0].uid, 'uid-admin');
    assert.equal(auditoria[0].rota, '/api/admin/lojas/loja-1/integrador/trocar-computador');
    assert.equal(auditoria[0].acao, 'integrador_trocar_computador');
    assert.deepEqual(auditoria[0].lojas, ['loja-1']);
    const daLoja = [...banco.docs.keys()].filter((caminho) => caminho.startsWith('estabelecimentos/loja-1/AdminAuditLogs/'));
    assert.equal(daLoja.length, 1);
  }, {
    [REGISTRO]: {
      maquina: 'a'.repeat(64), registradoEm: new Date('2026-11-01T10:00:00Z'), ultimoUsoEm: new Date('2026-11-20T10:00:00Z'), trocaLiberadaEm: null, trocaLiberadaPor: null,
    },
  });
});

test('4.11: sem computador registrado, libera do mesmo jeito e avisa', async () => {
  await comAdmin(async ({ chamar, banco }) => {
    const { status, corpo } = await chamar('loja-1', 'uid-admin');
    assert.equal(status, 200);
    assert.equal(corpo.data.computadorRegistrado, false);
    assert.equal(banco.dados(REGISTRO).trocaLiberadaPor, 'uid-admin');
  });
});

test('4.11: quem nao e admin da plataforma recebe 403 e nada e gravado; loja inexistente, 404', async () => {
  await comAdmin(async ({ chamar, banco }) => {
    const negado = await chamar('loja-1', 'uid-dono');
    assert.equal(negado.status, 403);
    assert.equal(banco.dados(REGISTRO), undefined);
    const inexistente = await chamar('loja-x', 'uid-admin');
    assert.equal(inexistente.status, 404);
    assert.equal(inexistente.corpo.error.code, 'loja_nao_encontrada');
    assert.equal(banco.dados('estabelecimentos/loja-x/IntegradorDaLoja/atual'), undefined);
  });
});

test('4.11: o BFF de dados nunca le nem grava IntegradorDaLoja, nem na loja da propria conta', async () => {
  const policy = new ManagerDataAccessPolicy({ firestore: new FirestoreEmMemoria({}) });
  const actor = { uid: 'uid-dono', establishmentId: 'loja-1', hasEstablishment: true };
  const negado = (erro) => erro.statusCode === 403;
  await assert.rejects(policy.assertRead({ actor, target: { kind: 'document', path: REGISTRO } }), negado);
  await assert.rejects(policy.assertRead({ actor, target: { kind: 'collection', path: 'estabelecimentos/loja-1/IntegradorDaLoja' } }), negado);
  await assert.rejects(policy.assertMutation({
    actor, mutation: { operation: 'set', options: { merge: true }, target: { kind: 'document', path: REGISTRO }, data: { trocaLiberadaEm: null } },
  }), negado);
});

test('4.11: app.js passa o integradorDaLoja ao /api/admin (barreira e auditoria do admin)', () => {
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const bloco = app.slice(app.indexOf("'/api/admin',"), app.indexOf('app.use(notFoundHandler)'));
  assert.match(bloco, /requirePlatformAdmin,\s+adminAuditMiddleware,\s+createAdminRoutes\(\{/);
  assert.ok(bloco.includes('integradorDaLoja,'));
});
