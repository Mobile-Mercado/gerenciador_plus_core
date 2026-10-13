import { AppError } from '../../domain/errors/AppError.js';

export class GetManagerSession {
  constructor({ accessRepository, platformAdminRepository = null }) {
    this.accessRepository = accessRepository;
    this.platformAdminRepository = platformAdminRepository;
  }

  // `claims` e o token verificado: adminOf e groupId escolhem a via do funcionario.
  async execute({ actorUid, claims } = {}) {
    const uid = actorUid || claims?.uid;
    if (!uid) {
      throw new AppError('Login obrigatorio para consultar a sessao.', {
        statusCode: 401,
        code: 'auth_token_required',
      });
    }

    // Admin da plataforma (usersAdmin), separado do isAdmin da loja: abre o /admin do painel
    // mesmo sem loja.
    const [account, isPlatformAdmin] = await Promise.all([
      this.accessRepository.findAccountByClaims({
        uid,
        adminOf: claims?.adminOf,
        groupId: claims?.groupId,
      }),
      this.platformAdminRepository ? this.platformAdminRepository.isPlatformAdmin(uid) : false,
    ]);
    if (!account) {
      return {
        userDocument: null,
        establishmentDocument: null,
        establishmentId: null,
        hasEstablishment: false,
        permissions: { isAdmin: false, groupId: null, keys: [] },
        isPlatformAdmin,
      };
    }

    return {
      userDocument: account.userDocument,
      establishmentDocument: account.establishmentDocument,
      establishmentId: account.establishmentId,
      hasEstablishment: account.hasEstablishment,
      permissions: account.permissions || { isAdmin: true, groupId: null, keys: [] },
      isPlatformAdmin,
    };
  }
}
