import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { PedidosDeLoja } from '../src/application/admin/PedidosDeLoja.js';
import { AuthEmMemoria } from './apoio/authEmMemoria.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Grupos prontos da loja nova (cola do Thay B57-18c, item 6, aprovada na B57-18d, item 2c):
// Separador, Caixa e Gerente nascem no "Aprovar", no mesmo lote da loja. Lojas ja gravadas
// nao mudam.
const HORA = () => new Date('2026-11-27T12:00:00Z');

function bancoComPedido() {
  const banco = new FirestoreEmMemoria({
    'Users/uid-dono': { id: 'uid-dono', userAuthId: 'uid-dono', userType: 'UserType.empresa', pedidoDeLojaId: 'pedido-novo' },
  });
  banco.docs.set('pedidosDeLoja/pedido-novo', {
    id: 'pedido-novo', uid: 'uid-dono', lojaId: null, name: 'Bom Preço', status: 'em_analise',
    address: { city: 'Vitória', uf: 'ES', number: '410' }, userReference: banco.doc('Users/uid-dono'),
  });
  const auth = new AuthEmMemoria([{ uid: 'uid-dono', email: 'ana@bp.com.br', customClaims: {} }]);
  return { banco, auth };
}

async function aprovar() {
  const { banco, auth } = bancoComPedido();
  await new PedidosDeLoja({ firestore: banco, auth, serverTimestamp: HORA }).aprovar('pedido-novo', { uid: 'uid-admin' });
  const lojaId = banco.dados('pedidosDeLoja/pedido-novo').lojaId;
  const grupo = (id) => banco.dados(`estabelecimentos/${lojaId}/PermissionGroups/${id}`);
  return { banco, lojaId, grupo };
}

const PRODUTO_ALEM_DE_VER = ['products.create', 'products.edit', 'products.edit_price', 'products.delete'];

test('aprovar cria Separador, Caixa e Gerente com as chaves da tabela, sem isAdmin', async () => {
  const { grupo } = await aprovar();
  assert.equal(grupo('separador')?.name, 'Separador');
  assert.equal(grupo('caixa')?.name, 'Caixa');
  assert.equal(grupo('gerente')?.name, 'Gerente');
  for (const id of ['separador', 'caixa', 'gerente']) {
    assert.equal(grupo(id).isAdmin, false, id);
    assert.ok(grupo(id).createdAt, id);
  }
  assert.deepEqual(new Set(grupo('caixa').permissions), new Set(['requests.view', 'requests.update_status',
    'requests.cancel', 'requests.remove_item', 'clients.view', 'products.view', 'coupons.view', 'chat.view', 'chat.send']));
});

test('separador sem chave de produto alem de Ver produtos; gerente sem gerenciar funcionarios e grupos, com financas', async () => {
  const { grupo } = await aprovar();
  const separador = grupo('separador').permissions;
  assert.ok(separador.includes('products.view'));
  PRODUTO_ALEM_DE_VER.forEach((chave) => assert.ok(!separador.includes(chave), chave));
  assert.ok(!separador.includes('requests.cancel'));
  const gerente = grupo('gerente').permissions;
  assert.ok(!gerente.includes('admin_users.manage'));
  assert.ok(!gerente.includes('permission_groups.manage'));
  assert.ok(gerente.includes('finance.view'));
  PRODUTO_ALEM_DE_VER.forEach((chave) => assert.ok(gerente.includes(chave), chave));
});

test('toda chave dos grupos prontos existe no catalogo de permissoes do web', async () => {
  const catalogo = new URL('../../web_gerenciador_plus/src/features/settings/permissionsCatalog.js', import.meta.url);
  if (!fs.existsSync(catalogo)) return;
  const fonte = fs.readFileSync(catalogo, 'utf8');
  const { grupo } = await aprovar();
  for (const id of ['separador', 'caixa', 'gerente']) {
    for (const chave of grupo(id).permissions) assert.ok(fonte.includes(`'${chave}'`), `${id}: ${chave}`);
  }
});

test('aprovar que falha ao gravar nao deixa loja nem grupo', async () => {
  const { banco, auth } = bancoComPedido();
  const batchOriginal = banco.batch.bind(banco);
  banco.batch = () => { const lote = batchOriginal(); lote.commit = async () => { throw new Error('falha de rede'); }; return lote; };
  await assert.rejects(new PedidosDeLoja({ firestore: banco, auth, serverTimestamp: HORA }).aprovar('pedido-novo', {}), /falha de rede/);
  assert.equal([...banco.docs.keys()].some((caminho) => caminho.startsWith('estabelecimentos/')), false);
});

// Cola do Thay B57-18e, item 4a: as tres permissoes da separacao nos grupos prontos.
test('B57-18e: Separador e Gerente com as tres da separacao; Caixa so com Remover item do pedido', async () => {
  const { grupo } = await aprovar();
  const TRES = ['requests.remove_item', 'requests.hide_until_restock', 'requests.trash_discontinued'];
  for (const id of ['separador', 'gerente']) TRES.forEach((chave) => assert.ok(grupo(id).permissions.includes(chave), `${id}: ${chave}`));
  assert.ok(grupo('caixa').permissions.includes('requests.remove_item'));
  assert.ok(!grupo('caixa').permissions.includes('requests.hide_until_restock'));
  assert.ok(!grupo('caixa').permissions.includes('requests.trash_discontinued'));
});
