import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middlewares/asyncHandler.js';

// Entregadores da loja da sessao, com o celular que so o Core le e grava (17/10/2026). Ler pede a
// permissao de ver pedidos (quem atribui entregador); gravar, a mesma que grava deliveryMenList.
const listaSchema = z.array(z.object({
  name: z.string().max(200),
  phone: z.string().max(40).nullish(),
})).max(200);

export function createEntregadoresDaLojaRoutes({ entregadoresDaLoja, requirePermission, accountForRequest }) {
  const router = Router();

  router.get('/', requirePermission('requests.view'), asyncHandler(async (request, response) => {
    const { establishmentId } = await accountForRequest(request);
    response.json({ data: await entregadoresDaLoja.listar(establishmentId) });
  }));

  router.put('/', requirePermission('settings.edit'), asyncHandler(async (request, response) => {
    const lista = listaSchema.parse(request.body);
    const { establishmentId } = await accountForRequest(request);
    response.json({ data: await entregadoresDaLoja.salvar(establishmentId, lista) });
  }));

  return router;
}
