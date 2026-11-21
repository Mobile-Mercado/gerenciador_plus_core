// Contrato da leitura do historico de um produto (cola 65, item 3.5): as linhas do Log das acoes
// da equipe (estabelecimentos/{loja}/AcoesEquipe) cujo alvo e o produto.
//
// linhasDoProduto({ lojaId, produtoId, limite }) devolve { linhas, completo }:
// - linhas: documentos do Log como gravados ({ id, em, quem, tela, acao, alvo, antes, depois, origem }),
//   em qualquer ordem; o caso de uso filtra e ordena;
// - completo: false quando a leitura pode ter deixado linhas de fora (leitura limitada sem ordem).
//
// "Quem" da linha (Cola 70, item 8): o Log guarda o e-mail ou o uid de quem agiu. A Equipe da loja
// e estabelecimentos/{loja}/AdminUsers/{uid} (firstName, lastName, email), a mesma que a sessao do
// Core le para o funcionario. Os metodos abaixo devolvem so o necessario:
// - nomeNaEquipePorUid({ lojaId, uid }) -> nome (firstName + lastName) ou null;
// - nomeNaEquipePorEmail({ lojaId, email }) -> nome ou null;
// - emailDoUid(uid) -> e-mail da conta (Users.userAuthId ou o Auth) ou null;
// - donoDaLoja({ lojaId }) -> { uid, email, nome } do dono (Users de estabelecimentos/{loja}.userReference;
//   nome = Users.name ou Users.nome) ou null (Cola 71, item 2). Uid e e-mail so servem para
//   reconhecer o dono na linha; so o nome sai na resposta.
// - configuracaoDoErp({ lojaId }) -> { loja: { integradorConfigs: { erpKey }, erpKey } | null,
//   status: { erpKey } | null } (Cola 71, item 3): o documento da loja e IntegrationStatus/current,
//   so os campos da chave do ERP.
export class HistoricoDoProdutoRepository {
  async linhasDoProduto() {
    throw new Error('HistoricoDoProdutoRepository.linhasDoProduto precisa ser implementado.');
  }

  async nomeNaEquipePorUid() {
    throw new Error('HistoricoDoProdutoRepository.nomeNaEquipePorUid precisa ser implementado.');
  }

  async nomeNaEquipePorEmail() {
    throw new Error('HistoricoDoProdutoRepository.nomeNaEquipePorEmail precisa ser implementado.');
  }

  async emailDoUid() {
    throw new Error('HistoricoDoProdutoRepository.emailDoUid precisa ser implementado.');
  }

  async donoDaLoja() {
    throw new Error('HistoricoDoProdutoRepository.donoDaLoja precisa ser implementado.');
  }

  async configuracaoDoErp() {
    throw new Error('HistoricoDoProdutoRepository.configuracaoDoErp precisa ser implementado.');
  }
}
