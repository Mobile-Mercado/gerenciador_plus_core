import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { createAiRoutes } from './http/routes/aiRoutes.js';
import { createHealthRoutes } from './http/routes/healthRoutes.js';
import { createImplantacaoRoutes } from './http/routes/implantacaoRoutes.js';
import { createNotificationRoutes } from './http/routes/notificationRoutes.js';
import { errorHandler, notFoundHandler } from './http/middlewares/errorHandler.js';
import { createFirebaseAuthMiddleware } from './http/middlewares/firebaseAuth.js';
import { createImplantationAdminMiddleware } from './http/middlewares/implantationAdmin.js';
import { requestLogger } from './http/middlewares/requestLogger.js';

export function createApp({
  generateAiResponseUseCase,
  getDailyHomeOverviewUseCase,
  importProductsFromCsvUseCase,
  manageImplantationPipelines,
  updateImplantationApprovalUseCase,
  manageWebNotifications,
}) {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: resolveCorsOrigin, credentials: true }));
  app.use(express.json({ limit: env.REQUEST_BODY_LIMIT }));
  app.use(requestLogger);

  app.get('/', (_request, response) => {
    response.json({
      service: 'web-gerenciador-plus-backend',
      status: 'online',
    });
  });

  app.use('/health', createHealthRoutes());
  app.use(
    '/api/ai',
    createFirebaseAuthMiddleware({ required: env.REQUIRE_FIREBASE_AUTH }),
    createAiRoutes({ generateAiResponseUseCase, getDailyHomeOverviewUseCase }),
  );
  app.use(
    '/api/implantacao',
    createFirebaseAuthMiddleware({ required: env.REQUIRE_FIREBASE_AUTH }),
    createImplantacaoRoutes({
      importProductsFromCsvUseCase,
      manageImplantationPipelines,
      updateImplantationApprovalUseCase,
      implantationAdminMiddleware: createImplantationAdminMiddleware({
        allowedUids: env.IMPLANTATION_ADMIN_UIDS,
      }),
    }),
  );
  app.use(
    '/api/notifications',
    createFirebaseAuthMiddleware({ required: true }),
    createNotificationRoutes({ manageWebNotifications }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

function resolveCorsOrigin(origin, callback) {
  if (!origin || env.CORS_ORIGINS.includes('*') || env.CORS_ORIGINS.includes(origin)) {
    callback(null, true);
    return;
  }

  callback(null, false);
}
