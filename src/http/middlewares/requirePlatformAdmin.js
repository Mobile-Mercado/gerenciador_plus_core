import { AppError } from '../../domain/errors/AppError.js';

// Barreira das rotas /api/admin: confere em toda chamada se a conta e admin da plataforma.
// Guarda a resposta por token, com a vida do proprio token (claim `exp`), como o cache de
// permissoes de requirePermission.js. Sem `exp`, guarda por um minuto.
const FALLBACK_TTL_MS = 60 * 1000;

export function createPlatformAdminGuard({ platformAdminRepository, clock = () => Date.now() }) {
  const cache = new Map();

  const isPlatformAdminForRequest = async (request) => {
    const uid = request.auth?.uid;
    if (!uid) return false;
    const chave = `${uid}|${request.auth?.exp ?? ''}|${request.auth?.iat ?? ''}`;
    const agora = clock();
    const guardado = cache.get(chave);
    if (guardado && guardado.expiresAt > agora) return guardado.admin;
    cache.forEach((valor, key) => {
      if (valor.expiresAt <= agora) cache.delete(key);
    });
    const admin = await platformAdminRepository.isPlatformAdmin(uid);
    const exp = Number(request.auth?.exp);
    cache.set(chave, { admin, expiresAt: Number.isFinite(exp) && exp > 0 ? exp * 1000 : agora + FALLBACK_TTL_MS });
    return admin;
  };

  const requirePlatformAdmin = async (request, _response, next) => {
    try {
      if (!request.auth?.uid) {
        throw new AppError('Login obrigatorio para usar este recurso.', { statusCode: 401, code: 'auth_token_required' });
      }
      if (!(await isPlatformAdminForRequest(request))) {
        throw new AppError('Esta conta nao e administradora da plataforma.', {
          statusCode: 403,
          code: 'platform_admin_required',
        });
      }
      next();
    } catch (error) {
      next(error);
    }
  };

  return { requirePlatformAdmin, isPlatformAdminForRequest };
}
