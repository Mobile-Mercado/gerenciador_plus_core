import { Router } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler.js';

// Rotas do app usuario (cola do Thay B57-03c, item 5). Pedem o login do app (a conta do cliente ou
// a anonima que o app abre sozinho) e o App Check quando ligado (APP_USUARIO_EXIGE_APP_CHECK). So
// leitura.
export function createAppUsuarioRoutes({ maisVendidosDaLoja }) {
  const router = Router();

  // GET /lojas/:lojaId/mais-vendidos: os produtos mais vendidos da loja nos ultimos 30 dias.
  router.get('/lojas/:lojaId/mais-vendidos', asyncHandler(async (request, response) => {
    response.json({ data: await maisVendidosDaLoja.listar(request.params.lojaId) });
  }));

  return router;
}
