import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import express from 'express';
import { LojaNoAdmin } from '../src/application/admin/LojaNoAdmin.js';
import { createAdminRoutes } from '../src/http/routes/adminRoutes.js';
import { errorHandler } from '../src/http/middlewares/errorHandler.js';
import { FirestoreEstablishmentAccessRepository } from '../src/infra/firebase/FirestoreEstablishmentAccessRepository.js';
import { AuthEmMemoria } from './apoio/authEmMemoria.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Cola 05 do Thay (21/11), item 2.1: o resumo da loja aberta no Admin traz o nome do dono, lido de
// Users/{id}.name da conta dona (userReference). So leitura. Dados de mentira, dominio de teste.

function montar({ users = {}, loja = {} } = {}) {
  const banco = new FirestoreEmMemoria(users);
  banco.docs.set('estabelecimentos/loja-1', { name: 'Loja Um', status: 'aprovada', ...(typeof loja === 'function' ? loja(banco) : loja) });
  const admin = new LojaNoAdmin({
    firestore: banco,
    auth: new AuthEmMemoria([{ uid: 'uid-dono', email: 'dono@exemplo.test' }]),
    accessRepository: new FirestoreEstablishmentAccessRepository({ firestore: banco }),
    serverTimestamp: () => new Date('2026-11-21T12:00:00Z'),
  });
  return { banco, admin };
}

const DONO = { id: 'loja-1', userAuthId: 'uid-dono', userType: 'UserType.empresa' };
const apontaPara = (caminho) => (banco) => ({ userReference: banco.doc(caminho) });

async function resumoPelaRota(contexto) {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', createAdminRoutes({ lojaNoAdmin: contexto.admin }));
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const resposta = await fetch(`http://127.0.0.1:${servidor.address().port}/api/admin/estabelecimentos/loja-1/resumo`);
    return { status: resposta.status, corpo: await resposta.json() };
  } finally {
    servidor.closeAllConnections();
    servidor.close();
  }
}

test('2.1: GET /resumo traz o nome gravado em Users/{id}.name do dono, sem gravar nada', async () => {
  const contexto = montar({ users: { 'Users/doc-dono': { ...DONO, name: '  Maria Souza ' } }, loja: apontaPara('Users/doc-dono') });
  const { status, corpo } = await resumoPelaRota(contexto);
  assert.equal(status, 200);
  assert.equal(corpo.data.nomeDoDono, 'Maria Souza');
  assert.equal(corpo.data.id, 'loja-1');
  assert.equal(corpo.data.nome, 'Loja Um');
  assert.deepEqual(contexto.banco.escritas, [], 'nada gravado no banco');
});

test('2.1: sem nome gravado, nome vazio ou sem dono, nomeDoDono e null', async () => {
  const casos = [
    montar({ users: { 'Users/doc-dono': DONO }, loja: apontaPara('Users/doc-dono') }),
    montar({ users: { 'Users/doc-dono': { ...DONO, name: '   ' } }, loja: apontaPara('Users/doc-dono') }),
    montar({ users: { 'Users/doc-dono': { ...DONO, name: 42 } }, loja: apontaPara('Users/doc-dono') }),
    // Loja sem userReference: sem dono, mesmo com um Users da loja com nome.
    montar({ users: { 'Users/doc-dono': { ...DONO, name: 'Maria Souza' } } }),
    // userReference para Users que nao existe.
    montar({ loja: apontaPara('Users/nao-existe') }),
  ];
  for (const contexto of casos) {
    const { status, corpo } = await resumoPelaRota(contexto);
    assert.equal(status, 200);
    assert.ok('nomeDoDono' in corpo.data);
    assert.equal(corpo.data.nomeDoDono, null);
  }
});

test('2.1: so leitura, nenhuma rota nova de gravacao do nome', () => {
  const rotas = fs.readFileSync(new URL('../src/http/routes/adminRoutes.js', import.meta.url), 'utf8');
  assert.ok(rotas.includes('lojaNoAdmin.resumoComDono(request.params.lojaId)'));
  assert.equal(rotas.includes('dono/nome'), false);
  assert.equal(rotas.includes('nomeDoDono'), false);
  const caso = fs.readFileSync(new URL('../src/application/admin/LojaNoAdmin.js', import.meta.url), 'utf8');
  const metodo = caso.slice(caso.indexOf('async resumoComDono'), caso.indexOf('async resumoComDono') + 600);
  assert.equal(/\.(set|update|create|delete)\(/.test(metodo), false);
});
