// Contrato da leitura do painel "Produtos fora do app" (cola 65, item 5.1). Tudo da loja da sessao;
// o caso de uso nunca recebe a loja do pedido.
//
// - contarProdutos({ lojaId, filtros }): numero de estabelecimentos/{loja}/Products com os filtros
//   ([campo, operador, valor]; operadores ==, array-contains e >);
// - produtos({ lojaId, filtros, limite }): ate `limite` produtos ({ id, ...dados }) com os filtros;
// - produtosPorId({ lojaId, ids }): os produtos pedidos que existem ({ id, ...dados });
// - documentoDaLoja({ lojaId, caminho }): dados de estabelecimentos/{loja}/{caminho}, ou null;
// - ultimaLeitura({ lojaId }): Date do ultimo IntegrationLogs.receivedAt da loja, ou null;
// - configuracaoDoErp({ lojaId }): { loja: { integradorConfigs: { erpKey }, erpKey } | null,
//   status: { erpKey } | null }, so os campos da chave do ERP (Cola 71, item 3).
export class ProdutosForaDoAppRepository {
  async contarProdutos() {
    throw new Error('ProdutosForaDoAppRepository.contarProdutos precisa ser implementado.');
  }

  async produtos() {
    throw new Error('ProdutosForaDoAppRepository.produtos precisa ser implementado.');
  }

  async produtosPorId() {
    throw new Error('ProdutosForaDoAppRepository.produtosPorId precisa ser implementado.');
  }

  async documentoDaLoja() {
    throw new Error('ProdutosForaDoAppRepository.documentoDaLoja precisa ser implementado.');
  }

  async ultimaLeitura() {
    throw new Error('ProdutosForaDoAppRepository.ultimaLeitura precisa ser implementado.');
  }

  async configuracaoDoErp() {
    throw new Error('ProdutosForaDoAppRepository.configuracaoDoErp precisa ser implementado.');
  }
}
