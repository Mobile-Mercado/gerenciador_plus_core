import assert from 'node:assert/strict';
import test from 'node:test';
import { ManagerDataAccessPolicy, permissionKeyForMutation } from '../src/infra/firebase/ManagerDataAccessPolicy.js';

// Cola do Thay B57-18d, item 2 (b): "Concluir separacao" do web com retirada e com
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

test('2b: price e total da pesagem precisam ser numeros nao negativos', async () => {
  for (const errado of [{ price: '41,50' }, { total: -1 }, { price: Number.NaN }, { total: null }]) {
    await assert.rejects(
      gravar({ ...CONCLUSAO_DA_RETIRADA, ...PESAGEM, ...errado }),
      (erro) => erro.code === 'data_order_valores_invalidos' && erro.statusCode === 403,
      JSON.stringify(errado),
    );
  }
  await gravar({ ...CONCLUSAO_DA_RETIRADA, ...PESAGEM, price: 0, total: 0 });
});
