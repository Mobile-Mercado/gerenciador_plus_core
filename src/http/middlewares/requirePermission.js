import { AppError } from '../../domain/errors/AppError.js';

// Barreira de escrita por chave de permissao. As chaves sao as mesmas do catalogo do
// painel: requests.*, products.*, coupons.*, chat.*, settings.*, admin_users.*,
// permission_groups.*, dashboard.view, finance.view, logs.view.
//
// Dono da loja (sessao sem claim adminOf) entra como isAdmin e passa em tudo. Leitura
// nao e barrada nesta rodada.

export function assertPermission(permissions, key) {
  if (permissions?.isAdmin === true) return;
  const keys = Array.isArray(permissions?.keys) ? permissions.keys : [];
  if (keys.includes(key)) return;
  throw new AppError('Seu grupo nao tem esta permissao.', {
    statusCode: 403,
    code: 'permission_denied',
    details: { key },
  });
}

// Cache por token, com a vida do proprio token (claim `exp`). Sem `exp`, guarda por
// um minuto: o token seguinte refaz a leitura.
const FALLBACK_TTL_MS = 60 * 1000;

export function createPermissionGuard({ accessRepository, clock = () => Date.now() }) {
  const cache = new Map();

  const cacheKey = (request) => {
    const header = String(request.headers?.authorization || '');
    return header.match(/^Bearer\s+(.+)$/i)?.[1] || request.auth?.uid || '';
  };

  const expiresAt = (request) => {
    const exp = Number(request.auth?.exp);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : clock() + FALLBACK_TTL_MS;
  };

  const permissionsForRequest = async (request) => {
    const chave = cacheKey(request);
    const agora = clock();
    const guardado = cache.get(chave);
    if (guardado && guardado.expiresAt > agora) return guardado.permissions;
    cache.forEach((valor, key) => {
      if (valor.expiresAt <= agora) cache.delete(key);
    });
    const account = await accessRepository.findAccountByClaims({
      uid: request.auth?.uid,
      adminOf: request.auth?.adminOf,
      groupId: request.auth?.groupId,
    });
    if (!account?.hasEstablishment) {
      throw new AppError('Conta sem estabelecimento ativo.', {
        statusCode: 403,
        code: 'data_establishment_required',
      });
    }
    const permissions = account.permissions || { isAdmin: true, groupId: null, keys: [] };
    if (chave) cache.set(chave, { permissions, expiresAt: expiresAt(request) });
    return permissions;
  };

  const requirePermission = (key) => async (request, _response, next) => {
    try {
      assertPermission(await permissionsForRequest(request), key);
      next();
    } catch (error) {
      next(error);
    }
  };

  return { requirePermission, permissionsForRequest };
}
