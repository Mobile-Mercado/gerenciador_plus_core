import { createApp } from './app.js';
import { GenerateAiResponseUseCase } from './application/ai/GenerateAiResponseUseCase.js';
import { ImportProductsFromCsvUseCase } from './application/implantacao/ImportProductsFromCsvUseCase.js';
import { ManageImplantationPipelines } from './application/implantacao/ManageImplantationPipelines.js';
import { UpdateImplantationApprovalUseCase } from './application/implantacao/UpdateImplantationApprovalUseCase.js';
import { ManageWebNotifications } from './application/notifications/ManageWebNotifications.js';
import { env } from './config/env.js';
import { FirebaseWebNotificationGateway } from './infra/firebase/FirebaseWebNotificationGateway.js';
import { FirestoreEstablishmentAccessRepository } from './infra/firebase/FirestoreEstablishmentAccessRepository.js';
import { FirestoreWebNotificationTokenRepository } from './infra/firebase/FirestoreWebNotificationTokenRepository.js';
import { getFirestoreDb } from './infra/firebase/firebaseAdmin.js';
import { logger } from './infra/logger/logger.js';
import { OpenAiResponsesGateway } from './infra/openai/OpenAiResponsesGateway.js';

const aiGateway = new OpenAiResponsesGateway({
  apiKey: env.OPENAI_API_KEY,
  model: env.OPENAI_MODEL,
  temperature: env.OPENAI_TEMPERATURE,
});

const generateAiResponseUseCase = new GenerateAiResponseUseCase({ aiGateway });
const firestore = getFirestoreDb();
const importProductsFromCsvUseCase = new ImportProductsFromCsvUseCase({
  firestore,
});
const manageImplantationPipelines = new ManageImplantationPipelines({
  firestore,
});
const manageWebNotifications = new ManageWebNotifications({
  tokenRepository: new FirestoreWebNotificationTokenRepository({ firestore }),
  gateway: new FirebaseWebNotificationGateway(),
  accessRepository: new FirestoreEstablishmentAccessRepository({ firestore }),
});
const updateImplantationApprovalUseCase = new UpdateImplantationApprovalUseCase({
  manageImplantationPipelines,
  manageWebNotifications,
  logger,
});
const app = createApp({
  generateAiResponseUseCase,
  importProductsFromCsvUseCase,
  manageImplantationPipelines,
  updateImplantationApprovalUseCase,
  manageWebNotifications,
});

const server = app.listen(env.PORT, () => {
  logger.info('backend_started', {
    port: env.PORT,
    env: env.NODE_ENV,
    model: env.OPENAI_MODEL,
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
