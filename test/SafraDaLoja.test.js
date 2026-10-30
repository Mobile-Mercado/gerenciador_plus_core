import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createSafrapayDaLojaRoutes } from '../src/http/routes/safrapayDaLojaRoutes.js';
import { createPermissionGuard } from '../src/http/middlewares/requirePermission.js';
import { errorHandler } from '../src/http/middlewares/errorHandler.js';
import { CREDENCIAL, LOJA, credencialBoa, montar, semValorDeCredencial } from './apoio/safraDeMentira.js';

// Cola RP-62, item A.3: contrato K3 (PATCH /api/loja/safrapay).
const SAFRA_DESLIGADA = { safrapay: { enabled: false, methods: { pix: false, creditcard: false } }, paymentGateway: { provider: 'safrapay', safrapay: { enabled: false, env: 'prod' } } };

test('K3: sem credencial pronta, 409 safra_sem_credencial e nada gravado', async () => {
  for (const credencial of [null, { ...credencialBoa(), enabled: false }, { ...credencialBoa(), merchantToken: '' }]) {
    const { banco, formas } = montar(SAFRA_DESLIGADA, credencial ? { [CREDENCIAL]: credencial } : {});
    const antes = banco.dados(LOJA);
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(formas.ligarSafra('loja-1', true), (erro) => erro.statusCode === 409
      && erro.code === 'safra_sem_credencial' && erro.message === 'Fale com a Móbile para ligar um gateway.');
    assert.deepEqual(banco.dados(LOJA), antes);
  }
});

test('K3: liga e desliga os dois enabled juntos, na mesma escrita; ao ligar, safrapay.methods sai das formas', async () => {
  const { banco, formas } = montar(SAFRA_DESLIGADA, { [CREDENCIAL]: credencialBoa() });
  const escritasAntes = banco.escritas.length;
  const ligada = await formas.ligarSafra('loja-1', true);
  const novas = banco.escritas.slice(escritasAntes).filter((escrita) => escrita.caminho === LOJA);
  assert.equal(novas.length, 1, 'uma escrita so');
  assert.equal(novas[0].dados['safrapay.enabled'], true);
  assert.equal(novas[0].dados['paymentGateway.safrapay.enabled'], true);
  let loja = banco.dados(LOJA);
  assert.equal(loja.safrapay.enabled, true);
  assert.equal(loja.paymentGateway.safrapay.enabled, true);
  assert.equal(loja.paymentGateway.provider, 'safrapay', 'o resto do mapa fica');
  assert.equal(loja.paymentGateway.safrapay.env, 'prod');
  // Pix ativo sem cobradoEm gravado: com a Safra ligada vale "app" (o que o app faz hoje).
  assert.deepEqual(loja.safrapay.methods, { pix: true, creditcard: false, debitcard: false });
  assert.deepEqual(ligada.safra, { credencialPronta: true, ligada: true });
  semValorDeCredencial(ligada);

  const desligada = await formas.ligarSafra('loja-1', false);
  loja = banco.dados(LOJA);
  assert.equal(loja.safrapay.enabled, false);
  assert.equal(loja.paymentGateway.safrapay.enabled, false);
  assert.deepEqual(loja.safrapay.methods, { pix: true, creditcard: false, debitcard: false }, 'desligar nao mexe em methods');
  assert.deepEqual(desligada.safra, { credencialPronta: true, ligada: false });
});

test('K3: desligar a Safra com so "Pelo app" ligado nao e recusado pela regra 10', async () => {
  const { banco, formas } = montar(
    {
      safrapay: { enabled: true }, paymentGateway: { safrapay: { enabled: true } },
      paymentMethods: [{ id: 'pix', name: 'Pix', isActive: true, order: 1, icon: null }],
    },
    { [CREDENCIAL]: credencialBoa(), [`${LOJA}/paymentMethods/pix`]: { name: 'Pix', isActive: true, cobradoEm: 'app' } },
  );
  const corpo = await formas.ligarSafra('loja-1', false);
  assert.equal(corpo.safra.ligada, false);
  assert.equal(banco.dados(LOJA).safrapay.enabled, false);
});

async function comRota(usar, loja = SAFRA_DESLIGADA, extras = { [CREDENCIAL]: credencialBoa() }) {
  const contexto = montar(loja, extras);
  const contas = {
    'uid-dono': { establishmentId: 'loja-1', permissions: { isAdmin: true, groupId: null, keys: [] } },
    'uid-func': { establishmentId: 'loja-1', permissions: { isAdmin: false, groupId: 'g', keys: ['requests.view'] } },
    'uid-ajustes': { establishmentId: 'loja-1', permissions: { isAdmin: false, groupId: 'g2', keys: ['settings.edit'] } },
  };
  const { requirePermission, accountForRequest } = createPermissionGuard({
    accessRepository: { findAccountByClaims: async ({ uid }) => ({ hasEstablishment: true, establishmentDocument: {}, ...contas[uid] }) },
  });
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = { uid: request.headers['x-uid'] }; next(); });
  app.use('/api/loja/safrapay', createSafrapayDaLojaRoutes({ formasDePagamento: contexto.formas, requirePermission, accountForRequest }));
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const chamar = (uid, corpo) => fetch(`http://127.0.0.1:${servidor.address().port}/api/loja/safrapay`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', 'x-uid': uid }, body: JSON.stringify(corpo),
  });
  try {
    await usar({ chamar, ...contexto });
  } finally {
    servidor.closeAllConnections();
    servidor.close();
  }
}

test('K3 rota: settings.edit, corpo { ligada } booleano, devolve o corpo do K1 sem credencial', async () => {
  await comRota(async ({ chamar, banco }) => {
    assert.equal((await chamar('uid-func', { ligada: true })).status, 403);
    assert.equal((await chamar('uid-dono', { ligada: 'true' })).status, 400);
    assert.equal((await chamar('uid-dono', {})).status, 400);
    assert.equal((await chamar('uid-dono', { ligada: true, merchantId: 'x' })).status, 400);
    assert.equal(banco.dados(LOJA).safrapay.enabled, false);
    const ok = await chamar('uid-ajustes', { ligada: true });
    assert.equal(ok.status, 200);
    const { data } = await ok.json();
    assert.deepEqual(Object.keys(data).sort(), ['entrega', 'formas', 'lojaId', 'mercadoPago', 'retirada', 'safra']);
    assert.deepEqual(data.safra, { credencialPronta: true, ligada: true });
    semValorDeCredencial(data);
  });
  await comRota(async ({ chamar }) => {
    const semCredencial = await chamar('uid-dono', { ligada: true });
    assert.equal(semCredencial.status, 409);
    const { error } = await semCredencial.json();
    assert.equal(error.code, 'safra_sem_credencial');
    assert.equal(error.message, 'Fale com a Móbile para ligar um gateway.');
  }, SAFRA_DESLIGADA, {});
});
