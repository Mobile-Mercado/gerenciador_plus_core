import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { LojaNoAdmin } from '../src/application/admin/LojaNoAdmin.js';
import { createAdminRoutes } from '../src/http/routes/adminRoutes.js';
import { createAdminAuditMiddleware } from '../src/http/middlewares/adminAudit.js';
import { errorHandler } from '../src/http/middlewares/errorHandler.js';
import { FirestoreEstablishmentAccessRepository } from '../src/infra/firebase/FirestoreEstablishmentAccessRepository.js';
import { AuthEmMemoria } from './apoio/authEmMemoria.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Cola RP-67, parte B: "Corrigir acesso" do Admin com conta do dono apagada (B.1), userReference
// errado ou ausente (B.2), dono sem adminOf (B.3) e o caso que ja funcionava (B.4). E-mails de
// mentira, do dominio de teste.
const HORA = () => new Date('2026-10-29T12:00:00Z');
const EMAIL_NOVO = 'dono.novo@exemplo.test';

function montar(documentos = {}, contas = [], loja = {}) {
  const banco = new FirestoreEmMemoria(documentos);
  banco.docs.set('estabelecimentos/loja-1', {
    name: 'Loja Um', status: 'aprovada', ...(typeof loja === 'function' ? loja(banco) : loja),
  });
  const auth = new AuthEmMemoria(contas);
  const admin = new LojaNoAdmin({
    firestore: banco, auth, accessRepository: new FirestoreEstablishmentAccessRepository({ firestore: banco }), serverTimestamp: HORA,
  });
  return { banco, auth, admin };
}

const referenciaPara = (caminho) => (banco) => ({ userReference: banco.doc(caminho) });
const caminhoDaReferencia = (banco) => banco.dados('estabelecimentos/loja-1').userReference?.path || null;

// ===== B.1: conta do dono apagada no Auth =====

function lojaComDonoApagado(extras = {}, contas = []) {
  return montar({
    'Users/doc-antigo': { id: 'loja-1', userAuthId: 'uid-antigo', userType: 'UserType.empresa', email: 'antigo@exemplo.test' },
    'Users/uid-novo': { id: 'uid-novo', userAuthId: 'uid-novo', userType: 'UserType.empresa' },
    ...extras,
  }, [{ uid: 'uid-novo', email: EMAIL_NOVO, customClaims: { outra: 1 } }, ...contas], referenciaPara('Users/doc-antigo'));
}

test('B.1: conta do dono apagada pede o e-mail; Corrigir acesso nao da mais erro 500', async () => {
  const { admin } = lojaComDonoApagado();
  const [dono] = await admin.contas('loja-1');
  assert.equal(dono.papel, 'dono');
  assert.equal(dono.motivo, 'A conta não existe mais no login.');
  assert.deepEqual(await admin.situacaoDoDono('loja-1'), {
    lojaId: 'loja-1', userReference: 'certo', contaApagada: true, candidatoUid: null, pedeEmail: true,
  });
  await assert.rejects(admin.previaDoAcesso('loja-1', 'uid-antigo'), (erro) => erro.code === 'conta_do_dono_apagada' && erro.statusCode === 409);
});

test('B.1: previa mostra dono antigo -> conta nova, userReference e adminOf, sem gravar nada', async () => {
  const { banco, auth, admin } = lojaComDonoApagado();
  const previa = await admin.previaDoDono('loja-1', { email: ` ${EMAIL_NOVO} ` });
  assert.equal(previa.tipo, 'contaNova');
  assert.deepEqual(previa.diferencas, [
    { campo: 'dono', antes: { uid: 'uid-antigo', email: 'antigo@exemplo.test' }, depois: { uid: 'uid-novo', email: EMAIL_NOVO } },
    { campo: 'userReference', antes: 'Users/doc-antigo', depois: 'Users/uid-novo' },
    { campo: 'adminOf', antes: null, depois: 'loja-1' },
  ]);
  assert.deepEqual(previa.claimsNovas, { outra: 1, adminOf: 'loja-1' });
  assert.equal(caminhoDaReferencia(banco), 'Users/doc-antigo');
  assert.deepEqual((await auth.getUser('uid-novo')).customClaims, { outra: 1 });
});

test('B.1: Salvar liga a conta nova (userReference e adminOf, outras claims ficam) e nao apaga nada do dono antigo', async () => {
  const { banco, auth, admin } = lojaComDonoApagado();
  const antes = banco.dados('Users/doc-antigo');
  const feito = await admin.ligarDono('loja-1', { email: EMAIL_NOVO });
  assert.equal(caminhoDaReferencia(banco), 'Users/uid-novo');
  assert.deepEqual((await auth.getUser('uid-novo')).customClaims, { outra: 1, adminOf: 'loja-1' });
  assert.deepEqual(banco.dados('Users/doc-antigo'), antes, 'Users do dono antigo fica');
  assert.equal(feito.entraDepois, true);
  const [dono] = await admin.contas('loja-1');
  assert.deepEqual([dono.uid, dono.papel, dono.entra], ['uid-novo', 'dono', true]);
  assert.deepEqual((await admin.situacaoDoDono('loja-1')).pedeEmail, false);
});

test('B.1: sem conta com o e-mail: "Nenhuma conta com este e-mail." e nada muda', async () => {
  const { banco, admin } = lojaComDonoApagado();
  for (const email of ['ninguem@exemplo.test', 'nao-e-email']) {
    await assert.rejects(admin.ligarDono('loja-1', { email }), (erro) => erro.message === 'Nenhuma conta com este e-mail.' && erro.statusCode === 404);
  }
  assert.equal(caminhoDaReferencia(banco), 'Users/doc-antigo');
});

test('B.1: conta no Auth sem Users e recusada com o texto que ja existe; conta dona de outra loja tambem', async () => {
  const semUsers = lojaComDonoApagado({}, [{ uid: 'uid-sem-users', email: 'sem.users@exemplo.test' }]);
  await assert.rejects(
    semUsers.admin.ligarDono('loja-1', { email: 'sem.users@exemplo.test' }),
    (erro) => erro.code === 'conta_sem_users' && erro.message === 'A conta não tem documento em Users nem acesso de funcionário.',
  );
  assert.equal(caminhoDaReferencia(semUsers.banco), 'Users/doc-antigo');
  assert.deepEqual((await semUsers.auth.getUser('uid-sem-users')).customClaims, {});

  const outra = lojaComDonoApagado(
    { 'Users/doc-b': { id: 'loja-b', userAuthId: 'uid-b', userType: 'UserType.empresa' } },
    [{ uid: 'uid-b', email: 'dono.b@exemplo.test', customClaims: { adminOf: 'loja-b' } }],
  );
  outra.banco.docs.set('estabelecimentos/loja-b', { name: 'Loja B', userReference: outra.banco.doc('Users/doc-b') });
  await assert.rejects(outra.admin.ligarDono('loja-1', { email: 'dono.b@exemplo.test' }), (erro) => erro.code === 'conta_dona_de_outra_loja');
  assert.deepEqual((await outra.auth.getUser('uid-b')).customClaims, { adminOf: 'loja-b' });
});

test('B.1: falha ao gravar o userReference devolve a claim antiga', async () => {
  const { banco, auth, admin } = lojaComDonoApagado();
  const original = banco.doc('estabelecimentos/loja-1').constructor.prototype.update;
  banco.doc('estabelecimentos/loja-1').constructor.prototype.update = async () => { throw new Error('falhou'); };
  try {
    await assert.rejects(admin.ligarDono('loja-1', { email: EMAIL_NOVO }), /falhou/);
  } finally {
    banco.doc('estabelecimentos/loja-1').constructor.prototype.update = original;
  }
  assert.deepEqual((await auth.getUser('uid-novo')).customClaims, { outra: 1 });
  assert.equal(caminhoDaReferencia(banco), 'Users/doc-antigo');
});

// ===== B.2: userReference ausente, para Users inexistente ou para Users de outra loja =====

const USERS_DO_DONO = {
  'Users/doc-dono': { id: 'loja-1', userAuthId: 'uid-dono', userType: 'UserType.empresa' },
  'Users/doc-cliente': { id: 'loja-1', userAuthId: 'uid-cliente', userType: 'UserType.cliente' },
};
const DONO = { uid: 'uid-dono', email: 'dono@exemplo.test', customClaims: { adminOf: 'loja-1' } };

for (const [caso, loja, extras, antes] of [
  ['ausente', {}, {}, null],
  ['inexistente', referenciaPara('Users/nao-existe'), {}, 'Users/nao-existe'],
  ['outra_loja', referenciaPara('Users/doc-b'), { 'Users/doc-b': { id: 'loja-b', userAuthId: 'uid-b', userType: 'UserType.empresa' } }, 'Users/doc-b'],
]) {
  test(`B.2: userReference ${caso}: previa e Salvar gravam o userReference para o Users do dono, sem mexer em claim`, async () => {
    const { banco, auth, admin } = montar({ ...USERS_DO_DONO, ...extras }, [DONO, { uid: 'uid-b', email: 'b@exemplo.test', customClaims: { adminOf: 'loja-b' } }], loja);
    if (caso === 'outra_loja') banco.docs.set('estabelecimentos/loja-b', { name: 'Loja B', userReference: banco.doc('Users/doc-b') });
    const contas = await admin.contas('loja-1');
    assert.equal(contas.some((conta) => conta.papel === 'dono'), false, 'sem userReference certo nao ha dono');
    assert.deepEqual(await admin.situacaoDoDono('loja-1'), {
      lojaId: 'loja-1', userReference: caso, contaApagada: false, candidatoUid: 'uid-dono', pedeEmail: false,
    });
    if (caso === 'outra_loja') {
      await assert.rejects(admin.previaDoAcesso('loja-1', 'uid-b'), (erro) => erro.code === 'acesso_so_do_dono');
    }
    const previa = await admin.previaDoDono('loja-1', {});
    assert.equal(previa.tipo, 'userReference');
    assert.deepEqual(previa.diferencas.find(({ campo }) => campo === 'userReference'), { campo: 'userReference', antes, depois: 'Users/doc-dono' });
    assert.deepEqual(previa.diferencas.find(({ campo }) => campo === 'dono').depois, { uid: 'uid-dono', email: 'dono@exemplo.test' });
    assert.equal(previa.claimsNovas, undefined);
    assert.equal(caminhoDaReferencia(banco), antes);

    const feito = await admin.ligarDono('loja-1', {});
    assert.equal(caminhoDaReferencia(banco), 'Users/doc-dono');
    assert.equal(feito.entraDepois, true);
    assert.deepEqual((await auth.getUser('uid-b')).customClaims, { adminOf: 'loja-b' }, 'dono da outra loja fica como estava');
    if (caso === 'outra_loja') assert.ok(banco.dados('Users/doc-b'), 'Users da outra loja fica');
    const [dono] = await admin.contas('loja-1');
    assert.deepEqual([dono.uid, dono.papel, dono.entra], ['uid-dono', 'dono', true]);
    assert.equal((await admin.previaDoDono('loja-1', {})).diferencas.length, 0);
  });
}

test('B.2: nenhum ou mais de um Users do dono cai no B.1 (pede o e-mail)', async () => {
  const nenhum = montar({ 'Users/doc-cliente': USERS_DO_DONO['Users/doc-cliente'] }, [], {});
  assert.deepEqual(await nenhum.admin.situacaoDoDono('loja-1'), {
    lojaId: 'loja-1', userReference: 'ausente', contaApagada: false, candidatoUid: null, pedeEmail: true,
  });
  await assert.rejects(nenhum.admin.ligarDono('loja-1', {}), (erro) => erro.code === 'dono_sem_users_da_loja');

  const dois = montar({
    ...USERS_DO_DONO, 'Users/doc-dono-2': { id: 'loja-1', userAuthId: 'uid-dono-2', userType: 'UserType.empresa' },
  }, [DONO], referenciaPara('Users/nao-existe'));
  assert.equal((await dois.admin.situacaoDoDono('loja-1')).pedeEmail, true);
  await assert.rejects(dois.admin.ligarDono('loja-1', {}), (erro) => erro.code === 'dono_sem_users_da_loja');
  assert.equal(caminhoDaReferencia(dois.banco), 'Users/nao-existe');

  // E a conta nova por e-mail resolve (B.1).
  await dois.auth.createUser({ email: EMAIL_NOVO });
  dois.banco.docs.set('Users/uid-novo-1', { id: 'uid-novo-1', userAuthId: 'uid-novo-1', userType: 'UserType.empresa' });
  const feito = await dois.admin.ligarDono('loja-1', { email: EMAIL_NOVO });
  assert.deepEqual(feito.diferencas.find(({ campo }) => campo === 'userReference'), { campo: 'userReference', antes: 'Users/nao-existe', depois: 'Users/uid-novo-1' });
  assert.equal(caminhoDaReferencia(dois.banco), 'Users/uid-novo-1');
  assert.equal(feito.entraDepois, true);
  assert.ok(dois.banco.dados('Users/doc-dono') && dois.banco.dados('Users/doc-dono-2'), 'nada do dono antigo sai');
});

// ===== B.3 e o caso que ja funcionava =====

test('B.3: dono sem adminOf entra, e o Corrigir acesso grava adminOf mantendo as outras claims', async () => {
  const { auth, admin } = montar(
    { 'Users/doc-dono': USERS_DO_DONO['Users/doc-dono'] },
    [{ uid: 'uid-dono', email: 'dono@exemplo.test', customClaims: { outra: 1 } }],
    referenciaPara('Users/doc-dono'),
  );
  const [dono] = await admin.contas('loja-1');
  assert.deepEqual([dono.papel, dono.entra, dono.claims.adminOf], ['dono', true, undefined]);
  assert.equal((await admin.situacaoDoDono('loja-1')).pedeEmail, false);
  const previa = await admin.previaDoAcesso('loja-1', 'uid-dono');
  assert.deepEqual(previa.claimsNovas, { outra: 1, adminOf: 'loja-1' });
  await admin.corrigirAcesso('loja-1', 'uid-dono');
  assert.deepEqual((await auth.getUser('uid-dono')).customClaims, { outra: 1, adminOf: 'loja-1' });
});

test('B.4: o que ja funcionava: adminOf de outra loja com AdminUsers em B e funcionario desativado', async () => {
  const { banco, auth, admin } = montar({
    'Users/doc-dono': USERS_DO_DONO['Users/doc-dono'],
    'estabelecimentos/loja-b/AdminUsers/uid-dono': { active: true, groupId: 'gb' },
    'estabelecimentos/loja-b/PermissionGroups/gb': { isAdmin: true },
    'estabelecimentos/loja-1/AdminUsers/uid-func': { active: false, groupId: 'g1' },
  }, [
    { uid: 'uid-dono', email: 'dono@exemplo.test', customClaims: { adminOf: 'loja-b', groupId: 'gb' } },
    { uid: 'uid-func', email: 'func@exemplo.test', customClaims: { adminOf: 'loja-1', groupId: 'g1' } },
  ], referenciaPara('Users/doc-dono'));
  banco.docs.set('estabelecimentos/loja-b', { name: 'Loja B' });
  const contas = await admin.contas('loja-1');
  assert.deepEqual(contas.map((conta) => [conta.uid, conta.papel, conta.entra]), [['uid-dono', 'dono', false], ['uid-func', 'funcionario', false]]);
  assert.match(contas[0].motivo, /adminOf aponta para a loja loja-b/);
  assert.equal(contas[1].motivo, 'O funcionário está desativado nesta loja.');
  const feito = await admin.corrigirAcesso('loja-1', 'uid-dono');
  assert.deepEqual(feito.claimsNovas, { adminOf: 'loja-1' });
  assert.equal(feito.entraDepois, true);
  assert.deepEqual((await auth.getUser('uid-func')).customClaims, { adminOf: 'loja-1', groupId: 'g1' });
  await assert.rejects(admin.previaDoAcesso('loja-1', 'uid-func'), (erro) => erro.code === 'acesso_so_do_dono');
});

// ===== Rotas e registro do Admin =====

async function comRotas(contexto, usar) {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.auth = { uid: 'uid-admin', email: 'admin@exemplo.test', token: 'tk-segredo' };
    next();
  });
  app.use(
    '/api/admin',
    createAdminAuditMiddleware({ firestore: contexto.banco, serverTimestamp: HORA }),
    createAdminRoutes({ lojaNoAdmin: contexto.admin }),
  );
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const chamar = async (metodo, caminho, corpo) => {
    const resposta = await fetch(`http://127.0.0.1:${servidor.address().port}/api/admin/estabelecimentos/loja-1${caminho}`, {
      method: metodo, headers: { 'Content-Type': 'application/json' }, body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    return { status: resposta.status, corpo: await resposta.json() };
  };
  try {
    await usar(chamar);
  } finally {
    servidor.closeAllConnections();
    servidor.close();
  }
}

const esperarAuditoria = () => new Promise((resolve) => { setTimeout(resolve, 20); });

test('B.4 rotas: situacao, previa e Salvar do dono; registro do Admin sem e-mail nem token', async () => {
  const contexto = lojaComDonoApagado();
  await comRotas(contexto, async (chamar) => {
    const situacao = await chamar('GET', '/dono');
    assert.equal(situacao.corpo.data.pedeEmail, true);
    const errado = await chamar('POST', '/dono/previa', { email: 'ninguem@exemplo.test' });
    assert.deepEqual([errado.status, errado.corpo.error.message], [404, 'Nenhuma conta com este e-mail.']);
    const extra = await chamar('POST', '/dono', { email: EMAIL_NOVO, outro: 1 });
    assert.equal(extra.status, 400);
    const previa = await chamar('POST', '/dono/previa', { email: EMAIL_NOVO });
    assert.equal(previa.status, 200);
    assert.equal(previa.corpo.data.diferencas.length, 3);
    const salvo = await chamar('POST', '/dono', { email: EMAIL_NOVO });
    assert.equal(salvo.status, 200);
    assert.equal(salvo.corpo.data.entraDepois, true);
    const apagado = await chamar('POST', '/contas/uid-antigo/acesso/previa', {});
    assert.equal(apagado.status, 403, 'a conta antiga deixou de ser a dona');
    const corrigido = await chamar('POST', '/contas/uid-novo/acesso', {});
    assert.equal(corrigido.status, 200);
  });
  await esperarAuditoria();
  const auditorias = [...contexto.banco.docs.entries()].filter(([caminho]) => /adminAuditLogs|AdminAuditLogs/.test(caminho));
  assert.ok(auditorias.length >= 5);
  auditorias.forEach(([, documento]) => {
    const texto = JSON.stringify(documento);
    assert.equal(texto.includes('@'), false, 'sem e-mail no registro');
    assert.equal(texto.includes('tk-segredo'), false, 'sem token no registro');
  });
  const ligar = auditorias.map(([, documento]) => documento).find((documento) => documento.acao === 'ligar_conta_nova_do_dono' && documento.status === 200);
  assert.deepEqual(
    {
      uid: ligar.uid, lojas: ligar.lojas, uidConta: ligar.uidConta, uidAntigo: ligar.uidAntigo,
      userReferenceAntes: ligar.userReferenceAntes, userReferenceDepois: ligar.userReferenceDepois, claimsAntigas: ligar.claimsAntigas, claimsNovas: ligar.claimsNovas,
    },
    {
      uid: 'uid-admin', lojas: ['loja-1'], uidConta: 'uid-novo', uidAntigo: 'uid-antigo',
      userReferenceAntes: 'Users/doc-antigo', userReferenceDepois: 'Users/uid-novo', claimsAntigas: { outra: 1 }, claimsNovas: { outra: 1, adminOf: 'loja-1' },
    },
  );
});
