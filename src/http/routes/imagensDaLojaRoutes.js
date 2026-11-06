import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import { corpoDeImagem } from '../middlewares/corpoDeImagem.js';

// Logo e capa da loja pelo Gerenciador Plus (Loja > Identidade visual e Marketing): a foto vai
// como sai do celular, ate 20 MB, e o Core grava o WEBP de ate 300 KB no mesmo campo que o app le.
const tipoSchema = z.object({ tipo: z.enum(['logo', 'fachada']) });

export function createImagensDaLojaRoutes({ imagensDaLoja, requirePermission, accountForRequest }) {
  const router = Router();

  router.post('/:tipo', requirePermission('settings.edit'), corpoDeImagem, asyncHandler(async (request, response) => {
    const { tipo } = tipoSchema.parse(request.params);
    const { establishmentId } = await accountForRequest(request);
    response.json({ data: await imagensDaLoja.trocar(establishmentId, tipo, request.body) });
  }));

  return router;
}
