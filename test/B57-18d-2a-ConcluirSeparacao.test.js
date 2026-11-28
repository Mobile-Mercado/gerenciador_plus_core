import assert from 'node:assert/strict';
import test from 'node:test';
import { ManagerDataAccessPolicy, permissionKeyForMutation } from '../src/infra/firebase/ManagerDataAccessPolicy.js';

// Cola do Thay B57-18d, item 2 (a): "Concluir separacao" do web com retirada e com
// pesagem, os valores da pesagem conferidos e "Recusar" com "Atualizar status do pedido".
const funcionario = (keys) => ({
  uid: 'uid-func',
  userId: 'store-1',
  establishmentId: 'store-1',
  hasEstablishment: true,
  permissions: { isAdmin: false, groupId: 'g1', keys },
});
const DE_PEDIDOS = ['requests.view', 'requests.update_status'];

function firestoreDoPedido(status) {
  const pedido = { companyReference: { id: 'store-1' }, currentPurchaseStatus: `PurchaseStatus.${status}` };
  return {
    doc: () => ({ async get() { return { exists: true, data: () => pedido }; } }),
    collection: () => ({ doc: () => ({ async get() { return { exists: false }; } }) }),
  };
}

const gravar = (data, keys = DE_PEDIDOS, status = 'accepted') => new ManagerDataAccessPolicy({ firestore: firestoreDoPedido(status) })
  .assertMutation({ actor: funcionario(keys), mutation: { operation: 'update', target: { kind: 'document', path: 'PurchaseRequests/p1' }, data } });

const CONCLUSAO_DA_RETIRADA = {
  currentPurchaseStatus: 'PurchaseStatus.readyForPickup',
  statusList: [{ purchaseStatus: 'PurchaseStatus.readyForPickup' }],
  prontoParaRetirarEm: 1764259200000,
  separatedAt: 1764259200000,
  separationChecklist: { i1: true },
};
const PESAGEM = {
  productsCart: [{ id: 'i1', quantity: 1.25 }],
  price: 41.5,
  total: 46.5,
  descontoNaSeparacao: 2,
};
const campoProibido = (erro) => erro.code === 'data_order_fields_forbidden' && erro.statusCode === 403;

test('2a: funcionario com Atualizar status conclui a separacao de retirada', async () => {
  await gravar(CONCLUSAO_DA_RETIRADA);
});

test('2a: separacao com pesagem conclui com itens, valores e desconto', async () => {
  await gravar({ ...CONCLUSAO_DA_RETIRADA, ...PESAGEM });
  await gravar({
    currentPurchaseStatus: 'PurchaseStatus.waitingForDelivery',
    statusList: [{ purchaseStatus: 'PurchaseStatus.waitingForDelivery' }],
    separatedAt: 1764259200000,
    separationChecklist: { i1: true },
    ...PESAGEM,
  });
});

test('2a: productsCart, price ou total sem separationChecklist continuam recusados', async () => {
  for (const campo of ['productsCart', 'price', 'total', 'descontoNaSeparacao']) {
    await assert.rejects(gravar({ [campo]: PESAGEM[campo] }), campoProibido, campo);
  }
});

test('2a: a mensagem da recusa sai com acentos', async () => {
  await assert.rejects(gravar({ price: 10 }), (erro) => erro.message === 'A alteração contém campos não permitidos.');
});

test('2a: sem Atualizar status, continua barrado pela permissao', async () => {
  await assert.rejects(
    gravar(CONCLUSAO_DA_RETIRADA, ['requests.view']),
    (erro) => erro.code === 'permission_denied' && erro.statusCode === 403,
  );
});
