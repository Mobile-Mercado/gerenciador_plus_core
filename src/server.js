import { createApp } from './app.js';
import { GenerateAiResponseUseCase } from './application/ai/GenerateAiResponseUseCase.js';
import { GetDailyHomeOverviewUseCase } from './application/ai/GetDailyHomeOverviewUseCase.js';
import { GetManagerSession } from './application/auth/GetManagerSession.js';
import { ManageManagerData } from './application/data/ManageManagerData.js';
import { ImportProductsFromCsvUseCase } from './application/implantacao/ImportProductsFromCsvUseCase.js';
import { ManageImplantationPipelines } from './application/implantacao/ManageImplantationPipelines.js';
import { UpdateImplantationApprovalUseCase } from './application/implantacao/UpdateImplantationApprovalUseCase.js';
import { ManageWebNotifications } from './application/notifications/ManageWebNotifications.js';
import { env } from './config/env.js';
import { FirebaseWebNotificationGateway } from './infra/firebase/FirebaseWebNotificationGateway.js';
import { FirestoreDailyAiInsightRepository } from './infra/firebase/FirestoreDailyAiInsightRepository.js';
import { FirestoreEstablishmentAccessRepository } from './infra/firebase/FirestoreEstablishmentAccessRepository.js';
import { FirestoreManagerDataGateway } from './infra/firebase/FirestoreManagerDataGateway.js';
import { FirestoreWebNotificationTokenRepository } from './infra/firebase/FirestoreWebNotificationTokenRepository.js';
import { ManagerDataAccessPolicy } from './infra/firebase/ManagerDataAccessPolicy.js';
import { getFirestoreDb } from './infra/firebase/firebaseAdmin.js';
import { createAiGateway } from './infra/ai/createAiGateway.js';
import { logger } from './infra/logger/logger.js';

const aiGateway = createAiGateway(env);

const generateAiResponseUseCase = new GenerateAiResponseUseCase({ aiGateway });
const firestore = getFirestoreDb();
const accessRepository = new FirestoreEstablishmentAccessRepository({ firestore });
const getManagerSession = new GetManagerSession({ accessRepository });
const dataPolicy = new ManagerDataAccessPolicy({ firestore });
const manageManagerData = new ManageManagerData({
  accessRepository,
  gateway: new FirestoreManagerDataGateway({ firestore, policy: dataPolicy }),
});
const getDailyHomeOverviewUseCase = new GetDailyHomeOverviewUseCase({
  accessRepository,
  insightRepository: new FirestoreDailyAiInsightRepository({ firestore }),
  generateAiResponseUseCase,
});
const importProductsFromCsvUseCase = new ImportProductsFromCsvUseCase({
  firestore,
});
const manageImplantationPipelines = new ManageImplantationPipelines({
  firestore,
});
const manageWebNotifications = new ManageWebNotifications({
  tokenRepository: new FirestoreWebNotificationTokenRepository({ firestore }),
  gateway: new FirebaseWebNotificationGateway(),
  accessRepository,
});
const updateImplantationApprovalUseCase = new UpdateImplantationApprovalUseCase({
  manageImplantationPipelines,
  manageWebNotifications,
  logger,
});
const app = createApp({
  generateAiResponseUseCase,
  getDailyHomeOverviewUseCase,
  importProductsFromCsvUseCase,
  manageImplantationPipelines,
  updateImplantationApprovalUseCase,
  manageWebNotifications,
  getManagerSession,
  manageManagerData,
});

const server = app.listen(env.PORT, () => {
  logger.info('backend_started', {
    port: env.PORT,
    env: env.NODE_ENV,
    aiProvider: aiGateway.provider,
    model: aiGateway.model,
    firebaseAuthRequired: env.REQUIRE_FIREBASE_AUTH,
  });
});

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function shutdown() {
  logger.info('backend_stopping');
  server.close(() => {
    logger.info('backend_stopped');
    process.exit(0);
  });
}
