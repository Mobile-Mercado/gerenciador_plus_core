import { AppError } from '../../domain/errors/AppError.js';

// Conferencia do App Check nas rotas publicas do cadastro. Fica pronta mas desligada
// (CADASTRO_EXIGE_APP_CHECK) ate o app gerenciador mandar o cabecalho X-Firebase-AppCheck.
export function createAppCheckMiddleware({ exigir, verificar }) {
  return async (request, _response, next) => {
    if (!exigir) {
      next();
      return;
    }
    const token = String(request.headers['x-firebase-appcheck'] || '').trim();
    if (!token) {
      next(new AppError('Atualize o app para continuar o cadastro.', { statusCode: 401, code: 'app_check_obrigatorio' }));
      return;
    }
    try {
      await verificar(token);
      next();
    } catch (error) {
      next(new AppError('Atualize o app para continuar o cadastro.', { statusCode: 401, code: 'app_check_invalido', cause: error }));
    }
  };
}
