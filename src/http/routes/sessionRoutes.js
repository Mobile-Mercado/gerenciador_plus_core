import { Router } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler.js';

export function createSessionRoutes({ getManagerSession }) {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (request, response) => {
      const result = await getManagerSession.execute({ actorUid: request.auth.uid });
      response.json({ data: result });
    }),
  );

  return router;
}
