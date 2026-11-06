import { Router } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import { safraDaLojaSchema } from './appDoClienteSchema.js';

// Contrato K3 (cola RP-62, item A.3): PATCH /api/loja/safrapay, corpo { ligada }, com settings.edit e a
// loja da conta. Sem a credencial da Mobile, 409 safra_sem_credencial. Devolve o corpo do K1.
export function createSafrapayDaLojaRoutes({ formasDePagamento, requirePermission, accountForRequest }) {
  const router = Router();

  router.patch('/', requirePermission('settings.edit'), asyncHandler(async (request, response) => {
    const { ligada } = safraDaLojaSchema.parse(request.body);
    const { establishmentId } = await accountForRequest(request);
    response.json({ data: await formasDePagamento.ligarSafra(establishmentId, ligada) });
  }));

  return router;
}
