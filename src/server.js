import { createApp } from './app.js';
import { GenerateAiResponseUseCase } from './application/ai/GenerateAiResponseUseCase.js';
import { GetDailyHomeOverviewUseCase } from './application/ai/GetDailyHomeOverviewUseCase.js';
import { GetManagerSession } from './application/auth/GetManagerSession.js';
import { AdministradoresDaPlataforma } from './application/admin/AdministradoresDaPlataforma.js';
import { DadosDoAdmin } from './application/admin/DadosDoAdmin.js';
import { Franquias } from './application/admin/Franquias.js';
import { LojaNoAdmin } from './application/admin/LojaNoAdmin.js';
import { PedidosDeLoja } from './application/admin/PedidosDeLoja.js';
import { SugestoesDosClientes } from './application/admin/SugestoesDosClientes.js';
import { CadastroDeLoja } from './application/cadastro/CadastroDeLoja.js';
import { ImagensDaLoja } from './application/cadastro/ImagensDaLoja.js';
import { LimiteDeTentativas } from './application/cadastro/LimiteDeTentativas.js';
import { CatalogoDaLoja } from './application/catalogo/CatalogoDaLoja.js';
import { ManageCatalogoPadrao } from './application/catalogo/ManageCatalogoPadrao.js';
import { TravasDeCategoria } from './application/catalogo/TravasDeCategoria.js';
import { ManageCoupons } from './application/coupons/ManageCoupons.js';
import { ManageManagerData } from './application/data/ManageManagerData.js';
import { DeliveryByCodeUseCase } from './application/delivery/DeliveryByCodeUseCase.js';
import { RecalculateCategoryCountsUseCase } from './application/stats/RecalculateCategoryCountsUseCase.js';
import { ImportProductsFromCsvUseCase } from './application/implantacao/ImportProductsFromCsvUseCase.js';
import { ManageImplantationPipelines } from './application/implantacao/ManageImplantationPipelines.js';
import { UpdateImplantationApprovalUseCase } from './application/implantacao/UpdateImplantationApprovalUseCase.js';
import { ManageWebNotifications } from './application/notifications/ManageWebNotifications.js';
import { env } from './config/env.js';
import { FirebaseWebNotificationGateway } from './infra/firebase/FirebaseWebNotificationGateway.js';
import { FirestoreDailyAiInsightRepository } from './infra/firebase/FirestoreDailyAiInsightRepository.js';
import { FirestoreCouponRepository } from './infra/firebase/FirestoreCouponRepository.js';
import { FirestoreEstablishmentAccessRepository } from './infra/firebase/FirestoreEstablishmentAccessRepository.js';
import { FirestoreManagerDataGateway } from './infra/firebase/FirestoreManagerDataGateway.js';
import { FirestorePlatformAdminRepository } from './infra/firebase/FirestorePlatformAdminRepository.js';
import { FirestoreUsoIaRepository } from './infra/firebase/FirestoreUsoIaRepository.js';
import { FirestoreWebNotificationTokenRepository } from './infra/firebase/FirestoreWebNotificationTokenRepository.js';
import { ManagerDataAccessPolicy } from './infra/firebase/ManagerDataAccessPolicy.js';
import {
  getFirebaseAppCheck, getFirebaseAuth, getFirestoreDb, getStorageBucket,
} from './infra/firebase/firebaseAdmin.js';
import { registrarAcaoDoAdmin } from './infra/firebase/registroDoAdmin.js';
import { BrasilApiCnpj } from './infra/cnpj/BrasilApiCnpj.js';
import { createAdminAuditMiddleware } from './http/middlewares/adminAudit.js';
import { createAiGateway } from './infra/ai/createAiGateway.js';
import { logger } from './infra/logger/logger.js';

const aiGateway = createAiGateway(env);

const firestore = getFirestoreDb();
const generateAiResponseUseCase = new GenerateAiResponseUseCase({
  aiGateway,
  usoIaRepository: new FirestoreUsoIaRepository({ firestore }),
  logger,
});
const accessRepository = new FirestoreEstablishmentAccessRepository({ firestore });
const platformAdminRepository = new FirestorePlatformAdminRepository({ firestore });
const getManagerSession = new GetManagerSession({ accessRepository, platformAdminRepository });
// Trava de categoria (lista padrao + liberacao por loja), com cache de cinco minutos.
const travas = new TravasDeCategoria({ firestore });
const dataPolicy = new ManagerDataAccessPolicy({ firestore, travas });
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
  travas,
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
const manageCoupons = new ManageCoupons({
  couponRepository: new FirestoreCouponRepository({ firestore }),
  accessRepository,
});
const recalculateCategoryCountsUseCase = new RecalculateCategoryCountsUseCase({
  firestore,
  accessRepository,
});
const deliveryByCodeUseCase = new DeliveryByCodeUseCase({ firestore });
const manageCatalogoPadrao = new ManageCatalogoPadrao({
  firestore,
  travas,
  bucket: getStorageBucket(env.STORAGE_BUCKET),
});
const catalogoDaLoja = new CatalogoDaLoja({ firestore, travas });
// Cadastro de loja pelo servidor e Admin completo (rodada de 13/10/2026).
const firebaseAuth = getFirebaseAuth();
const imagensDaLoja = new ImagensDaLoja({ firestore, bucket: getStorageBucket(env.STORAGE_BUCKET) });
const cadastroDeLoja = new CadastroDeLoja({
  firestore,
  auth: firebaseAuth,
  consultaCnpj: new BrasilApiCnpj(),
  limites: new LimiteDeTentativas({ firestore }),
  imagens: imagensDaLoja,
});
const app = createApp({
  cadastroDeLoja,
  verificarAppCheck: (token) => getFirebaseAppCheck().verifyToken(token),
  imagensDaLoja,
  pedidosDeLoja: new PedidosDeLoja({ firestore, auth: firebaseAuth }),
  lojaNoAdmin: new LojaNoAdmin({
    firestore, auth: firebaseAuth, accessRepository, imagens: imagensDaLoja,
  }),
  franquias: new Franquias({ firestore }),
  administradores: new AdministradoresDaPlataforma({ firestore, auth: firebaseAuth }),
  dadosDoAdmin: new DadosDoAdmin({ firestore }),
  firestore,
  registrarAcaoDoAdmin: (registro) => registrarAcaoDoAdmin(firestore, registro),
  manageCatalogoPadrao,
  catalogoDaLoja,
  platformAdminRepository,
  adminAuditMiddleware: createAdminAuditMiddleware({ firestore }),
  sugestoesDosClientes: new SugestoesDosClientes({ firestore }),
  accessRepository,
  generateAiResponseUseCase,
  getDailyHomeOverviewUseCase,
  importProductsFromCsvUseCase,
  manageImplantationPipelines,
  updateImplantationApprovalUseCase,
  manageWebNotifications,
  manageCoupons,
  getManagerSession,
  manageManagerData,
  recalculateCategoryCountsUseCase,
  deliveryByCodeUseCase,
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
