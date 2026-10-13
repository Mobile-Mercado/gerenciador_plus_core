import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import { corpoDeImagem } from '../middlewares/corpoDeImagem.js';

// Banners da loja pelo Gerenciador (rodada de 13/10/2026): o corpo e a imagem ja recortada pelo
// painel (1080 x 500) e o periodo vai na consulta (?inicio=...&fim=..., ISO). O Core grava como o
// app gerenciador grava, com image.size em decimal.
const periodoSchema = z.object({ inicio: z.string().min(1).max(40), fim: z.string().min(1).max(40) });
const idSchema = z.object({ bannerId: z.string().min(1).max(120).regex(/^[^/]+$/) });

export function createBannersDaLojaRoutes({ bannersDaLoja, requirePermission, accountForRequest }) {
  const router = Router();

  router.post('/', requirePermission('settings.edit'), corpoDeImagem, asyncHandler(async (request, response) => {
    const periodo = periodoSchema.parse(request.query);
    const { establishmentId } = await accountForRequest(request);
    response.status(201).json({ data: await bannersDaLoja.criar(establishmentId, request.body, periodo) });
  }));

  router.put('/:bannerId', requirePermission('settings.edit'), corpoDeImagem, asyncHandler(async (request, response) => {
    const periodo = periodoSchema.parse(request.query);
    const { bannerId } = idSchema.parse(request.params);
    const { establishmentId } = await accountForRequest(request);
    response.json({ data: await bannersDaLoja.editar(establishmentId, bannerId, request.body, periodo) });
  }));

  return router;
}
