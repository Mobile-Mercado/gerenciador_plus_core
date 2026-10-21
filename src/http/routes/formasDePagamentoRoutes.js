import { Router } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import { formasDePagamentoSchema } from './appDoClienteSchema.js';

// Formas de pagamento da loja da sessao (contrato da versao 55, item 2; cola RP-13): credito e
// debito separados, cada forma com onde e cobrada. Ler nao pede chave (como as leituras do BFF);
// gravar pede settings.edit, a mesma da entrega. Debito so liga depois de liberado pelo Admin.
export function createFormasDePagamentoRoutes({ formasDePagamento, requirePermission, accountForRequest }) {
  const router = Router();

  router.get('/', asyncHandler(async (request, response) => {
    const { establishmentId } = await accountForRequest(request);
    response.json({ data: await formasDePagamento.ler(establishmentId) });
  }));

  router.patch('/', requirePermission('settings.edit'), asyncHandler(async (request, response) => {
    const { formas } = formasDePagamentoSchema.parse(request.body);
    const { establishmentId } = await accountForRequest(request);
    response.json({ data: await formasDePagamento.salvar(establishmentId, formas) });
  }));

  return router;
}
