import { AppError } from '../../domain/errors/AppError.js';

export class ManageManagerData {
  constructor({ accessRepository, gateway }) {
    this.accessRepository = accessRepository;
    this.gateway = gateway;
  }

  async getDocument({ actorUid, target }) {
    return this.gateway.getDocument({ actor: await this.actor(actorUid), target });
  }

  async getDocuments({ actorUid, target }) {
    return this.gateway.getDocuments({ actor: await this.actor(actorUid), target });
  }

  async countDocuments({ actorUid, target }) {
    return this.gateway.countDocuments({ actor: await this.actor(actorUid), target });
  }

  async mutate({ actorUid, request }) {
    return this.gateway.mutate({ actor: await this.actor(actorUid), request });
  }

  async subscribe({ actorUid, target, onSnapshot, onError }) {
    return this.gateway.subscribe({
      actor: await this.actor(actorUid),
      target,
      onSnapshot,
      onError,
    });
  }

  async actor(uid) {
    const account = await this.accessRepository.findAccountByUid(uid);
    if (!account?.hasEstablishment) {
      throw new AppError('Conta sem estabelecimento ativo.', {
        statusCode: 403,
        code: 'data_establishment_required',
      });
    }
    return account;
  }
}
