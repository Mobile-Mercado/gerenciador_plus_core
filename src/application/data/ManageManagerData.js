import { AppError } from '../../domain/errors/AppError.js';

export class ManageManagerData {
  constructor({ accessRepository, gateway }) {
    this.accessRepository = accessRepository;
    this.gateway = gateway;
  }

  async getDocument({ actorUid, claims, target }) {
    return this.gateway.getDocument({ actor: await this.actor(actorUid, claims), target });
  }

  async getDocuments({ actorUid, claims, target }) {
    return this.gateway.getDocuments({ actor: await this.actor(actorUid, claims), target });
  }

  async countDocuments({ actorUid, claims, target }) {
    return this.gateway.countDocuments({ actor: await this.actor(actorUid, claims), target });
  }

  async mutate({ actorUid, claims, request }) {
    return this.gateway.mutate({ actor: await this.actor(actorUid, claims), request });
  }

  async subscribe({
    actorUid, claims, target, onSnapshot, onError,
  }) {
    return this.gateway.subscribe({
      actor: await this.actor(actorUid, claims),
      target,
      onSnapshot,
      onError,
    });
  }

  // O ator carrega as permissoes: a barreira de escrita da politica le `actor.permissions`.
  async actor(uid, claims) {
    const account = await this.accessRepository.findAccountByClaims({
      uid,
      adminOf: claims?.adminOf,
      groupId: claims?.groupId,
    });
    if (!account?.hasEstablishment) {
      throw new AppError('Conta sem estabelecimento ativo.', {
        statusCode: 403,
        code: 'data_establishment_required',
      });
    }
    return account;
  }
}
