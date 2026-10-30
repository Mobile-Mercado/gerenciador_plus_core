import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createAdminRoutes } from '../src/http/routes/adminRoutes.js';
import { createAdminAuditMiddleware } from '../src/http/middlewares/adminAudit.js';
import { createPlatformAdminGuard } from '../src/http/middlewares/requirePlatformAdmin.js';
import { errorHandler } from '../src/http/middlewares/errorHandler.js';
import {
  CREDENCIAL, LOJA, MERCHANT_ID, MERCHANT_TOKEN, credencialBoa, montar, semValorDeCredencial,
} from './apoio/safraDeMentira.js';

// Cola RP-62, item A.2: contrato K4 (Admin grava e apaga a credencial da Safrapay da loja).
const SAFRA_DESLIGADA = {
  safrapay: { enabled: false },
  paymentGateway: { provider: 'safrapay', safrapay: { enabled: false } },
};
const ADMIN = { uid: 'uid-admin', nome: 'Ana Admin' };

test('K4: GET sem credencial e com credencial, sem nenhum valor', async () => {
  const sem = montar(SAFRA_DESLIGADA);
  assert.deepEqual(await sem.formas.credencialNoAdmin('loja-1'), {
    gateway: 'safrapay', temCredencial: false, ambiente: null, salvoEm: null, salvoPor: null, ligadaNaLoja: false,
  });
  const com = montar(
    { safrapay: { enabled: true }, paymentGateway: { safrapay: { enabled: true } } },
    { [CREDENCIAL]: { ...credencialBoa(), env: 'hml', salvoEm: new Date('2026-10-28T21:00:00Z'), salvoPorNome: 'Ana Admin', salvoPorUid: 'uid-admin' } },
  );
  const corpo = await com.formas.credencialNoAdmin('loja-1');
  assert.deepEqual(corpo, {
    gateway: 'safrapay', temCredencial: true, ambiente: 'hml', salvoEm: '2026-10-28T21:00:00.000Z', salvoPor: 'Ana Admin', ligadaNaLoja: true,
  });
  semValorDeCredencial(corpo);
  await assert.rejects(sem.formas.credencialNoAdmin('nao-existe'), (erro) => erro.code === 'loja_nao_encontrada');
});

test('K4: salvar grava em safrapayMerchants/{loja} os campos que a API le, liga a Safra na loja e devolve o GET', async () => {
  const { banco, formas } = montar(SAFRA_DESLIGADA, {
    [CREDENCIAL]: {
      enabled: false,
      env: 'prod',
      merchantId: 'antigo',
      merchantToken: 'antigo',
      token: 'apelido-antigo',
      environment: 'prod',
      gatewayUrl: 'https://payment.safrapay.com.br',
      portalUrl: 'https://portal-api.safrapay.com.br',
      cardSource: 8,
      antifraudEnabled: true,
    },
  });
  const corpo = await formas.salvarCredencial('loja-1', { ambiente: 'hml', merchantId: MERCHANT_ID, merchantToken: MERCHANT_TOKEN }, ADMIN);
  const gravada = banco.dados(CREDENCIAL);
  assert.equal(gravada.enabled, true);
  assert.equal(gravada.env, 'hml');
  assert.equal(gravada.merchantId, MERCHANT_ID);
  assert.equal(gravada.merchantToken, MERCHANT_TOKEN);
  assert.equal(gravada.salvoPorUid, 'uid-admin');
  assert.equal(gravada.salvoPorNome, 'Ana Admin');
  assert.ok(gravada.salvoEm instanceof Date);
  for (const campo of ['token', 'environment', 'gatewayUrl', 'portalUrl', 'safrapayMerchantId', 'safrapayMerchantToken']) {
    assert.equal(campo in gravada, false, `${campo} sai`);
  }
  assert.equal(gravada.cardSource, 8, 'configuracao que nao e credencial fica');
  assert.equal(gravada.antifraudEnabled, true);
  const loja = banco.dados(LOJA);
  assert.equal(loja.safrapay.enabled, true);
  assert.equal(loja.paymentGateway.safrapay.enabled, true);
  assert.equal(loja.paymentGateway.provider, 'safrapay');
  assert.deepEqual(corpo, {
    gateway: 'safrapay', temCredencial: true, ambiente: 'hml', salvoEm: gravada.salvoEm.toISOString(), salvoPor: 'Ana Admin', ligadaNaLoja: true,
  });
  semValorDeCredencial(corpo);
  // A loja ve a credencial pronta e a Safra ligada (K1).
  assert.deepEqual((await formas.ler('loja-1')).safra, { credencialPronta: true, ligada: true });
});

test('K4: apagar remove safrapayMerchants/{loja} e desliga a Safra na loja', async () => {
  const { banco, formas } = montar(
    { safrapay: { enabled: true, methods: { pix: true } }, paymentGateway: { safrapay: { enabled: true } } },
    { [CREDENCIAL]: credencialBoa() },
  );
  const corpo = await formas.apagarCredencial('loja-1');
  assert.equal(banco.dados(CREDENCIAL), undefined);
  const loja = banco.dados(LOJA);
  assert.equal(loja.safrapay.enabled, false);
  assert.equal(loja.paymentGateway.safrapay.enabled, false);
  assert.deepEqual(corpo, { gateway: 'safrapay', temCredencial: false, ambiente: null, salvoEm: null, salvoPor: null, ligadaNaLoja: false });
  await assert.rejects(formas.ligarSafra('loja-1', true), (erro) => erro.code === 'safra_sem_credencial');
});

async function comAdmin(usar, loja = SAFRA_DESLIGADA, extras = {}) {
  const contexto = montar(loja, extras);
  const { requirePlatformAdmin } = createPlatformAdminGuard({
    platformAdminRepository: { isPlatformAdmin: async (uid) => uid === 'uid-admin' },
  });
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.auth = { uid: request.headers['x-uid'] || undefined, email: 'ana@mobile.test', name: 'Ana Admin', exp: 9999999999 };
    next();
  });
  app.use(
    '/api/admin',
    requirePlatformAdmin,
    createAdminAuditMiddleware({ firestore: contexto.banco, serverTimestamp: () => new Date('2026-10-28T22:00:00Z') }),
    createAdminRoutes({ formasDePagamento: contexto.formas }),
  );
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const chamar = (metodo, uid, corpo) => fetch(`http://127.0.0.1:${servidor.address().port}/api/admin/estabelecimentos/loja-1/safrapay`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', 'x-uid': uid || '' },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  try {
    await usar({ chamar, ...contexto });
  } finally {
    servidor.closeAllConnections();
    servidor.close();
  }
}

const esperarAuditoria = () => new Promise((resolve) => { setTimeout(resolve, 20); });

test('K4 rotas: so o Admin da plataforma; PUT valida o corpo; auditoria e respostas sem valor de credencial', async () => {
  await comAdmin(async ({ chamar, banco }) => {
    const corpoBom = { ambiente: 'prod', merchantId: MERCHANT_ID, merchantToken: MERCHANT_TOKEN };
    assert.equal((await chamar('GET', 'uid-lojista')).status, 403);
    assert.equal((await chamar('PUT', 'uid-lojista', corpoBom)).status, 403);
    assert.equal((await chamar('DELETE', 'uid-lojista')).status, 403);
    assert.equal(banco.dados(CREDENCIAL), undefined);

    const ruins = [
      { ...corpoBom, ambiente: 'producao' },
      { ...corpoBom, merchantId: '' },
      { ...corpoBom, merchantToken: '   ' },
      { ambiente: 'prod', merchantId: MERCHANT_ID },
      { ...corpoBom, enabled: false },
    ];
    for (const ruim of ruins) {
      // eslint-disable-next-line no-await-in-loop
      const resposta = await chamar('PUT', 'uid-admin', ruim);
      assert.equal(resposta.status, 400, JSON.stringify(Object.keys(ruim)));
      // eslint-disable-next-line no-await-in-loop
      semValorDeCredencial(await resposta.json(), { nomes: false });
    }
    assert.equal(banco.dados(CREDENCIAL), undefined);

    const salvo = await chamar('PUT', 'uid-admin', corpoBom);
    assert.equal(salvo.status, 200);
    const { data } = await salvo.json();
    assert.deepEqual(Object.keys(data).sort(), ['ambiente', 'gateway', 'ligadaNaLoja', 'salvoEm', 'salvoPor', 'temCredencial']);
    assert.equal(data.temCredencial, true);
    assert.equal(data.ligadaNaLoja, true);
    assert.equal(data.salvoPor, 'Ana Admin');
    semValorDeCredencial(data);
    assert.equal(banco.dados(CREDENCIAL).merchantToken, MERCHANT_TOKEN);

    const lido = await chamar('GET', 'uid-admin');
    semValorDeCredencial(await lido.json());

    const apagado = await chamar('DELETE', 'uid-admin');
    assert.equal(apagado.status, 200);
    assert.equal((await apagado.json()).data.temCredencial, false);
    assert.equal(banco.dados(CREDENCIAL), undefined);
    assert.equal(banco.dados(LOJA).safrapay.enabled, false);

    await esperarAuditoria();
    const auditorias = [...banco.docs.entries()].filter(([caminho]) => /adminAuditLogs|AdminAuditLogs/.test(caminho));
    assert.ok(auditorias.length >= 4, 'PUT e DELETE com auditoria na raiz e na loja');
    auditorias.forEach(([, documento]) => semValorDeCredencial(documento));
    const acoes = auditorias.map(([, documento]) => documento.acao || documento.details?.acao);
    assert.ok(acoes.includes('credencial_safrapay_salva'));
    assert.ok(acoes.includes('credencial_safrapay_apagada'));
  });
});
