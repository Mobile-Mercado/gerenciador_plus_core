import assert from 'node:assert/strict';
import test from 'node:test';
import { ManagerDataAccessPolicy } from '../src/infra/firebase/ManagerDataAccessPolicy.js';
import { FirestoreManagerDataGateway } from '../src/infra/firebase/FirestoreManagerDataGateway.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// RP-60 (dossie 83): pelo proxy /api/data/mutate o lojista nao grava credencial da Safrapay
// nem a escolha da credencial. Valores de mentira: nenhum e credencial de verdade.

const dono = { uid: 'uid-dono', userId: 'store-1', establishmentId: 'store-1', hasEstablishment: true };
const funcionario = {
  ...dono,
  uid: 'uid-func',
  permissions: { isAdmin: false, groupId: 'caixa', keys: ['settings.edit'] },
};

const LOJA = 'estabelecimentos/store-1';
const lojaComPagamento = () => ({
  name: 'Loja 1',
  safrapay: { enabled: true, environment: 'prod', methods: { pix: true, creditcard: true } },
  paymentGateway: { enabled: true, provider: 'safrapay', safrapay: { enabled: true, env: 'prod' } },
});

function montar(documentos = { [LOJA]: lojaComPagamento() }) {
  const firestore = new FirestoreEmMemoria(documentos);
  const policy = new ManagerDataAccessPolicy({ firestore });
  return { firestore, gateway: new FirestoreManagerDataGateway({ firestore, policy }) };
}

const gravar = (gateway, actor, operation, data, options, path = LOJA) => gateway.mutate({
  actor,
  request: { operation, target: { path }, data, options },
});

const lerLoja = async (firestore, path = LOJA) => (await firestore.doc(path).get()).data();

const recusado = (error) => error.code === 'campo_de_pagamento_so_admin' && error.statusCode === 403;

// Campos bloqueados: credencial, apelidos que a API le e a escolha da credencial.
const BLOQUEADOS = [
  'merchantId', 'merchantToken', 'accessToken', 'webhookSecret',
  'merchantRef', 'merchantConfigId', 'useDefaultMerchant',
  'safrapayMerchantId', 'safrapayMerchantToken', 'token',
];

test('safrapay: cada campo bloqueado e recusado, pontuado, no mapa inteiro e no set com merge', async () => {
  for (const campo of BLOQUEADOS) {
    const valor = campo === 'useDefaultMerchant' ? true : 'valor-de-mentira';
    for (const actor of [dono, funcionario]) {
      const { firestore, gateway } = montar();
      const antes = await lerLoja(firestore);
      await assert.rejects(gravar(gateway, actor, 'update', { [`safrapay.${campo}`]: valor }), recusado, `update safrapay.${campo}`);
      await assert.rejects(
        gravar(gateway, actor, 'update', { safrapay: { ...antes.safrapay, [campo]: valor } }),
        recusado,
        `update do mapa safrapay com ${campo}`,
      );
      await assert.rejects(
        gravar(gateway, actor, 'set', { safrapay: { [campo]: valor } }, { merge: true }),
        recusado,
        `set merge safrapay.${campo}`,
      );
      assert.deepEqual(await lerLoja(firestore), antes, 'nada gravado');
    }
  }
});

test('paymentGateway: nada dentro dele, em nenhuma posicao nem forma de gravar', async () => {
  const tentativas = [
    ['update', { paymentGateway: { enabled: true } }],
    ['update', { 'paymentGateway.enabled': true }],
    ['update', { 'paymentGateway.safrapay.enabled': true }],
    ['update', { 'paymentGateway.safrapay.merchantToken': 'valor-de-mentira' }],
    ['update', { 'paymentGateway.merchantRef': 'outra-loja' }],
    ['update', { 'paymentGateway.useDefaultMerchant': true }],
    ['set', { paymentGateway: { safrapay: { merchantConfigId: 'outra-loja' } } }, { merge: true }],
    ['set', { paymentGateway: {} }, { merge: true }],
  ];
  for (const [operation, data, options] of tentativas) {
    const { firestore, gateway } = montar();
    const antes = await lerLoja(firestore);
    await assert.rejects(gravar(gateway, funcionario, operation, data, options), recusado, JSON.stringify(data));
    assert.deepEqual(await lerLoja(firestore), antes);
  }
});

test('safrapay: nenhuma outra chave passa pelo proxy (o painel publicado nao grava nenhuma)', async () => {
  for (const data of [
    { 'safrapay.enabled': false },
    { 'safrapay.methods.pix': false },
    { safrapay: { enabled: true } },
    { 'safrapay.chaveNova': 1 },
  ]) {
    const { gateway } = montar();
    await assert.rejects(gravar(gateway, dono, 'update', data), recusado, JSON.stringify(data));
  }
  const { gateway } = montar();
  await assert.rejects(gravar(gateway, dono, 'set', { safrapay: { methods: { pix: false } } }, { merge: true }), recusado);
});

test('caminho com crase e lote tambem sao recusados, e o lote inteiro nao grava', async () => {
  const { firestore, gateway } = montar();
  const antes = await lerLoja(firestore);
  await assert.rejects(gravar(gateway, dono, 'update', { '`safrapay`.merchantToken': 'valor-de-mentira' }), recusado);
  await assert.rejects(gateway.mutate({
    actor: dono,
    request: {
      operation: 'batch',
      operations: [
        { operation: 'update', target: { path: LOJA }, data: { slogan: 'novo' } },
        { operation: 'update', target: { path: LOJA }, data: { 'safrapay.merchantRef': 'outra-loja' } },
      ],
    },
  }), recusado);
  assert.deepEqual(await lerLoja(firestore), antes);
});

test('gravar o documento inteiro ou apagar a loja nao apaga os mapas de pagamento', async () => {
  const { firestore, gateway } = montar();
  const antes = await lerLoja(firestore);
  await assert.rejects(gravar(gateway, dono, 'set', { name: 'Loja 1' }), recusado);
  await assert.rejects(gravar(gateway, dono, 'set', { name: 'Loja 1', safrapay: { merchantToken: 'x' } }), recusado);
  await assert.rejects(gravar(gateway, dono, 'delete'), recusado);
  assert.deepEqual(await lerLoja(firestore), antes);
});

test('o que a web publicada grava no documento da loja continua aceito', async () => {
  const { firestore, gateway } = montar();
  // settingsRepository.js (horarios, entrega, formas de pagamento, entregadores, dados fiscais),
  // useLojaRealtimeBridge.js (imagem e identidade visual) e logsApi.js (integrador), web origin/main.
  const escritas = [
    ['update', { openingHours: [{ weekday: 1, isOpen: true }], updatedAt: 1 }],
    ['update', { deliveryInfo: { deliveryCalcType: 'DeliveryCalcType.distance', baseValue: 5 }, minimumPriceCart: 20, updatedAt: 2 }],
    ['update', { paymentMethods: [{ id: 'pix', name: 'Pix', isActive: true }], updatedAt: 3 }],
    ['update', { deliveryMenList: [{ nome: 'Entregador' }], updatedAt: 4 }],
    ['update', { razaoSocial: 'Loja 1 LTDA', cnpj: '00000000000000', updatedAt: 5 }],
    ['update', { logoUrl: 'https://exemplo/logo.png' }],
    ['update', { name: 'Loja 1', slogan: 'Perto de voce', primaryColor: '#000000', secondaryColor: '#ffffff' }],
    ['set', { integrationSettings: { deriveComposedBoxStock: true } }, { merge: true }],
  ];
  for (const [operation, data, options] of escritas) {
    await gravar(gateway, funcionario, operation, data, options);
  }
  const loja = await lerLoja(firestore);
  assert.equal(loja.slogan, 'Perto de voce');
  assert.equal(loja.integrationSettings.deriveComposedBoxStock, true);
  assert.deepEqual(loja.safrapay, lojaComPagamento().safrapay, 'safrapay intacto');
  assert.deepEqual(loja.paymentGateway, lojaComPagamento().paymentGateway, 'paymentGateway intacto');
});

test('subcolecoes da loja nao mudam: paymentMethods e outras seguem como antes', async () => {
  const { firestore, gateway } = montar();
  await gravar(gateway, funcionario, 'set', { isActive: true, name: 'Pix' }, { merge: true }, `${LOJA}/paymentMethods/pix`);
  assert.equal((await lerLoja(firestore, `${LOJA}/paymentMethods/pix`)).isActive, true);
});

test('loja sem mapas de pagamento: gravar o documento inteiro segue como antes', async () => {
  const { firestore, gateway } = montar({ [LOJA]: { name: 'Loja sem pagamento' } });
  await gravar(gateway, dono, 'set', { name: 'Loja nova' });
  assert.deepEqual(await lerLoja(firestore), { name: 'Loja nova' });
});

test('loja de outro lojista continua recusada como antes', async () => {
  const { gateway } = montar({ 'estabelecimentos/store-2': lojaComPagamento() });
  await assert.rejects(
    gravar(gateway, dono, 'update', { slogan: 'x' }, undefined, 'estabelecimentos/store-2'),
    (error) => error.code === 'data_access_forbidden',
  );
  await assert.rejects(
    gravar(gateway, dono, 'update', { 'safrapay.merchantToken': 'x' }, undefined, 'estabelecimentos/store-2'),
    (error) => error.code === 'data_access_forbidden',
  );
});

test('Admin da Mobile grava por fora do proxy (Admin SDK direto) e segue gravando', async () => {
  const { firestore, gateway } = montar();
  await firestore.doc(LOJA).update({ 'safrapay.enabled': false, 'paymentGateway.safrapay.enabled': false });
  const loja = await lerLoja(firestore);
  assert.equal(loja.safrapay.enabled, false);
  assert.equal(loja.paymentGateway.safrapay.enabled, false);
  // O mesmo campo pelo proxy continua recusado.
  await assert.rejects(gravar(gateway, dono, 'update', { 'safrapay.enabled': true }), recusado);
});

test('Admin da plataforma agindo na loja (X-Loja-Alvo) continua passando pelo proxy (RP-62, item A.1)', async () => {
  const { firestore, gateway } = montar();
  const adminNaLoja = { ...dono, uid: 'uid-admin', porAdminDaPlataforma: true };
  await gravar(gateway, adminNaLoja, 'update', { 'safrapay.enabled': false, 'paymentGateway.safrapay.enabled': false });
  await gravar(gateway, adminNaLoja, 'update', { offerColor: '#FFF4D1' });
  const loja = await lerLoja(firestore);
  assert.equal(loja.safrapay.enabled, false);
  assert.equal(loja.paymentGateway.safrapay.enabled, false);
  assert.equal(loja.offerColor, '#FFF4D1');
  // O dono da loja, no mesmo caminho, segue recusado.
  await assert.rejects(gravar(gateway, dono, 'update', { 'safrapay.enabled': true }), recusado);
});
