// Reconhece, na abertura do app gerenciador, o lojista que ja e cliente da plataforma: o app
// logado manda o token na abertura, e o Core confere a conta (dono por Users ou funcionario pela
// claim adminOf) e a loja dela. Cliente e quem tem loja que nao esta no meio do cadastro:
// aprovada, ou loja antiga sem status. Token ausente, invalido ou expirado nao trava nada: a
// abertura segue sem a marca.
const STATUS_DO_CADASTRO_EM_CURSO = new Set(['aguardando_email', 'em_analise', 'em_conversa', 'recusada']);

export class ClienteDaPlataforma {
  constructor({ verificarToken, accessRepository }) {
    this.verificarToken = verificarToken;
    this.accessRepository = accessRepository;
  }

  async daRequisicao(request) {
    const token = String(request.headers?.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) return null;
    try {
      const claims = await this.verificarToken(token);
      const conta = await this.accessRepository.findAccountByClaims({
        uid: claims.uid, adminOf: claims.adminOf, groupId: claims.groupId,
      });
      if (!conta?.hasEstablishment || !conta.establishmentId) return null;
      const status = conta.establishmentDocument?.status || null;
      if (status && STATUS_DO_CADASTRO_EM_CURSO.has(status)) return null;
      return { lojaId: conta.establishmentId };
    } catch {
      return null;
    }
  }
}
