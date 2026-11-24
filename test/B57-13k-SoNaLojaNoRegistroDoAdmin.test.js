import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { AppDoClienteDaLoja } from '../src/application/loja/AppDoClienteDaLoja.js';
import { createAdminAuditMiddleware } from '../src/http/middlewares/adminAudit.js';
import { createAdminRoutes } from '../src/http/routes/adminRoutes.js';
import { errorHandler } from '../src/http/middlewares/errorHandler.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Cola do Thay B57-13k, item 34 (b): "So na {loja}" (Admin > Aparencias > Home) entra no registro
// proprio do Admin (adminAuditLogs) como "Salvou só na {loja}", com o nome do bloco. A gravacao e a
// mesma do "Publicar no app"; sem o parametro, o registro fica como antes (app_do_cliente).
async function servidor() {
  const banco = new FirestoreEmMemoria({ 'estabelecimentos/loja-1': { name: 'Zero Grau', aparenciaHome: { topo: 2, meio: 2, fim: 2 } } });
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = { uid: 'admin-1', email: 'admin@plataforma.test' }; next(); });
  app.use('/api/admin', createAdminAuditMiddleware({ firestore: banco, serverTimestamp: () => new Date('2026-11-24T12:00:00Z') }),
    createAdminRoutes({ appDoClienteDaLoja: new AppDoClienteDaLoja({ firestore: banco, serverTimestamp: () => new Date('2026-11-24T12:00:00Z') }) }));
  app.use(errorHandler);
  const ouvindo = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const chamar = (caminho, corpo) => fetch(`http://127.0.0.1:${ouvindo.address().port}/api/admin${caminho}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo),
  });
  const registros = () => [...banco.docs.entries()].filter(([caminho]) => caminho.startsWith('adminAuditLogs/')).map(([, dados]) => dados);
  return { banco, ouvindo, chamar, registros };
}

const espera = () => new Promise((resolve) => { setTimeout(resolve, 30); });

test('B57-13k item 34 b: "Só na Zero Grau" entra no registro do Admin com o nome do bloco', async () => {
  const { banco, ouvindo, chamar, registros } = await servidor();
  try {
    const resposta = await chamar('/estabelecimentos/loja-1/app-do-cliente?soNaLoja=meio', { aparenciaHome: { meio: 3, meioModelo: null } });
    assert.equal(resposta.status, 200);
    assert.equal(banco.docs.get('estabelecimentos/loja-1').aparenciaHome.meio, 3, 'grava como o Publicar no app');
    await espera();
    const [registro] = registros();
    assert.equal(registro.acao, 'so_na_loja');
    assert.equal(registro.descricao, 'Salvou só na Zero Grau');
    assert.equal(registro.bloco, 'Meio');
    assert.deepEqual(registro.lojas, ['loja-1']);
  } finally {
    ouvindo.close();
  }
});

test('B57-13k item 34 b: o "Publicar no app" continua com o registro de antes; bloco desconhecido nao vira "So na"', async () => {
  const { ouvindo, chamar, registros } = await servidor();
  try {
    assert.equal((await chamar('/estabelecimentos/loja-1/app-do-cliente', { aparenciaHome: { fim: 3 } })).status, 200);
    assert.equal((await chamar('/estabelecimentos/loja-1/app-do-cliente?soNaLoja=rodape', { aparenciaHome: { topo: 3 } })).status, 200);
    await espera();
    assert.deepEqual(registros().map((registro) => registro.acao), ['app_do_cliente', 'app_do_cliente']);
  } finally {
    ouvindo.close();
  }
});
