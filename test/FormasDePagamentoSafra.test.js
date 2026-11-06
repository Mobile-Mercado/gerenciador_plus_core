import assert from 'node:assert/strict';
import test from 'node:test';
import { credencialPronta, safraLigada } from '../src/application/loja/FormasDePagamento.js';
import { CREDENCIAL, credencialBoa, montar, semValorDeCredencial } from './apoio/safraDeMentira.js';

// Cola RP-62, item A.4: contrato K1 (GET /api/loja/formas-de-pagamento).
test('K1: corpo do GET com safra, mercadoPago, entrega e retirada; sem debitoLiberado e sem valor de credencial', async () => {
  const { formas } = montar(
    { safrapay: { enabled: true }, paymentGateway: { safrapay: { enabled: true } } },
    { [CREDENCIAL]: credencialBoa() },
  );
  const corpo = await formas.ler('loja-1');
  assert.deepEqual(Object.keys(corpo).sort(), ['entrega', 'formas', 'lojaId', 'mercadoPago', 'retirada', 'safra']);
  assert.deepEqual(corpo.safra, { credencialPronta: true, ligada: true });
  assert.deepEqual(corpo.mercadoPago, { credencialPronta: false, ligada: false });
  assert.equal(corpo.entrega, true, 'featureFlags.entrega ausente vale ligada');
  assert.equal(corpo.retirada, false);
  assert.deepEqual(Object.keys(corpo.formas).sort(), ['credito', 'debito', 'dinheiro', 'pix']);
  semValorDeCredencial(corpo);
});

test('K1: credencialPronta e a mesma conta da API (documento, enabled, merchantId e merchantToken)', async () => {
  const casos = [
    [null, false],
    [{ ...credencialBoa(), enabled: false }, false],
    [{ ...credencialBoa(), enabled: undefined }, false],
    [{ ...credencialBoa(), merchantId: '' }, false],
    [{ ...credencialBoa(), merchantToken: '' }, false],
    [{ ...credencialBoa(), merchantToken: undefined }, false],
    [credencialBoa(), true],
    [{ ...credencialBoa(), enabled: 'true' }, true],
    [{ enabled: true, safrapayMerchantId: 'x', token: 'y' }, true],
  ];
  for (const [credencial, esperado] of casos) {
    assert.equal(credencialPronta(credencial), esperado, JSON.stringify(credencial));
    const { formas } = montar({}, credencial ? { [CREDENCIAL]: credencial } : {});
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await formas.ler('loja-1')).safra.credencialPronta, esperado);
  }
});

test('K1: ligada so com safrapay.enabled true e paymentGateway.safrapay.enabled diferente de false; entrega e retirada pelas flags', async () => {
  assert.equal(safraLigada({}), false);
  assert.equal(safraLigada({ safrapay: { enabled: true } }), true);
  assert.equal(safraLigada({ safrapay: { enabled: true }, paymentGateway: { safrapay: { enabled: false } } }), false);
  assert.equal(safraLigada({ safrapay: { enabled: 'true' } }), false);
  assert.equal(safraLigada({ safrapay: { enabled: false }, paymentGateway: { safrapay: { enabled: true } } }), false);
  const { formas } = montar({ featureFlags: { entrega: false, retirada: true } });
  const corpo = await formas.ler('loja-1');
  assert.equal(corpo.entrega, false);
  assert.equal(corpo.retirada, true);
  const naoBooleano = montar({ featureFlags: { entrega: 'nao', retirada: 'sim' } });
  const outro = await naoBooleano.formas.ler('loja-1');
  assert.equal(outro.entrega, true);
  assert.equal(outro.retirada, false);
});
