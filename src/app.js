import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { createAdminRoutes } from './http/routes/adminRoutes.js';
import { createAiRoutes } from './http/routes/aiRoutes.js';
import { createAppUsuarioRoutes } from './http/routes/appUsuarioRoutes.js';
import { createAppDoClienteDaLojaRoutes } from './http/routes/appDoClienteDaLojaRoutes.js';
import { createAparenciaDaLojaRoutes } from './http/routes/aparenciaDaLojaRoutes.js';
import { createBannersDaLojaRoutes } from './http/routes/bannersDaLojaRoutes.js';
import { createEntregaDaLojaRoutes } from './http/routes/entregaDaLojaRoutes.js';
import { createFormasDePagamentoRoutes } from './http/routes/formasDePagamentoRoutes.js';
import { createSafrapayDaLojaRoutes } from './http/routes/safrapayDaLojaRoutes.js';
import { createEntregadoresDaLojaRoutes } from './http/routes/entregadoresDaLojaRoutes.js';
import { createMotivosDaSeparacaoRoutes } from './http/routes/motivosDaSeparacaoRoutes.js';
import { createCadastroRoutes } from './http/routes/cadastroRoutes.js';
import { createCatalogoRoutes } from './http/routes/catalogoRoutes.js';
import { createCouponRoutes } from './http/routes/couponRoutes.js';
import { createDataRoutes } from './http/routes/dataRoutes.js';
import { createDeliveryRoutes } from './http/routes/deliveryRoutes.js';
import { createHealthRoutes } from './http/routes/healthRoutes.js';
import { createImagensDaLojaRoutes } from './http/routes/imagensDaLojaRoutes.js';
import { createImplantacaoRoutes } from './http/routes/implantacaoRoutes.js';
import { createNotificationRoutes } from './http/routes/notificationRoutes.js';
import { createProdutosRoutes } from './http/routes/produtosRoutes.js';
import { createSessionRoutes } from './http/routes/sessionRoutes.js';
import { createStatsRoutes } from './http/routes/statsRoutes.js';
import { createAppCheckMiddleware } from './http/middlewares/appCheck.js';
import { errorHandler, notFoundHandler } from './http/middlewares/errorHandler.js';
import { createFirebaseAuthMiddleware } from './http/middlewares/firebaseAuth.js';
import { createLojaAlvoDoAdmin } from './http/middlewares/lojaAlvoDoAdmin.js';
import { createPermissionGuard } from './http/middlewares/requirePermission.js';
import { createPlatformAdminGuard } from './http/middlewares/requirePlatformAdmin.js';
import { createContaDeLojaOuAdminGuard } from './http/middlewares/requireContaDeLojaOuAdmin.js';
import { requestLogger } from './http/middlewares/requestLogger.js';
import { createSessaoWebGuard } from './http/middlewares/sessaoWeb.js';
import { createSessoesWebRoutes } from './http/routes/sessoesWebRoutes.js';
import { createRetornoDavRoutes } from './http/routes/retornoDavRoutes.js';
import { createIntegradorRoutes } from './http/routes/integradorRoutes.js';

export function createApp({
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
  accessRepository,
  manageCatalogoPadrao,
  catalogoDaLoja,
  platformAdminRepository,
  adminAuditMiddleware,
  sugestoesDosClientes,
  cadastroDeLoja,
  jornadaDoCadastro = null,
  clienteDaPlataforma = null,
  jornadaDeEntrada = null,
  entregaDaLoja = null,
  appDoClienteDaLoja = null,
  conjuntosDeIcones = null,
  iconesComIa = null,
  aparenciaDaLoja = null,
  aparenciaDaHome = null,
  bannersNoAdmin = null,
  formasDePagamento = null,
  entregadoresDaLoja = null,
  motivosDaSeparacao = null,
  verificarAppCheck,
  imagensDaLoja,
  pedidosDeLoja,
  lojaNoAdmin,
  franquias,
  administradores,
  dadosDoAdmin,
  firestore,
  registrarAcaoDoAdmin,
  bannersDaLoja,
  instalacoesDosApps,
  maisVendidosDaLoja = null,
  alertasDoAdmin = null,
  historicoDoProduto = null,
  produtosForaDoApp = null,
  integradorDaLoja = null,
  sessoesWeb = null,
  sessoesWebPublicadoEm = null,
  retornoDav = null,
  alteradosHoje = null,
}) {
  const app = express();
  // Barreira de escrita por chave de permissao, com cache por token.
  const { requirePermission, accountForRequest } = createPermissionGuard({ accessRepository });
  // Admin da plataforma (usersAdmin), conferido em toda chamada de /api/admin.
  const { requirePlatformAdmin, isPlatformAdminForRequest } = createPlatformAdminGuard({ platformAdminRepository });
  // IA so para conta de loja ou admin da plataforma (decisao do Thay de 12/10/2026).
  const requireContaDeLojaOuAdmin = createContaDeLojaOuAdminGuard({ accountForRequest, isPlatformAdminForRequest });
  // Admin da plataforma agindo na loja escolhida (cabecalho X-Loja-Alvo), conferido em toda chamada.
  const lojaAlvoDoAdmin = createLojaAlvoDoAdmin({ isPlatformAdminForRequest, firestore });
  // Item 5.10 "Acessos conectados": X-Sessao conferido nas rotas da conta de loja (sessaoWeb.js).
  const sessaoWeb = sessoesWeb
    ? createSessaoWebGuard({ accountForRequest, sessoesWeb, publicadoEm: sessoesWebPublicadoEm })
    : (_request, _response, next) => next();
  // Ficha de implantacao no Admin: mesma barreira e mesmo registro de /api/admin.
  const implantationAdminMiddleware = (request, response, next) => {
    requirePlatformAdmin(request, response, (error) => {
      if (error) {
        next(error);
        return;
      }
      response.locals.lojasAlvo = [request.params.establishmentId].filter(Boolean);
      adminAuditMiddleware(request, response, next);
    });
  };

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
  // Sem token de proposito: a pagina do entregador e aberta por link. Ver o comentario
  // no topo de deliveryRoutes.js antes de mexer.
  app.use('/api/entrega', createDeliveryRoutes({ deliveryByCodeUseCase }));
  // Cadastro de loja pelo app gerenciador: POST /loja e /loja/cnpj sem login (limite de tentativas
  // no Firestore e App Check preparado); o resto com o login da conta criada.
  app.use('/api/cadastro', createCadastroRoutes({
    cadastroDeLoja,
    jornadaDoCadastro,
    clienteDaPlataforma,
    appCheck: createAppCheckMiddleware({ exigir: env.CADASTRO_EXIGE_APP_CHECK, verificar: verificarAppCheck }),
    exigirLogin: createFirebaseAuthMiddleware({ required: true }),
  }));
  // App usuario (cola B57-03c, item 5): os mais vendidos da loja, com o login do app (inclusive o
  // anonimo) e o App Check quando ligado. So leitura.
  if (maisVendidosDaLoja) {
    app.use(
      '/api/app',
      createAppCheckMiddleware({ exigir: env.APP_USUARIO_EXIGE_APP_CHECK, verificar: verificarAppCheck }),
      createFirebaseAuthMiddleware({ required: true }),
      createAppUsuarioRoutes({ maisVendidosDaLoja }),
    );
  }
  // Item 5.10 "Acessos conectados": registro, sinal de 30 s e nome do navegador. Sem a barreira do
  // X-Sessao: o registro e o que da o X-Sessao, e o sinal confere a sessao ele mesmo.
  if (sessoesWeb) {
    app.use(
      '/api/sessoes-web',
      createFirebaseAuthMiddleware({ required: true }),
      createSessoesWebRoutes({ sessoesWeb, accountForRequest }),
    );
  }
  app.use(
    '/api/session',
    createFirebaseAuthMiddleware({ required: true }),
    sessaoWeb,
    createSessionRoutes({ getManagerSession }),
  );
  app.use(
    '/api/data',
    createFirebaseAuthMiddleware({ required: true }),
    sessaoWeb,
    lojaAlvoDoAdmin,
    createDataRoutes({ manageManagerData, registrarAcaoDoAdmin }),
  );
  app.use(
    '/api/ai',
    createFirebaseAuthMiddleware({ required: env.REQUIRE_FIREBASE_AUTH }),
    sessaoWeb,
    requireContaDeLojaOuAdmin,
    createAiRoutes({
      generateAiResponseUseCase, getDailyHomeOverviewUseCase, requirePermission, accountForRequest,
    }),
  );
  app.use(
    '/api/implantacao',
    createFirebaseAuthMiddleware({ required: env.REQUIRE_FIREBASE_AUTH }),
    sessaoWeb,
    lojaAlvoDoAdmin,
    createImplantacaoRoutes({
      importProductsFromCsvUseCase,
      manageImplantationPipelines,
      updateImplantationApprovalUseCase,
      implantationAdminMiddleware,
      requirePermission,
      accountForRequest,
      registrarAcaoDoAdmin,
    }),
  );
  app.use(
    '/api/notifications',
    createFirebaseAuthMiddleware({ required: true }),
    sessaoWeb,
    createNotificationRoutes({ manageWebNotifications, requirePermission }),
  );
  app.use(
    '/api/stats',
    createFirebaseAuthMiddleware({ required: true }),
    sessaoWeb,
    createStatsRoutes({ recalculateCategoryCountsUseCase, requirePermission }),
  );
  app.use(
    '/api/coupons',
    createFirebaseAuthMiddleware({ required: true }),
    sessaoWeb,
    createCouponRoutes({ manageCoupons, requirePermission, accountForRequest }),
  );
  // Historico do produto da propria loja, lido do Log das acoes da equipe (cola 65, item 3.5).
  if (historicoDoProduto) {
    app.use(
      '/api/produtos',
      createFirebaseAuthMiddleware({ required: true }),
      sessaoWeb,
      lojaAlvoDoAdmin,
      createProdutosRoutes({ historicoDoProduto, produtosForaDoApp, accountForRequest }),
    );
  }
  // Itens 5.13 e 4.21: aba "Retorno DAV" dos Logs e "Reenviar ao Linear" (loja, ou Admin na loja alvo).
  if (retornoDav) {
    app.use(
      '/api/retorno-dav',
      createFirebaseAuthMiddleware({ required: true }),
      sessaoWeb,
      lojaAlvoDoAdmin,
      createRetornoDavRoutes({ retornoDav, requirePermission, accountForRequest, registrarAcaoDoAdmin }),
    );
  }
  // Cola 100, item 6: "Alterados hoje" da faixa da aba Integrador (loja, ou Admin na loja alvo).
  if (alteradosHoje) {
    app.use(
      '/api/integrador',
      createFirebaseAuthMiddleware({ required: true }),
      sessaoWeb,
      lojaAlvoDoAdmin,
      createIntegradorRoutes({ alteradosHoje, requirePermission, accountForRequest }),
    );
  }
  // Catalogo da loja a partir da lista padrao (Ativar, travadas, nome de exibicao).
  app.use(
    '/api/catalogo',
    createFirebaseAuthMiddleware({ required: true }),
    sessaoWeb,
    createCatalogoRoutes({ catalogoDaLoja, requirePermission, accountForRequest }),
  );
  // Banners da loja: imagem recortada pelo painel, documento gravado com image.size em decimal.
  app.use(
    '/api/loja/banners',
    createFirebaseAuthMiddleware({ required: true }),
    sessaoWeb,
    createBannersDaLojaRoutes({ bannersDaLoja, bannersPorTipo: bannersNoAdmin, requirePermission, accountForRequest }),
  );
  // Entregadores com o celular, que so o Core le e grava (entregadoresPrivado).
  app.use(
    '/api/loja/entregadores',
    createFirebaseAuthMiddleware({ required: true }),
    sessaoWeb,
    createEntregadoresDaLojaRoutes({ entregadoresDaLoja, requirePermission, accountForRequest }),
  );
  // Motivos da separacao (cola B57-16b, item 11): so o Core le e grava MotivosDaSeparacao; o web e o App
  // Gerenciador usam estas rotas (contrato B57-16b-contrato-motivos.md).
  if (motivosDaSeparacao) {
    app.use(
      '/api/loja/motivos-da-separacao',
      createFirebaseAuthMiddleware({ required: true }),
      sessaoWeb,
      createMotivosDaSeparacaoRoutes({ motivosDaSeparacao, requirePermission, accountForRequest }),
    );
  }
  // Entrega da propria loja: a mesma tela e o mesmo contrato do Admin, sem mudar o contrato.
  app.use(
    '/api/loja/entrega',
    createFirebaseAuthMiddleware({ required: true }),
    sessaoWeb,
    createEntregaDaLojaRoutes({ entregaDaLoja, requirePermission, accountForRequest }),
  );
  // Formas de pagamento da propria loja: credito e debito separados, onde cada uma e cobrada.
  app.use(
    '/api/loja/formas-de-pagamento',
    createFirebaseAuthMiddleware({ required: true }),
    sessaoWeb,
    createFormasDePagamentoRoutes({ formasDePagamento, requirePermission, accountForRequest }),
  );
  // Chave da Safra pela propria loja, so com a credencial da Mobile (cola RP-62, contrato K3).
  app.use(
    '/api/loja/safrapay',
    createFirebaseAuthMiddleware({ required: true }),
    sessaoWeb,
    createSafrapayDaLojaRoutes({ formasDePagamento, requirePermission, accountForRequest }),
  );
  // Funcoes do app do cliente pela propria loja: so "Meus cupons fiscais" (cola RP-58).
  app.use(
    '/api/loja/app-do-cliente',
    createFirebaseAuthMiddleware({ required: true }),
    sessaoWeb,
    createAppDoClienteDaLojaRoutes({ appDoClienteDaLoja, aparenciaDaHome, conjuntosDeIcones, requirePermission, accountForRequest }),
  );
  // Fundo de Ofertas pela propria loja, so quando o Admin libera (cola B56-04, item 3.4).
  if (aparenciaDaLoja) {
    app.use(
      '/api/loja/aparencia',
      createFirebaseAuthMiddleware({ required: true }),
      sessaoWeb,
      createAparenciaDaLojaRoutes({ aparenciaDaLoja, requirePermission, accountForRequest }),
    );
  }
  // Logo e capa da loja pelo painel: foto como sai do celular, convertida pelo Core.
  app.use(
    '/api/loja/imagens',
    createFirebaseAuthMiddleware({ required: true }),
    sessaoWeb,
    createImagensDaLojaRoutes({ imagensDaLoja, requirePermission, accountForRequest }),
  );
  // Admin da plataforma: login, barreira de admin em toda chamada e registro de quem agiu.
  app.use(
    '/api/admin',
    createFirebaseAuthMiddleware({ required: true }),
    requirePlatformAdmin,
    adminAuditMiddleware,
    createAdminRoutes({
      manageCatalogoPadrao,
      sugestoesDosClientes,
      pedidosDeLoja,
      lojaNoAdmin,
      franquias,
      administradores,
      dadosDoAdmin,
      manageImplantationPipelines,
      jornadaDeEntrada,
      entregaDaLoja,
      appDoClienteDaLoja,
      formasDePagamento,
      instalacoesDosApps,
      conjuntosDeIcones,
      iconesComIa,
      aparenciaDaLoja,
      aparenciaDaHome,
      bannersNoAdmin,
      alertasDoAdmin,
      integradorDaLoja,
      sessoesWeb,
    }),
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
