import { AppError } from '../../domain/errors/AppError.js';

export function createCouponAdminMiddleware({ allowedUids }) {
  const allowed = new Set(allowedUids || []);

  return (request, _response, next) => {
    if (!request.auth?.uid) {
      next(new AppError('Login administrativo obrigatorio.', {
        statusCode: 401,
        code: 'coupon_admin_auth_required',
      }));
      return;
    }

    if (!allowed.size) {
      next(new AppError('Nenhum administrador de cupons foi configurado.', {
        statusCode: 503,
        code: 'coupon_admin_not_configured',
      }));
      return;
    }

    if (!allowed.has(request.auth.uid)) {
      next(new AppError('Esta conta nao possui acesso a gestao de cupons.', {
        statusCode: 403,
        code: 'coupon_admin_forbidden',
      }));
      return;
    }

    next();
  };
}
