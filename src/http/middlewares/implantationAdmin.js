import { AppError } from '../../domain/errors/AppError.js';

export function createImplantationAdminMiddleware({ allowedUids }) {
  const allowed = new Set(allowedUids || []);

  return (request, _response, next) => {
    if (!request.auth?.uid) {
      next(new AppError('Login administrativo obrigatório.', {
        statusCode: 401,
        code: 'implantation_admin_auth_required',
      }));
      return;
    }

    if (!allowed.size) {
      next(new AppError('Nenhum administrador de implantação foi configurado.', {
        statusCode: 503,
        code: 'implantation_admin_not_configured',
      }));
      return;
    }

    if (!allowed.has(request.auth.uid)) {
      next(new AppError('Esta conta não possui acesso ao painel de implantação.', {
        statusCode: 403,
        code: 'implantation_admin_forbidden',
      }));
      return;
    }

    next();
  };
}
