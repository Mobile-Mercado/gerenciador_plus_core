import { AppError } from '../../domain/errors/AppError.js';

export class GetManagerSession {
  constructor({ accessRepository }) {
    this.accessRepository = accessRepository;
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

    const account = await this.accessRepository.findAccountByClaims({
      uid,
      adminOf: claims?.adminOf,
      groupId: claims?.groupId,
    });
    if (!account) {
      return {
        userDocument: null,
        establishmentDocument: null,
        establishmentId: null,
        hasEstablishment: false,
        permissions: { isAdmin: false, groupId: null, keys: [] },
      };
    }

    return {
      userDocument: account.userDocument,
      establishmentDocument: account.establishmentDocument,
      establishmentId: account.establishmentId,
      hasEstablishment: account.hasEstablishment,
      permissions: account.permissions || { isAdmin: true, groupId: null, keys: [] },
    };
  }
}
