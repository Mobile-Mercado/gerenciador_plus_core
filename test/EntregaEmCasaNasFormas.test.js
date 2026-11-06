import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createFormasDePagamentoRoutes } from '../src/http/routes/formasDePagamentoRoutes.js';
import { createPermissionGuard } from '../src/http/middlewares/requirePermission.js';
import { errorHandler } from '../src/http/middlewares/errorHandler.js';
import { LOJA, montar } from './apoio/safraDeMentira.js';

// Cola RP-62, item B.4 (lado do Core): contrato K2, "Entrega em casa" em featureFlags.entrega.
const MENSAGEM = 'Deixe pelo menos uma forma de seus clientes receberem as compras ligada.';

test('K2 entrega: sem a retirada ligada, desligar a entrega da 409 sem_forma_de_receber e nada muda', async () => {
  for (const featureFlags of [{ promotions: true }, { promotions: true, retirada: false }, { retirada: 'true' }]) {
    const { banco, formas } = montar({ featureFlags });
    const antes = banco.dados(LOJA);
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(formas.salvar('loja-1', {}, { entrega: false }), (erro) => erro.statusCode === 409
      && erro.code === 'sem_forma_de_receber' && erro.message === MENSAGEM);
    // Junto com uma forma, tambem nada e gravado.
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(formas.salvar('loja-1', { dinheiro: { ativa: false } }, { entrega: false }), (erro) => erro.code === 'sem_forma_de_receber');
    assert.deepEqual(banco.dados(LOJA), antes);
  }
});

test('K2 entrega: grava so featureFlags.entrega, pelo caminho pontuado; as outras chaves de featureFlags ficam', async () => {
  const { banco, formas } = montar({ featureFlags: { promotions: true, banners: false, retirada: true } });
  const escritas = banco.escritas.length;
  const desligada = await formas.salvar('loja-1', undefined, { entrega: false });
  const novas = banco.escritas.slice(escritas).filter((escrita) => escrita.caminho === LOJA);
  assert.equal(novas.length, 1);
  assert.deepEqual(Object.keys(novas[0].dados).sort(), ['featureFlags.entrega', 'updatedAt']);
  assert.deepEqual(banco.dados(LOJA).featureFlags, { promotions: true, banners: false, retirada: true, entrega: false });
  assert.equal(desligada.entrega, false);
  assert.equal(desligada.retirada, true);

  const ligada = await formas.salvar('loja-1', { pix: { ativa: true } }, { entrega: true });
  assert.equal(ligada.entrega, true);
  assert.equal(banco.dados(LOJA).featureFlags.entrega, true);
  assert.equal(banco.dados(LOJA).paymentMethods.find((item) => item.id === 'pix').isActive, true, 'formas e entrega na mesma gravacao');
});

test('K2 entrega: ligar a entrega sempre pode; sem formas e sem entrega continua formas_sem_mudancas', async () => {
  const { banco, formas } = montar();
  await formas.salvar('loja-1', {}, { entrega: true });
  assert.equal(banco.dados(LOJA).featureFlags.entrega, true);
  await assert.rejects(formas.salvar('loja-1', {}), (erro) => erro.code === 'formas_sem_mudancas');
  await assert.rejects(formas.salvar('loja-1', {}, {}), (erro) => erro.code === 'formas_sem_mudancas');
});

async function comRota(usar, loja = {}) {
  const contexto = montar(loja);
  const { requirePermission, accountForRequest } = createPermissionGuard({
    accessRepository: {
      findAccountByClaims: async () => ({
        hasEstablishment: true, establishmentDocument: {}, establishmentId: 'loja-1', permissions: { isAdmin: true, groupId: null, keys: [] },
      }),
    },
  });
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = { uid: 'uid-dono' }; next(); });
  app.use('/api/loja/formas-de-pagamento', createFormasDePagamentoRoutes({ formasDePagamento: contexto.formas, requirePermission, accountForRequest }));
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const chamar = (corpo) => fetch(`http://127.0.0.1:${servidor.address().port}/api/loja/formas-de-pagamento`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo),
  });
  try {
    await usar({ chamar, ...contexto });
  } finally {
    servidor.closeAllConnections();
    servidor.close();
  }
}

test('K2 rota: { formas?, entrega? } com entrega booleana; 409 com a mensagem do contrato', async () => {
  await comRota(async ({ chamar, banco }) => {
    assert.equal((await chamar({})).status, 400, 'pelo menos formas ou entrega');
    assert.equal((await chamar({ entrega: 'false' })).status, 400);
    assert.equal((await chamar({ entrega: false, retirada: true })).status, 400, 'retirada nao vem por aqui');
    const recusa = await chamar({ entrega: false });
    assert.equal(recusa.status, 409);
    const { error } = await recusa.json();
    assert.equal(error.code, 'sem_forma_de_receber');
    assert.equal(error.message, MENSAGEM);
    assert.equal(banco.dados(LOJA).featureFlags.entrega, undefined);
    const ok = await chamar({ entrega: true });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).data.entrega, true);
    const soFormas = await chamar({ formas: { pix: { ativa: true } } });
    assert.equal(soFormas.status, 200, 'o corpo antigo, so com formas, segue aceito');
  });
});
