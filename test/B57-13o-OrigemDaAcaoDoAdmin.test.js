import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { ImportProductsFromCsvUseCase } from '../src/application/implantacao/ImportProductsFromCsvUseCase.js';
import { ehDoAdmin } from '../src/domain/logs/acaoDoAdmin.js';
import { contaDoAdminNaLoja } from '../src/http/middlewares/lojaAlvoDoAdmin.js';
import { createImplantacaoRoutes } from '../src/http/routes/implantacaoRoutes.js';
import { FirestoreEstablishmentAccessRepository } from '../src/infra/firebase/FirestoreEstablishmentAccessRepository.js';
import { FirestoreManagerDataGateway } from '../src/infra/firebase/FirestoreManagerDataGateway.js';
import { ManagerDataAccessPolicy } from '../src/infra/firebase/ManagerDataAccessPolicy.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Cola do Thay B57-13o, item 35: o criterio e a ORIGEM da acao, nao a conta. Acao feita pelas telas do
// Admin (cabecalho X-Loja-Alvo) fica escondida da loja; acao feita pelo Gerenciador Web da loja ou pelo
// App Gerenciador aparece, mesmo que a conta tambem seja Admin. Importacao por planilha: escondida so
// quando feita pela tela do Admin. Registro antigo sem marca de origem: a regra por conta (b79d25c).
const ACOES = 'estabelecimentos/loja-1/AcoesEquipe';
const ADMIN = new Set(['joao@loja.test', 'f-joao', 'admin@plataforma.test']);

test('B57-13o item 35: a marca de origem decide; sem marca, so o registro antigo do painel cai na regra por conta', () => {
  // Painel da loja, conta que tambem e Admin: aparece.
  assert.equal(ehDoAdmin({ quem: 'joao@loja.test', origem: 'manual', autor: { tipo: 'funcionario', nome: 'João' } }, ADMIN), false);
  assert.equal(ehDoAdmin({ quem: 'joao@loja.test', origem: 'manual', autor: { tipo: 'contaDaLoja' } }, ADMIN), false);
  // Tela do Admin: some.
  assert.equal(ehDoAdmin({ quem: 'admin@plataforma.test', origem: 'manual', autor: { tipo: 'adminDaPlataforma' } }, ADMIN), true);
  // App Gerenciador, conta que tambem e Admin: aparece (com ou sem autor).
  assert.equal(ehDoAdmin({ quem: 'joao@loja.test', origem: 'app' }, ADMIN), false);
  // Registro antigo do painel, sem marca de origem: a regra por conta.
  assert.equal(ehDoAdmin({ quem: 'admin@plataforma.test', origem: 'manual' }, ADMIN), true);
  assert.equal(ehDoAdmin({ quem: 'bia@loja.test', origem: 'manual' }, ADMIN), false);
});

function montar() {
  const firestore = new FirestoreEmMemoria({
    'Users/doc-dono': { id: 'loja-1', userAuthId: 'uid-dono', email: 'conta@loja.test', name: 'Zero Grau' },
    // João e funcionario da loja e tambem Admin da plataforma.
    'usersAdmin/f-joao': { email: 'joao@loja.test', isAdmin: true },
    'estabelecimentos/loja-1/AdminUsers/f-joao': { firstName: 'João', email: 'joao@loja.test', active: true },
    'estabelecimentos/loja-1/PermissionGroups/g-adm': { name: 'Administrador', isAdmin: true, permissions: [] },
  });
  firestore.docs.set('estabelecimentos/loja-1', { name: 'Zero Grau', userReference: firestore.doc('Users/doc-dono') });
  return {
    firestore,
    gateway: new FirestoreManagerDataGateway({ firestore, policy: new ManagerDataAccessPolicy({ firestore }) }),
    acesso: new FirestoreEstablishmentAccessRepository({ firestore }),
  };
}

const consulta = { kind: 'query', source: { kind: 'collection', path: ACOES }, constraints: [{ kind: 'orderBy', field: 'em', direction: 'desc' }] };
const acao = (id) => ({ operation: 'set', target: { path: `${ACOES}/${id}` }, data: { em: new Date(), quem: 'joao@loja.test', acao: 'produto.editar', origem: 'manual' } });

test('B57-13o item 35: acao de conta Admin pelo painel da loja aparece; pela tela do Admin some', async () => {
  const { gateway, acesso } = montar();
  const joao = await acesso.findAccountByClaims({ uid: 'f-joao', adminOf: 'loja-1', groupId: 'g-adm' });
  await gateway.mutate({ actor: joao, request: acao('pelo-painel') });
  await gateway.mutate({ actor: contaDoAdminNaLoja('f-joao', 'loja-1'), request: acao('pela-tela-do-admin') });
  const dono = await acesso.findAccountByClaims({ uid: 'uid-dono' });
  const vistas = (await gateway.getDocuments({ actor: dono, target: consulta })).docs.map((documento) => documento.id);
  assert.deepEqual(vistas, ['pelo-painel']);
});

const CSV = ['Nome;Preço;EAN', 'Coca 2L;9,90;789001'].join('\n');

async function importar(lojaAlvo) {
  const { firestore, gateway, acesso } = montar();
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.auth = { uid: 'f-joao', email: 'joao@loja.test', adminOf: 'loja-1', groupId: 'g-adm' };
    if (lojaAlvo) request.lojaAlvo = 'loja-1';
    next();
  });
  const accountForRequest = async (request) => (request.lojaAlvo
    ? { ...contaDoAdminNaLoja(request.auth.uid, request.lojaAlvo) }
    : acesso.findAccountByClaims({ uid: request.auth.uid, adminOf: request.auth.adminOf, groupId: request.auth.groupId }));
  app.use('/api/implantacao', createImplantacaoRoutes({
    importProductsFromCsvUseCase: new ImportProductsFromCsvUseCase({ firestore }),
    requirePermission: () => (_request, _response, next) => next(),
    implantationAdminMiddleware: (_request, _response, next) => next(),
    accountForRequest,
  }));
  const ouvindo = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const resposta = await fetch(`http://127.0.0.1:${ouvindo.address().port}/api/implantacao/importar-produtos`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ establishmentId: 'loja-1', csvText: CSV }),
    });
    await resposta.text();
  } finally {
    ouvindo.close();
  }
  const dono = await acesso.findAccountByClaims({ uid: 'uid-dono' });
  const linhas = [...firestore.docs.entries()].filter(([caminho]) => caminho.startsWith(`${ACOES}/`)).map(([, dados]) => dados);
  const vistas = (await gateway.getDocuments({ actor: dono, target: consulta })).docs;
  return { linhas, vistas };
}

test('B57-13o item 35: planilha importada pela tela do Admin some da loja; pela loja aparece', async () => {
  const peloAdmin = await importar(true);
  assert.ok(peloAdmin.linhas.length > 0);
  assert.ok(peloAdmin.linhas.every((linha) => linha.autor?.tipo === 'adminDaPlataforma'));
  assert.equal(peloAdmin.vistas.length, 0);

  const pelaLoja = await importar(false);
  assert.ok(pelaLoja.linhas.length > 0);
  assert.ok(pelaLoja.linhas.every((linha) => linha.autor?.tipo === 'funcionario' && linha.autor.nome === 'João'));
  assert.equal(pelaLoja.vistas.length, pelaLoja.linhas.length);
});
