// Grupos com que toda loja nova nasce (cola do Thay B57-18c, item 6, aprovada na B57-18d,
// item 2c). So para lojas novas: nenhuma loja ja gravada ganha ou perde grupo. A loja edita e
// apaga como qualquer grupo.
const PEDIDOS = ['requests.view', 'requests.update_status'];
const CONVERSA = ['chat.view', 'chat.send'];
// Separacao (cola do Thay B57-18e, item 4a): Remover item do pedido, Tirar produto do app ate
// repor e Excluir produto que nao vendemos mais. O Caixa so remove do pedido.
const SEPARACAO = ['requests.remove_item', 'requests.hide_until_restock', 'requests.trash_discontinued'];
export const GRUPOS_PRONTOS = Object.freeze([
  { id: 'separador', name: 'Separador', permissions: [...PEDIDOS, ...SEPARACAO, 'products.view', ...CONVERSA] },
  { id: 'caixa', name: 'Caixa', permissions: [...PEDIDOS, 'requests.cancel', 'requests.remove_item', 'clients.view',
    'products.view', 'coupons.view', ...CONVERSA] },
  { id: 'gerente', name: 'Gerente', permissions: ['dashboard.view', ...PEDIDOS, ...SEPARACAO, 'requests.cancel',
    'clients.view', 'products.view', 'products.create', 'products.edit', 'products.edit_price',
    'products.delete', 'coupons.view', 'coupons.manage', ...CONVERSA, 'settings.view',
    'settings.edit', 'admin_users.view', 'permission_groups.view', 'finance.view', 'logs.view'] },
]);
