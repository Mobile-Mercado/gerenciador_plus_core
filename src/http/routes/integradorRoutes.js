import { Router } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler.js';

// Cola 100, item 6: faixa da aba Integrador dos Logs do Gerenciador Web.
// - GET /alterados-hoje: { dia, alterados }, produtos distintos com preco, estoque ou situacao
//   mudados hoje (dia de Sao Paulo). A loja vem da conta (dono, funcionario com a permissao de ver
//   logs, ou Admin da plataforma na loja escolhida por X-Loja-Alvo).
export function createIntegradorRoutes({ alteradosHoje, requirePermission, accountForRequest }) {
  const router = Router();

  router.get('/alterados-hoje', requirePermission('logs.view'), asyncHandler(async (request, response) => {
    const conta = await accountForRequest(request);
    response.json({ data: await alteradosHoje.contar({ lojaId: conta.establishmentId }) });
  }));

  return router;
}
