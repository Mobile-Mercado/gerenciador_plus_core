import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middlewares/asyncHandler.js';

const establishmentParamsSchema = z.object({
  establishmentId: z.string().min(1).max(120),
});

const testNotificationSchema = z.object({
  establishmentId: z.string().min(1).max(120),
});
const registerTokenSchema = z.object({
  token: z.string().min(20).max(4096),
  userAgent: z.string().max(500).optional(),
});

export function createNotificationRoutes({ manageWebNotifications, requirePermission }) {
  const router = Router();

  // Aviso de pedido novo no navegador (RP-62, E.9, contrato K7): qualquer conta da loja registra o
  // token, sem settings.edit. Nao ha rota de descadastro: o token invalido e desativado no envio.
  router.post(
    '/web/register',
    asyncHandler(async (request, response) => {
      const payload = registerTokenSchema.parse(request.body);
      const result = await manageWebNotifications.registerToken({
        actorUid: request.auth.uid,
        claims: request.auth,
        token: payload.token,
        userAgent: payload.userAgent || request.headers['user-agent'],
      });
      response.json({ data: result });
    }),
  );

  router.get(
    '/web/status/:establishmentId',
    asyncHandler(async (request, response) => {
      const { establishmentId } = establishmentParamsSchema.parse(request.params);
      const result = await manageWebNotifications.getStatus({
        actorUid: request.auth.uid,
        establishmentId,
      });
      response.json({ data: result });
    }),
  );

  router.post(
    '/web/test',
    requirePermission('settings.edit'),
    asyncHandler(async (request, response) => {
      const { establishmentId } = testNotificationSchema.parse(request.body);
      const result = await manageWebNotifications.sendTest({
        actorUid: request.auth.uid,
        establishmentId,
      });
      response.json({ data: result });
    }),
  );

  return router;
}
