import assert from 'node:assert/strict';
import { FormasDePagamento } from '../../src/application/loja/FormasDePagamento.js';
import { FirestoreEmMemoria } from './firestoreEmMemoria.js';

// Cola RP-62: contratos K1 a K4 das formas de pagamento e da Safra. Valores de credencial de
// mentira; nenhuma resposta pode trazer merchantId nem merchantToken.
export const LOJA = 'estabelecimentos/loja-1';
export const CREDENCIAL = 'safrapayMerchants/loja-1';
export const MERCHANT_ID = 'merchant-id-de-mentira';
export const MERCHANT_TOKEN = 'merchant-token-de-mentira';
export const credencialBoa = () => ({ enabled: true, env: 'prod', merchantId: MERCHANT_ID, merchantToken: MERCHANT_TOKEN });

export function montar(loja = {}, extras = {}) {
  const banco = new FirestoreEmMemoria({
    [LOJA]: {
      name: 'Loja 1',
      featureFlags: { promotions: true },
      paymentMethods: [
        { id: 'pix', name: 'Pix', isActive: true, order: 1, icon: null },
        { id: 'dinheiro', name: 'Dinheiro', isActive: true, order: 2, icon: null },
      ],
      ...loja,
    },
    ...extras,
  });
  return { banco, formas: new FormasDePagamento({ firestore: banco, serverTimestamp: () => new Date('2026-10-28T22:00:00Z') }) };
}

export const semValorDeCredencial = (corpo) => {
  const texto = JSON.stringify(corpo);
  assert.equal(texto.includes(MERCHANT_ID), false, 'merchantId nao sai');
  assert.equal(texto.includes(MERCHANT_TOKEN), false, 'merchantToken nao sai');
  assert.equal(/merchantId|merchantToken/.test(texto), false, 'nem o nome dos campos');
};
