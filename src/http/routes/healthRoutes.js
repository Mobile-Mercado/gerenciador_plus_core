import { Router } from 'express';

export function createHealthRoutes() {
  const router = Router();

  router.get('/', (_request, response) => {
    response.json({
      status: 'ok',
      service: 'web-gerenciador-plus-backend',
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}
