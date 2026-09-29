import { AppError } from '../../domain/errors/AppError.js';

// Sem `exp` no token, guarda a identificacao por um minuto, como o cache de
// permissoes de requirePermission.js.
const FALLBACK_TTL_MS = 60 * 1000;
// Subcolecoes da loja que mudam quem pode o que.
const ACCESS_COLLECTIONS = new Set(['AdminUsers', 'PermissionGroups']);

export class ManageManagerData {
  constructor({ accessRepository, gateway, clock = () => Date.now() }) {
    this.accessRepository = accessRepository;
    this.gateway = gateway;
    this.clock = clock;
    this.accountCache = new Map();
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
    const result = await this.gateway.mutate({
      actor: await this.actor(actorUid, claims),
      request,
    });
    establishmentIdsTouchingAccess(request).forEach((id) => this.forgetEstablishment(id));
    return result;
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
  //
  // Guardado em memoria por token: sem isso cada chamada do painel gastava duas
  // leituras no Firestore (tres para funcionario) so para descobrir de novo quem
  // esta pedindo. A chave e o uid com os campos do token, e a validade vai ate o
  // `exp` dele.
  async actor(uid, claims) {
    const key = accountCacheKey(uid, claims);
    const now = this.clock();
    const cached = this.accountCache.get(key);
    if (cached && cached.expiresAt > now) return cached.account;

    this.accountCache.forEach((entry, entryKey) => {
      if (entry.expiresAt <= now) this.accountCache.delete(entryKey);
    });

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
    const exp = Number(claims?.exp);
    this.accountCache.set(key, {
      account,
      establishmentId: account.establishmentId,
      expiresAt: Number.isFinite(exp) && exp > 0 ? exp * 1000 : now + FALLBACK_TTL_MS,
    });
    return account;
  }

  // Escrita em AdminUsers, PermissionGroups ou no documento da loja muda quem pode
  // o que, entao a identificacao guardada daquela loja e descartada.
  //
  // Isso cobre so o que passa por /api/data/mutate. A tela Usuarios e permissoes
  // grava pelas callables do mobile_firebase_api, e o console do Firebase escreve
  // direto no banco: nesses casos o corte de acesso de um funcionario vale ate o
  // token dele expirar, no maximo uma hora. E o mesmo prazo que o cache de
  // permissoes de requirePermission.js ja aceita em /api/coupons e
  // /api/notifications. Nao suponha que a invalidacao daqui cobre tudo.
  forgetEstablishment(establishmentId) {
    if (!establishmentId) return;
    this.accountCache.forEach((entry, key) => {
      if (entry.establishmentId === establishmentId) this.accountCache.delete(key);
    });
  }
}

function accountCacheKey(uid, claims = {}) {
  return [
    uid || '',
    claims?.exp ?? '',
    claims?.iat ?? '',
    claims?.adminOf ?? '',
    claims?.groupId ?? '',
  ].join('|');
}

function establishmentIdsTouchingAccess(request) {
  const operations = request?.operation === 'batch' ? (request.operations || []) : [request];
  const ids = new Set();
  operations.forEach((operation) => {
    const parts = String(operation?.target?.path || '').split('/').filter(Boolean);
    if (parts[0] !== 'estabelecimentos' || !parts[1]) return;
    if (parts.length === 2 || ACCESS_COLLECTIONS.has(parts[2])) ids.add(parts[1]);
  });
  return ids;
}
