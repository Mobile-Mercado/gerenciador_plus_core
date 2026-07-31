import { AppError } from '../../domain/errors/AppError.js';

export class GetManagerSession {
  constructor({ accessRepository }) {
    this.accessRepository = accessRepository;
  }

  async execute({ actorUid }) {
    if (!actorUid) {
      throw new AppError('Login obrigatorio para consultar a sessao.', {
        statusCode: 401,
        code: 'auth_token_required',
      });
    }

    const account = await this.accessRepository.findAccountByUid(actorUid);
    if (!account) {
      return {
        userDocument: null,
        establishmentDocument: null,
        establishmentId: null,
        hasEstablishment: false,
      };
    }

    return {
      userDocument: account.userDocument,
      establishmentDocument: account.establishmentDocument,
      establishmentId: account.establishmentId,
      hasEstablishment: account.hasEstablishment,
    };
  }
}
