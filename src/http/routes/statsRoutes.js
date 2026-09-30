import { Router } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler.js';

export function createStatsRoutes({ recalculateCategoryCountsUseCase, requirePermission }) {
  const router = Router();

  // Botao de recalcular da tela de Categorias. Sem corpo: a loja vem da sessao.
  router.post(
    '/categorias/recalcular',
    requirePermission('products.edit'),
    asyncHandler(async (request, response) => {
      const result = await recalculateCategoryCountsUseCase.execute({
        uid: request.auth?.uid,
        claims: request.auth,
      });
      response.json({ data: result });
    }),
  );

  return router;
}
