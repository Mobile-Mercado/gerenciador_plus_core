import { AppError } from '../../domain/errors/AppError.js';

// Barreira das rotas /api/ai (decisao do Thay de 12/10/2026): so conta de loja (a mesma
// conferencia do painel, findAccountByClaims) ou admin da plataforma usa a IA. Qualquer
// outra conta logada recebe 403; sem login, 401.
export function createContaDeLojaOuAdminGuard({ accountForRequest, isPlatformAdminForRequest }) {
  return async (request, _response, next) => {
    try {
      if (!request.auth?.uid) {
        throw new AppError('Login obrigatorio para usar este recurso.', { statusCode: 401, code: 'auth_token_required' });
      }
      try {
        await accountForRequest(request);
        next();
        return;
      } catch (error) {
        // Funcionario desativado continua recusado; conta sem loja ainda pode ser admin.
        if (error?.code !== 'data_establishment_required') throw error;
      }
      if (await isPlatformAdminForRequest(request)) {
        next();
        return;
      }
      throw new AppError('A IA do gerenciador e so para contas de loja.', { statusCode: 403, code: 'ai_conta_sem_loja' });
    } catch (error) {
      next(error);
    }
  };
}
