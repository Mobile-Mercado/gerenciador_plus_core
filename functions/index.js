const admin = require('firebase-admin');
const {
  onDocumentCreated,
  onDocumentUpdated,
  onDocumentWritten,
} = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret, defineString } = require('firebase-functions/params');
const { getStorage } = require('firebase-admin/storage');
const { applicationDefault } = require('firebase-admin/app');
const {
  DEFAULT_SAMPLE_SIZE,
  SALES_WINDOW_DAYS,
  StorageListingError,
  configuredEstablishmentIds,
  createStorageIndex,
  createUrlChecker,
  listBucketNames,
  runEstablishmentPass,
  testAccountIdsFor,
  windowStart,
  writeSummary,
} = require('./productImageFileCheck');
const {
  loadAgentConversationData,
  summarizeConversations,
  writeAgentConversationsSummary,
} = require('./agenteConversas');
const { recalcularCategorias } = require('./categoriasContagem');
const { rodarResumoDeBuscas } = require('./buscasResumo');
const { gerarEspelho, produtosDoEspelho } = require('./catalogoEspelho');
const { registrarRotina } = require('./rotinasNoturnas');
const {
  CAMPO: CAMPO_DE_PROVEDORES,
  indiceDeUsuarios,
  rodarProvedoresDeLogin,
} = require('./provedoresDeLogin');
const { gerarListaDeClientes } = require('./clientesDaLoja');
const { lojaDaConversaDoAgente, lojasDaConversa, marcarMudanca } = require('./marcador');
const { ligarBannersAgendados, tratarBannerGravado } = require('./situacaoDoBanner');
const {
  RESUMO_COLLECTION,
  TOTAL_DE_BLOCOS,
  cadastroMudou,
  recalcularCliente,
  segmentoDoCliente,
} = require('./resumoClientes');
const { atualizarResumoDoPedido } = require('./resumoPedidos');
const { atualizarResumoDeVendas } = require('./resumoVendas');
const { atualizarSemGiro } = require('./semGiro');
const { atualizarVisitasPorMes } = require('./visitasPorMes');
const {
  atualizarTodasAsLojas,
  appsDaLoja,
  clienteDePedidos,
  doisUltimosMeses,
  leitorDaApple,
  lerSegredoOpcional,
  pedidoAppleDaLoja,
  pedirRelatoriosQueFaltam,
} = require('./instalacoesApp');
const { avisoDeMensagem, avisoDePedidoCancelado, avisoDePedidoNovo } = require('./avisos');

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();
const MAX_TOKENS_PER_REQUEST = 500;
const IMAGE_CHECK_CONFIG_PATH = 'CoreJobs/verifyProductImageFiles';
const IMAGE_CHECK_TIME_BUDGET_MS = 25 * 60 * 1000;

// Registra a origem dos produtos de cada rotina em Stats/rotinasNoturnas. Falha aqui
// nao derruba a rotina: a metrica dela ja esta gravada.
async function registrarNoite(storeRef, rotina, { origem = null, dados = {} } = {}) {
  try {
    await registrarRotina({
      storeRef,
      rotina,
      origem,
      dados,
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (error) {
    console.error('[rotinasNoturnas] Nao registrou a origem', { rotina, establishmentId: storeRef.id, error });
  }
}

const extractCompanyId = (orderDoc = {}) => {
  if (orderDoc.companyId) return orderDoc.companyId;
  const ref = orderDoc.companyReference || orderDoc.companyRef;
  if (!ref) return null;
  if (typeof ref === 'string') {
    const segments = ref.split('/');
    return segments[segments.length - 1] || null;
  }
  if (ref.id) return ref.id;
  if (ref.path) {
    const segments = ref.path.split('/');
    return segments[segments.length - 1] || null;
  }
  if (ref._path?.segments) {
    const segments = ref._path.segments;
    return segments[segments.length - 1] || null;
  }
  return null;
};

// Marcador de mudancas (estabelecimentos/{loja}/Stats/marcador). Falha aqui so deixa o
// painel um ciclo atrasado: registra e nunca lanca, para o gatilho nao entrar em repeticao.
exports.marcarPedidoNoMarcador = onDocumentWritten(
  'PurchaseRequests/{orderId}',
  async (event) => {
    try {
      const pedido = event.data?.after?.data() || event.data?.before?.data() || {};
      await marcarMudanca({
        db,
        FieldValue: admin.firestore.FieldValue,
        lojaId: extractCompanyId(pedido),
        tipo: 'pedidos',
      });
    } catch (error) {
      console.error('[marcarPedidoNoMarcador] Falha ao marcar pedido', {
        orderId: event.params.orderId,
        error,
      });
    }
  },
);

exports.marcarConversaNoMarcador = onDocumentWritten(
  'Chats/{chatId}',
  async (event) => {
    try {
      const chat = event.data?.after?.data() || event.data?.before?.data() || {};
      const lojas = await lojasDaConversa({ db, chat });
      await Promise.all(lojas.map((lojaId) => marcarMudanca({
        db,
        FieldValue: admin.firestore.FieldValue,
        lojaId,
        tipo: 'conversas',
      })));
    } catch (error) {
      console.error('[marcarConversaNoMarcador] Falha ao marcar conversa', {
        chatId: event.params.chatId,
        error,
      });
    }
  },
);

exports.marcarMensagemNoMarcador = onDocumentCreated(
  'Chats/{chatId}/Messages/{messageId}',
  async (event) => {
    try {
      const chat = await db.collection('Chats').doc(event.params.chatId).get();
      const lojas = await lojasDaConversa({ db, chat: chat.data() || {} });
      await Promise.all(lojas.map((lojaId) => marcarMudanca({
        db,
        FieldValue: admin.firestore.FieldValue,
        lojaId,
        tipo: 'conversas',
      })));
    } catch (error) {
      console.error('[marcarMensagemNoMarcador] Falha ao marcar mensagem', {
        chatId: event.params.chatId,
        messageId: event.params.messageId,
        error,
      });
    }
  },
);

// Conversas do agente: a loja vem do companyId da conversa, nao de participantes.
exports.marcarConversaDoAgenteNoMarcador = onDocumentWritten(
  'AgenteVendas/{userId}/conversas/{conversationId}',
  async (event) => {
    try {
      const lojaId = lojaDaConversaDoAgente({
        antes: event.data?.before?.data() || null,
        depois: event.data?.after?.data() || null,
      });
      if (!lojaId) return;
      await marcarMudanca({
        db,
        FieldValue: admin.firestore.FieldValue,
        lojaId,
        tipo: 'conversas',
      });
    } catch (error) {
      console.error('[marcarConversaDoAgenteNoMarcador] Falha ao marcar conversa do agente', {
        userId: event.params.userId,
        conversationId: event.params.conversationId,
        error,
      });
    }
  },
);

// Banners da loja (estabelecimentos/{loja}/Banners/{id}), de qualquer origem: criado ou atualizado com
// status true e inicio no futuro passa a aguardar o inicio (o app do cliente nao olha startAt); toda
// gravacao, inclusive a remocao, marca 'banners' para a tela Loja reler. A normalizacao grava status
// false, entao a passada seguinte nao grava de novo (sem laco). Registra e nunca lanca.
exports.ajustarBannerGravado = onDocumentWritten(
  'estabelecimentos/{lojaId}/Banners/{bannerId}',
  async (event) => {
    const { lojaId, bannerId } = event.params;
    try {
      const depois = event.data?.after?.exists ? event.data.after.data() : null;
      await tratarBannerGravado({
        lojaId,
        referencia: event.data?.after?.ref,
        depois,
        marcar: (loja) => marcarMudanca({
          db,
          FieldValue: admin.firestore.FieldValue,
          lojaId: loja,
          tipo: 'banners',
        }),
        aoFalhar: (etapa, error) => console.error('[ajustarBannerGravado] Falha ao normalizar', { lojaId, bannerId, etapa, error }),
      });
    } catch (error) {
      console.error('[ajustarBannerGravado] Falha ao marcar banner', { lojaId, bannerId, error });
    }
  },
);

// A cada 5 minutos liga os banners que aguardavam o inicio (aguardandoInicio true e startAt ja
// passado). A gravacao passa pelo ajustarBannerGravado, que marca 'banners' na loja. Indice:
// Banners (collection group) aguardandoInicio + startAt, em firestore.indexes.json.
exports.ligarBannersAgendados = onSchedule(
  {
    schedule: 'every 5 minutes',
    timeZone: 'America/Sao_Paulo',
    region: 'us-central1',
    memory: '256MiB',
    timeoutSeconds: 120,
    retryCount: 0,
  },
  async () => {
    try {
      const resultado = await ligarBannersAgendados({
        db,
        agora: new Date(),
        aoFalhar: (caminho, error) => console.error('[ligarBannersAgendados] Falha ao ligar', { caminho, error }),
      });
      const lojas = [];
      for (const [establishmentId, { storeRef, ligados }] of resultado.porLoja) {
        lojas.push({ establishmentId, ligados });
        await registrarNoite(storeRef, 'ligarBannersAgendados', { dados: { bannersLigados: ligados } });
      }
      if (lojas.length) console.log('[ligarBannersAgendados] Banners ligados', { lidos: resultado.lidos, lojas });
      return { lidos: resultado.lidos, lojas };
    } catch (error) {
      console.error('[ligarBannersAgendados] Falha na passada', { error });
      return null;
    }
  },
);

exports.marcarMensagemDoAgenteNoMarcador = onDocumentCreated(
  'AgenteVendas/{userId}/conversas/{conversationId}/mensagens/{messageId}',
  async (event) => {
    try {
      const conversa = await db
        .collection('AgenteVendas').doc(event.params.userId)
        .collection('conversas').doc(event.params.conversationId)
        .get();
      const lojaId = lojaDaConversaDoAgente({ depois: conversa.exists ? conversa.data() : null });
      if (!lojaId) return;
      await marcarMudanca({
        db,
        FieldValue: admin.firestore.FieldValue,
        lojaId,
        tipo: 'conversas',
      });
    } catch (error) {
      console.error('[marcarMensagemDoAgenteNoMarcador] Falha ao marcar mensagem do agente', {
        userId: event.params.userId,
        conversationId: event.params.conversationId,
        messageId: event.params.messageId,
        error,
      });
    }
  },
);

// Resumo de vendas por mes (estabelecimentos/{loja}/ResumoVendas/{AAAA-MM}), lido pela
// Home e pelo Financeiro no lugar dos pedidos inteiros. Substitui a aggregateOrderHourlySales,
// que nunca foi publicada. Falha aqui deixa a venda fora da soma ate a proxima gravacao do
// pedido: registra e nunca lanca.
exports.resumirVendasDoPedido = onDocumentWritten(
  'PurchaseRequests/{orderId}',
  async (event) => {
    try {
      await atualizarResumoDeVendas({
        db,
        FieldValue: admin.firestore.FieldValue,
        antes: event.data?.before?.data() || null,
        depois: event.data?.after?.data() || null,
        pedidoId: event.params.orderId,
        lojaDe: extractCompanyId,
      });
    } catch (error) {
      console.error('[resumirVendasDoPedido] Falha ao resumir vendas', {
        orderId: event.params.orderId,
        error,
      });
    }
  },
);

// Resumo dos pedidos por mes (estabelecimentos/{loja}/ResumoPedidos/{AAAA-MM} e abertos),
// lido pela tela Pedidos no lugar do stream de todos os pedidos. Falha aqui deixa o
// pedido desatualizado na lista ate a proxima mudanca: registra e nunca lanca.
exports.resumirPedidoNaLista = onDocumentWritten(
  'PurchaseRequests/{orderId}',
  async (event) => {
    try {
      await atualizarResumoDoPedido({
        db,
        FieldValue: admin.firestore.FieldValue,
        antes: event.data?.before?.data() || null,
        depois: event.data?.after?.data() || null,
        pedidoId: event.params.orderId,
        lojaDe: extractCompanyId,
      });
    } catch (error) {
      console.error('[resumirPedidoNaLista] Falha ao resumir pedido', {
        orderId: event.params.orderId,
        error,
      });
    }
  },
);

// Resumo por cliente (estabelecimentos/{loja}/ResumoClientes/{bloco}). Os gatilhos
// recalculam so o cliente tocado; o segmento fica com segmentarClientesNightly. Falha aqui
// deixa o cliente desatualizado ate a proxima mudanca: registra e nunca lanca.
exports.resumirClienteDoPedido = onDocumentWritten(
  'PurchaseRequests/{orderId}',
  async (event) => {
    try {
      // Antes e depois: pedido que trocou de cliente ou de loja recalcula as duas pontas.
      const pares = new Map();
      [event.data?.before?.data(), event.data?.after?.data()].forEach((pedido) => {
        const lojaId = pedido ? extractCompanyId(pedido) : null;
        const clienteId = pedido?.clientId ? String(pedido.clientId) : '';
        if (lojaId && clienteId) pares.set(`${lojaId}|${clienteId}`, { lojaId: String(lojaId), clienteId });
      });
      for (const { lojaId, clienteId } of pares.values()) {
        await recalcularCliente({ db, FieldValue: admin.firestore.FieldValue, lojaId, clienteId });
      }
    } catch (error) {
      console.error('[resumirClienteDoPedido] Falha ao resumir cliente', {
        orderId: event.params.orderId,
        error,
      });
    }
  },
);

exports.resumirClienteDoCadastro = onDocumentWritten(
  'Users/{userId}',
  async (event) => {
    try {
      if (!cadastroMudou(event.data?.before?.data(), event.data?.after?.data())) return;
      const { userId } = event.params;
      const pedidos = await db.collection('PurchaseRequests')
        .where('clientId', '==', userId)
        .select('companyId', 'companyReference', 'companyRef')
        .get();
      const lojas = new Set(pedidos.docs.map((doc) => extractCompanyId(doc.data())).filter(Boolean).map(String));
      for (const lojaId of lojas) {
        await recalcularCliente({ db, FieldValue: admin.firestore.FieldValue, lojaId, clienteId: userId });
      }
    } catch (error) {
      console.error('[resumirClienteDoCadastro] Falha ao resumir cliente', {
        userId: event.params.userId,
        error,
      });
    }
  },
);

const chunkArray = (items, size) => {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

// Envio de Web Push para todos os navegadores ativos da loja (FcmTokens com
// clientId == loja e active == true), em blocos de MAX_TOKENS_PER_REQUEST. Token que o
// FCM recusa como invalido e desativado. Vai so como dados: o Service Worker do painel
// monta a notificacao visivel com title, body, tag e url. O valor do token nunca vai
// para o log (AGENTS.md).
async function enviarAvisoParaLoja({
  companyId,
  title,
  body,
  url,
  tag,
  data = {},
  origem = 'enviarAvisoParaLoja',
}) {
  const tokenDocsSnap = await db
    .collection('FcmTokens')
    .where('clientId', '==', companyId)
    .where('active', '==', true)
    .get();

  if (tokenDocsSnap.empty) {
    console.log(`[${origem}] Nenhum token ativo para ${companyId}`);
    return null;
  }

  const tokenEntries = tokenDocsSnap.docs
    .map((doc) => ({
      token: String(doc.data().token || doc.id || '').trim(),
      ref: doc.ref
    }))
    .filter((entry) => entry.token);

  console.log(`[${origem}] ${tokenEntries.length} tokens encontrados`);

  const buildMessagePayload = (targetTokens) => ({
    data: {
      ...data,
      companyId,
      url,
      title,
      body,
      icon: '/favicon.ico',
      tag,
      timestamp: new Date().toISOString()
    },
    webpush: {
      headers: {
        Urgency: 'high'
      },
      fcmOptions: {
        link: url
      }
    },
    tokens: targetTokens
  });

  let totalSuccess = 0;
  let totalFailures = 0;
  const cleanupPromises = [];

  const tokenChunks = chunkArray(tokenEntries, MAX_TOKENS_PER_REQUEST);

  for (const chunk of tokenChunks) {
    const chunkTokens = chunk.map((entry) => entry.token);
    const message = buildMessagePayload(chunkTokens);

    try {
      const response = await admin.messaging().sendEachForMulticast(message);
      totalSuccess += response.successCount;
      totalFailures += response.failureCount;

      response.responses.forEach((resp, idx) => {
        if (resp.success) return;
        const errorCode = resp.error?.code || 'unknown';
        const failedEntry = chunk[idx];

        console.warn(`[${origem}] Erro no token ${failedEntry.ref.id.slice(0, 8)}…: ${errorCode}`);

        if (
          errorCode === 'messaging/registration-token-not-registered' ||
          errorCode === 'messaging/invalid-registration-token' ||
          errorCode === 'messaging/invalid-argument'
        ) {
          cleanupPromises.push(
            failedEntry.ref.update({ active: false }).catch((err) => {
              console.error(`[${origem}] Falha ao desativar token`, err);
            })
          );
        }
      });
    } catch (chunkError) {
      console.error(`[${origem}] Erro ao enviar chunk de tokens`, chunkError);
    }
  }

  if (cleanupPromises.length) {
    await Promise.all(cleanupPromises);
    console.log(
      `[${origem}] ${cleanupPromises.length} tokens inválidos desativados`
    );
  }

  console.log(
    `[${origem}] Envio concluído. Sucessos: ${totalSuccess}, Falhas: ${totalFailures}`
  );

  return { totalSuccess, totalFailures };
}

exports.sendOrderNotification = onDocumentCreated(
  'PurchaseRequests/{orderId}',
  async (event) => {
    const snap = event.data;
    if (!snap) {
      console.warn('[sendOrderNotification] Evento sem dados');
      return null;
    }

    const order = snap.data();
    const orderId = event.params.orderId;

    if (!order) {
      console.warn('[sendOrderNotification] Documento vazio', orderId);
      return null;
    }

    const companyId = extractCompanyId(order);
    if (!companyId) {
      console.warn('[sendOrderNotification] Pedido sem referência de empresa', orderId);
      return null;
    }

    console.log(`[sendOrderNotification] Processando pedido ${orderId} da empresa ${companyId}`);

    const { title, body, orderNumber, clientName } = avisoDePedidoNovo(order);

    return enviarAvisoParaLoja({
      companyId,
      title,
      body,
      url: '/pedidos',
      tag: orderId,
      data: {
        orderId,
        orderNumber: orderNumber || '',
        clientName,
      },
      origem: 'sendOrderNotification',
    });
  }
);

// Mensagem nova do cliente no chat. Mensagem da loja nao avisa. Mensagens do mesmo chat
// usam a mesma tag e se agrupam numa notificacao so.
exports.avisarMensagemNova = onDocumentCreated(
  'Chats/{chatId}/Messages/{messageId}',
  async (event) => {
    try {
      const mensagem = event.data?.data();
      if (!mensagem) return;
      const chatSnapshot = await db.collection('Chats').doc(event.params.chatId).get();
      const chat = chatSnapshot.data() || {};
      const lojas = await lojasDaConversa({ db, chat });
      for (const lojaId of lojas) {
        const aviso = avisoDeMensagem({
          chat, mensagem, chatId: event.params.chatId, lojaId, lojasDoChat: lojas,
        });
        if (!aviso) continue;
        await enviarAvisoParaLoja({ companyId: lojaId, ...aviso, origem: 'avisarMensagemNova' });
      }
    } catch (error) {
      console.error('[avisarMensagemNova] Falha ao avisar mensagem', {
        chatId: event.params.chatId,
        messageId: event.params.messageId,
        error,
      });
    }
  },
);

// Pedido cancelado pelo cliente: so quando o status passa para a desistencia.
exports.avisarPedidoCancelado = onDocumentUpdated(
  'PurchaseRequests/{orderId}',
  async (event) => {
    try {
      const antes = event.data?.before?.data() || {};
      const depois = event.data?.after?.data() || {};
      const aviso = avisoDePedidoCancelado({ antes, depois, pedidoId: event.params.orderId });
      if (!aviso) return;
      const companyId = extractCompanyId(depois);
      if (!companyId) return;
      await enviarAvisoParaLoja({ companyId, ...aviso, origem: 'avisarPedidoCancelado' });
    } catch (error) {
      console.error('[avisarPedidoCancelado] Falha ao avisar cancelamento', {
        orderId: event.params.orderId,
        error,
      });
    }
  },
);

// Pedidos da maior janela de vendas; o corte entre 30 e 90 dias e feito depois,
// em memoria. Usa o indice composto companyReference + createdAt que ja existe.
async function loadStoreOrders(storeRef) {
  const since = new Date(windowStart(Math.max(...Object.values(SALES_WINDOW_DAYS))));
  const snapshot = await db
    .collection('PurchaseRequests')
    .where('companyReference', '==', storeRef)
    .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(since))
    .get();
  return snapshot.docs.map((orderDocument) => orderDocument.data());
}

// Resultado vai so para estabelecimentos/{id}/Stats/imageFileCheck e a subcolecao
// lists: nenhum produto e gravado, entao o produtosModule-onProductUpdate nunca
// dispara por causa dela.
exports.verifyProductImageFilesNightly = onSchedule(
  {
    schedule: '0 3 * * *',
    timeZone: 'America/Sao_Paulo',
    region: 'us-central1',
    memory: '512MiB',
    timeoutSeconds: 1800,
    retryCount: 0,
  },
  async () => {
    const startedAt = Date.now();
    const configSnapshot = await db.doc(IMAGE_CHECK_CONFIG_PATH).get();
    const configuredIds = configuredEstablishmentIds(configSnapshot.data());
    if (!configuredIds.length) {
      console.log('[verifyProductImageFilesNightly] Nenhuma loja habilitada em', IMAGE_CHECK_CONFIG_PATH);
      return;
    }

    // As lojas vem so da lista em CoreJobs, sem filtro por isActive: ID que nao
    // existe em estabelecimentos fica registrado e a passada segue.
    const storeSnapshots = await db.getAll(
      ...configuredIds.map((id) => db.collection('estabelecimentos').doc(id)),
    );
    const report = storeSnapshots
      .filter((snapshot) => !snapshot.exists)
      .map((snapshot) => ({ establishmentId: snapshot.id, status: 'inexistente' }));
    const storeIds = storeSnapshots
      .filter((snapshot) => snapshot.exists)
      .map((snapshot) => snapshot.id);
    if (!storeIds.length) {
      console.log('[verifyProductImageFilesNightly] Nenhuma loja da lista existe', { lojas: report });
      return { lojas: report };
    }

    const index = createStorageIndex({
      listNames: (bucketName, prefix) => listBucketNames(getStorage().bucket(bucketName), prefix),
    });
    // Listagem antes de qualquer loja: se falhar, nenhum resumo e gravado nesta noite.
    await index.preload(getStorage().bucket().name);

    const checker = createUrlChecker();
    const sampleSize = Math.max(1, Math.ceil(DEFAULT_SAMPLE_SIZE / storeIds.length));

    for (const establishmentId of storeIds) {
      if (Date.now() - startedAt > IMAGE_CHECK_TIME_BUDGET_MS) {
        report.push({ establishmentId, status: 'adiada' });
        continue;
      }
      const storeRef = db.collection('estabelecimentos').doc(establishmentId);
      try {
        const espelho = await produtosDoEspelho({ storeRef });
        const summary = await runEstablishmentPass({
          storeRef,
          documentIdPath: admin.firestore.FieldPath.documentId(),
          index,
          checker,
          sampleSize,
          mirroredProducts: espelho.produtos,
          loadOrders: () => loadStoreOrders(storeRef),
          loadTestAccountIds: (orders) => testAccountIdsFor(db, orders),
        });
        await writeSummary({
          storeRef,
          summary,
          checkedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        // Contagem por categoria e subcategoria: grava so em Stats/categoriasContagem.
        const contagem = await recalcularCategorias({
          storeRef,
          geradoEm: admin.firestore.FieldValue.serverTimestamp(),
        });
        report.push({
          establishmentId,
          origemDosProdutos: espelho.origemDosProdutos,
          produtosAVenda: summary.produtosAVenda,
          vendas30: summary.vendas30,
          semFoto: summary.semFoto,
          semFotoAVenda: summary.semFotoAVenda,
          semTag: summary.semTag,
          semCategoria: summary.semCategoria,
          metodo: summary.metodo,
          categorias: contagem.categorias,
          subcategorias: contagem.subcategorias,
        });
        await registrarNoite(storeRef, 'verifyProductImageFilesNightly', { origem: espelho.origemDosProdutos });
      } catch (error) {
        if (error instanceof StorageListingError) throw error;
        console.error('[verifyProductImageFilesNightly] Falha na loja', { establishmentId, error });
        report.push({ establishmentId, status: 'falhou' });
      }
    }

    const result = {
      lojas: report,
      ...index.stats(),
      ...checker.stats(),
      segundos: Math.round((Date.now() - startedAt) / 1000),
    };
    console.log('[verifyProductImageFilesNightly] Passada concluida', result);
    return result;
  },
);

// Resumo das conversas do agente por loja, em estabelecimentos/{id}/Stats/agenteConversas.
// Mesmas lojas e horario da rotina de imagens. Guarda so termos e contagens.
exports.summarizeAgentConversationsNightly = onSchedule(
  {
    schedule: '0 3 * * *',
    timeZone: 'America/Sao_Paulo',
    region: 'us-central1',
    memory: '512MiB',
    timeoutSeconds: 1800,
    retryCount: 0,
  },
  async () => {
    const startedAt = Date.now();
    const configSnapshot = await db.doc(IMAGE_CHECK_CONFIG_PATH).get();
    const configuredIds = configuredEstablishmentIds(configSnapshot.data());
    if (!configuredIds.length) {
      console.log('[summarizeAgentConversationsNightly] Nenhuma loja habilitada em', IMAGE_CHECK_CONFIG_PATH);
      return;
    }

    const storeSnapshots = await db.getAll(
      ...configuredIds.map((id) => db.collection('estabelecimentos').doc(id)),
    );
    const report = storeSnapshots
      .filter((snapshot) => !snapshot.exists)
      .map((snapshot) => ({ establishmentId: snapshot.id, status: 'inexistente' }));

    for (const snapshot of storeSnapshots.filter((store) => store.exists)) {
      const establishmentId = snapshot.id;
      if (Date.now() - startedAt > IMAGE_CHECK_TIME_BUDGET_MS) {
        report.push({ establishmentId, status: 'adiada' });
        continue;
      }
      try {
        const espelho = await produtosDoEspelho({ storeRef: snapshot.ref });
        const data = await loadAgentConversationData({
          db,
          storeRef: snapshot.ref,
          documentIdPath: admin.firestore.FieldPath.documentId(),
          testAccountIdsFor,
          mirroredProducts: espelho.produtos,
        });
        const summary = summarizeConversations(data);
        await writeAgentConversationsSummary({
          storeRef: snapshot.ref,
          summary,
          generatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        report.push({
          establishmentId,
          origemDosProdutos: espelho.origemDosProdutos,
          conversas: summary.conversas,
          pedidosDeProduto: summary.pedidosDeProduto,
          termos: summary.termos.length,
          pedidos: summary.pedidos,
        });
        await registrarNoite(snapshot.ref, 'summarizeAgentConversationsNightly', { origem: espelho.origemDosProdutos });
      } catch (error) {
        console.error('[summarizeAgentConversationsNightly] Falha na loja', { establishmentId, error });
        report.push({ establishmentId, status: 'falhou' });
      }
    }

    const result = { lojas: report, segundos: Math.round((Date.now() - startedAt) / 1000) };
    console.log('[summarizeAgentConversationsNightly] Passada concluida', result);
    return result;
  },
);

// Resumo das buscas do app do dia anterior, por loja, em Stats/buscasResumo e na
// subcolecao dias. Independente da rotina do agente: nao toca nos documentos dela.
exports.summarizeProductSearchesNightly = onSchedule(
  {
    schedule: '0 3 * * *',
    timeZone: 'America/Sao_Paulo',
    region: 'us-central1',
    memory: '512MiB',
    timeoutSeconds: 1800,
    retryCount: 0,
  },
  async () => {
    const startedAt = Date.now();
    const configSnapshot = await db.doc(IMAGE_CHECK_CONFIG_PATH).get();
    const configuredIds = configuredEstablishmentIds(configSnapshot.data());
    if (!configuredIds.length) {
      console.log('[summarizeProductSearchesNightly] Nenhuma loja habilitada em', IMAGE_CHECK_CONFIG_PATH);
      return;
    }

    const storeSnapshots = await db.getAll(
      ...configuredIds.map((id) => db.collection('estabelecimentos').doc(id)),
    );
    const report = storeSnapshots
      .filter((snapshot) => !snapshot.exists)
      .map((snapshot) => ({ establishmentId: snapshot.id, status: 'inexistente' }));

    // Indice de Users montado uma vez por passada e reaproveitado nas quatro lojas:
    // Users e colecao da raiz, nao da loja.
    const usuarios = await db.collection('Users').select('userAuthId', 'whitelabelId').get();
    const indiceDeUsers = indiceDeUsuarios(usuarios.docs);

    for (const snapshot of storeSnapshots.filter((store) => store.exists)) {
      const establishmentId = snapshot.id;
      if (Date.now() - startedAt > IMAGE_CHECK_TIME_BUDGET_MS) {
        report.push({ establishmentId, status: 'adiada' });
        continue;
      }
      try {
        const espelho = await produtosDoEspelho({ storeRef: snapshot.ref });
        const resultado = await rodarResumoDeBuscas({
          storeRef: snapshot.ref,
          documentIdPath: admin.firestore.FieldPath.documentId(),
          atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
          mirroredProducts: espelho.produtos,
          indiceDeUsuarios: indiceDeUsers,
          marcaDaLoja: snapshot.get('whitelabelId') || null,
          // Pedidos do dia da loja, para o cruzamento de conversao.
          carregarPedidos: ({ inicio, fim }) => db
            .collection('PurchaseRequests')
            .where('companyReference', '==', snapshot.ref)
            .where('createdAt', '>=', inicio)
            .where('createdAt', '<', fim)
            .get()
            .then((pedidos) => pedidos.docs.map((pedido) => pedido.data())),
          testAccountIdsFor: (pedidos) => testAccountIdsFor(db, pedidos),
        });
        report.push({ establishmentId, origemDoEspelho: espelho.origemDosProdutos, ...resultado });
        await registrarNoite(snapshot.ref, 'summarizeProductSearchesNightly', {
          origem: espelho.origemDosProdutos,
          dados: { dia: resultado.dia, buscas: resultado.buscas, catalogoLido: resultado.catalogoLido },
        });
      } catch (error) {
        console.error('[summarizeProductSearchesNightly] Falha na loja', { establishmentId, error });
        report.push({ establishmentId, status: 'falhou' });
      }
    }

    const result = { lojas: report, segundos: Math.round((Date.now() - startedAt) / 1000) };
    console.log('[summarizeProductSearchesNightly] Passada concluida', result);
    return result;
  },
);

// Espelho do catalogo: uma varredura de Products por loja, as 2h, lida pelas tres
// rotinas das 3h. A hora de folga cobre instancia a frio e crescimento do catalogo; se o
// espelho nao ficar pronto, as tres caem no recuo e leem Products direto, como antes.
exports.mirrorProductCatalogNightly = onSchedule(
  {
    schedule: '0 2 * * *',
    timeZone: 'America/Sao_Paulo',
    region: 'us-central1',
    memory: '512MiB',
    timeoutSeconds: 1800,
    retryCount: 0,
  },
  async () => {
    const startedAt = Date.now();
    const configSnapshot = await db.doc(IMAGE_CHECK_CONFIG_PATH).get();
    const configuredIds = configuredEstablishmentIds(configSnapshot.data());
    if (!configuredIds.length) {
      console.log('[mirrorProductCatalogNightly] Nenhuma loja habilitada em', IMAGE_CHECK_CONFIG_PATH);
      return;
    }

    const storeSnapshots = await db.getAll(
      ...configuredIds.map((id) => db.collection('estabelecimentos').doc(id)),
    );
    const report = storeSnapshots
      .filter((snapshot) => !snapshot.exists)
      .map((snapshot) => ({ establishmentId: snapshot.id, status: 'inexistente' }));

    for (const snapshot of storeSnapshots.filter((store) => store.exists)) {
      const establishmentId = snapshot.id;
      if (Date.now() - startedAt > IMAGE_CHECK_TIME_BUDGET_MS) {
        report.push({ establishmentId, status: 'adiada' });
        continue;
      }
      try {
        const resultado = await gerarEspelho({
          storeRef: snapshot.ref,
          documentIdPath: admin.firestore.FieldPath.documentId(),
          geradoEm: admin.firestore.FieldValue.serverTimestamp(),
        });
        report.push({ establishmentId, ...resultado });
        await registrarNoite(snapshot.ref, 'mirrorProductCatalogNightly', {
          dados: { produtos: resultado.total, blocos: resultado.blocos },
        });
      } catch (error) {
        console.error('[mirrorProductCatalogNightly] Falha na loja', { establishmentId, error });
        report.push({ establishmentId, status: 'falhou' });
      }
    }

    const result = { lojas: report, segundos: Math.round((Date.now() - startedAt) / 1000) };
    console.log('[mirrorProductCatalogNightly] Passada concluida', result);
    return result;
  },
);

// Provedor de login de cada conta, copiado do Authentication para Users. Roda a 1h, antes
// do espelho das 2h e das tres rotinas das 3h, numa faixa vazia: nao depende de nenhuma e
// nenhuma depende dela. Relatorio unico, por projeto: Users e colecao da raiz e o
// Authentication e do projeto inteiro, sem recorte por loja.
exports.syncLoginProvidersNightly = onSchedule(
  {
    schedule: '0 1 * * *',
    timeZone: 'America/Sao_Paulo',
    region: 'us-central1',
    memory: '512MiB',
    timeoutSeconds: 1800,
    retryCount: 0,
  },
  async () => {
    const startedAt = Date.now();
    const resumo = await rodarProvedoresDeLogin({
      listarContas: async ({ pageToken, maximo }) => {
        const pagina = await admin.auth().listUsers(maximo, pageToken);
        return { contas: pagina.users, pageToken: pagina.pageToken };
      },
      // Uma leitura por documento de Users, uma vez por passada.
      lerUsuarios: async () => {
        const snapshot = await db.collection('Users').select('userAuthId', CAMPO_DE_PROVEDORES).get();
        return snapshot.docs;
      },
      gravar: ({ id, provedores }) => db
        .collection('Users')
        .doc(id)
        .set({ [CAMPO_DE_PROVEDORES]: provedores }, { merge: true }),
    });

    const result = { ...resumo, segundos: Math.round((Date.now() - startedAt) / 1000) };
    console.log('[syncLoginProvidersNightly] Passada concluida', result);
    return result;
  },
);

// Lista de clientes de cada loja, as 1h30, entre a dos provedores e o espelho. A politica
// de acesso le este documento no lugar de varrer PurchaseRequests a cada renovacao de
// cache. A lista so cresce: id nunca sai dela.
exports.listStoreCustomersNightly = onSchedule(
  {
    schedule: '30 1 * * *',
    timeZone: 'America/Sao_Paulo',
    region: 'us-central1',
    memory: '512MiB',
    timeoutSeconds: 1800,
    retryCount: 0,
  },
  async () => {
    const startedAt = Date.now();
    const configSnapshot = await db.doc(IMAGE_CHECK_CONFIG_PATH).get();
    const configuredIds = configuredEstablishmentIds(configSnapshot.data());
    if (!configuredIds.length) {
      console.log('[listStoreCustomersNightly] Nenhuma loja habilitada em', IMAGE_CHECK_CONFIG_PATH);
      return;
    }

    const storeSnapshots = await db.getAll(
      ...configuredIds.map((id) => db.collection('estabelecimentos').doc(id)),
    );
    const report = storeSnapshots
      .filter((snapshot) => !snapshot.exists)
      .map((snapshot) => ({ establishmentId: snapshot.id, status: 'inexistente' }));

    // Traducao de uid para id de documento: indice montado uma vez e reaproveitado nas
    // quatro lojas. Users e colecao da raiz.
    const usuarios = await db.collection('Users').select('userAuthId', 'whitelabelId').get();
    const indiceDeUsers = indiceDeUsuarios(usuarios.docs);

    for (const snapshot of storeSnapshots.filter((store) => store.exists)) {
      const establishmentId = snapshot.id;
      if (Date.now() - startedAt > IMAGE_CHECK_TIME_BUDGET_MS) {
        report.push({ establishmentId, status: 'adiada' });
        continue;
      }
      try {
        const resultado = await gerarListaDeClientes({
          db,
          storeRef: snapshot.ref,
          geradoEm: admin.firestore.FieldValue.serverTimestamp(),
          indiceDeUsuarios: indiceDeUsers,
          marcaDaLoja: snapshot.get('whitelabelId') || null,
        });
        report.push({ establishmentId, ...resultado });
        await registrarNoite(snapshot.ref, 'listStoreCustomersNightly', {
          dados: {
            clientes: resultado.total,
            novos: resultado.novos,
            blocos: resultado.blocos,
            traduzidos: resultado.traduzidos,
            ambiguos: resultado.ambiguos,
            inexistentes: resultado.inexistentes,
          },
        });
      } catch (error) {
        console.error('[listStoreCustomersNightly] Falha na loja', { establishmentId, error });
        report.push({ establishmentId, status: 'falhou' });
      }
    }

    const result = { lojas: report, segundos: Math.round((Date.now() - startedAt) / 1000) };
    console.log('[listStoreCustomersNightly] Passada concluida', result);
    return result;
  },
);

// Segmento de cada cliente, pela regua do painel, em Users.segmento e no bloco do resumo.
// Roda de madrugada porque o segmento depende do LTV medio da loja e dos dias desde a
// ultima compra, que mudam sem nenhum pedido novo.
exports.segmentarClientesNightly = onSchedule(
  {
    schedule: '45 1 * * *',
    timeZone: 'America/Sao_Paulo',
    region: 'us-central1',
    memory: '512MiB',
    timeoutSeconds: 1800,
    retryCount: 0,
  },
  async () => {
    try {
      const startedAt = Date.now();
      const agora = new Date();
      const configSnapshot = await db.doc(IMAGE_CHECK_CONFIG_PATH).get();
      const configuredIds = configuredEstablishmentIds(configSnapshot.data());
      if (!configuredIds.length) {
        console.log('[segmentarClientesNightly] Nenhuma loja habilitada em', IMAGE_CHECK_CONFIG_PATH);
        return null;
      }

      const storeSnapshots = await db.getAll(
        ...configuredIds.map((id) => db.collection('estabelecimentos').doc(id)),
      );
      const report = storeSnapshots
        .filter((snapshot) => !snapshot.exists)
        .map((snapshot) => ({ establishmentId: snapshot.id, status: 'inexistente' }));

      for (const snapshot of storeSnapshots.filter((store) => store.exists)) {
        const establishmentId = snapshot.id;
        if (Date.now() - startedAt > IMAGE_CHECK_TIME_BUDGET_MS) {
          report.push({ establishmentId, status: 'adiada' });
          continue;
        }
        try {
          const blocoRefs = Array.from({ length: TOTAL_DE_BLOCOS }, (_v, numero) => (
            snapshot.ref.collection(RESUMO_COLLECTION).doc(String(numero).padStart(2, '0'))
          ));
          const blocos = await db.getAll(...blocoRefs);
          const clientes = blocos.flatMap((bloco) => (
            Object.entries(bloco.exists ? bloco.get('clientes') || {} : {})
              .map(([chave, resumo]) => ({ bloco: bloco.ref, chave, resumo }))
          ));
          const ltvMedio = clientes.length
            ? clientes.reduce((soma, { resumo }) => soma + (Number(resumo.ltv) || 0), 0) / clientes.length
            : 0;

          let mudaram = 0;
          let semCadastro = 0;
          for (const { bloco, chave, resumo } of clientes) {
            const segmento = segmentoDoCliente({ resumo, ltvMedio, agora });
            if (segmento === resumo.segmento) continue;
            if (resumo.userId) {
              try {
                await db.collection('Users').doc(resumo.userId).update({ segmento });
              } catch (error) {
                // NOT_FOUND: cliente sem documento em Users. Nao cria; o bloco segue com o segmento.
                if (error?.code !== 5) throw error;
                semCadastro += 1;
                console.log('[segmentarClientesNightly] Cliente sem Users', { establishmentId, userId: resumo.userId });
              }
            }
            await bloco.set({ clientes: { [chave]: { segmento } } }, { merge: true });
            mudaram += 1;
          }
          // Uma marca por loja, so quando algum segmento mudou: a tela Clientes rele os blocos.
          if (mudaram > 0) {
            await marcarMudanca({
              db,
              FieldValue: admin.firestore.FieldValue,
              lojaId: establishmentId,
              tipo: 'clientes',
            });
          }

          report.push({ establishmentId, clientes: clientes.length, mudaram, semCadastro });
          await registrarNoite(snapshot.ref, 'segmentarClientesNightly', {
            dados: { clientes: clientes.length, segmentosMudaram: mudaram, semCadastro },
          });
        } catch (error) {
          console.error('[segmentarClientesNightly] Falha na loja', { establishmentId, error });
          report.push({ establishmentId, status: 'falhou' });
        }
      }

      const result = { lojas: report, segundos: Math.round((Date.now() - startedAt) / 1000) };
      console.log('[segmentarClientesNightly] Passada concluida', result);
      return result;
    } catch (error) {
      console.error('[segmentarClientesNightly] Falha na passada', { error });
      return null;
    }
  },
);

// Lista "Sem giro" do Financeiro (Stats/semGiro): produtos ativos sem venda no mes atual
// e no anterior, pela regra do painel. Roda depois do espelho (02:00) para a lista sair
// do catalogo da noite.
exports.semGiroNightly = onSchedule(
  {
    schedule: '15 2 * * *',
    timeZone: 'America/Sao_Paulo',
    region: 'us-central1',
    memory: '512MiB',
    timeoutSeconds: 1800,
    retryCount: 0,
  },
  async () => {
    try {
      const startedAt = Date.now();
      const agora = new Date();
      const configSnapshot = await db.doc(IMAGE_CHECK_CONFIG_PATH).get();
      const configuredIds = configuredEstablishmentIds(configSnapshot.data());
      if (!configuredIds.length) {
        console.log('[semGiroNightly] Nenhuma loja habilitada em', IMAGE_CHECK_CONFIG_PATH);
        return null;
      }

      const storeSnapshots = await db.getAll(
        ...configuredIds.map((id) => db.collection('estabelecimentos').doc(id)),
      );
      const report = storeSnapshots
        .filter((snapshot) => !snapshot.exists)
        .map((snapshot) => ({ establishmentId: snapshot.id, status: 'inexistente' }));

      for (const snapshot of storeSnapshots.filter((store) => store.exists)) {
        const establishmentId = snapshot.id;
        if (Date.now() - startedAt > IMAGE_CHECK_TIME_BUDGET_MS) {
          report.push({ establishmentId, status: 'adiada' });
          continue;
        }
        try {
          const resultado = await atualizarSemGiro({
            db,
            FieldValue: admin.firestore.FieldValue,
            lojaId: establishmentId,
            agora,
          });
          report.push({ establishmentId, total: resultado.total, catalogo: resultado.catalogo });
          await registrarNoite(snapshot.ref, 'semGiroNightly', {
            dados: { semGiro: resultado.total, catalogo: resultado.catalogo, meses: resultado.meses.join(',') },
          });
        } catch (error) {
          console.error('[semGiroNightly] Falha na loja', { establishmentId, error });
          report.push({ establishmentId, status: 'falhou' });
        }
      }

      const result = { lojas: report, segundos: Math.round((Date.now() - startedAt) / 1000) };
      console.log('[semGiroNightly] Passada concluida', result);
      return result;
    } catch (error) {
      console.error('[semGiroNightly] Falha na passada', { error });
      return null;
    }
  },
);

// Visitas por mes (Stats/visitasPorMes) para o grafico "Visitas e pedidos" da tela Financas nos
// periodos Ano e Desde o inicio. Semanal, segunda as 02:45 (decisao de 16/10/2026): recalcula do zero o mes
// atual e o anterior (ate 62 dias do DailyStats por loja, pelo id) e grava por cima desses dois meses.
// O painel pega o mes atual e o anterior dos 60 dias do DailyStats que ja le.
exports.visitasPorMesNightly = onSchedule(
  {
    schedule: '45 2 * * 1',
    timeZone: 'America/Sao_Paulo',
    region: 'us-central1',
    memory: '256MiB',
    timeoutSeconds: 540,
    retryCount: 0,
  },
  async () => {
    try {
      const startedAt = Date.now();
      const agora = new Date();
      const configSnapshot = await db.doc(IMAGE_CHECK_CONFIG_PATH).get();
      const configuredIds = configuredEstablishmentIds(configSnapshot.data());
      if (!configuredIds.length) {
        console.log('[visitasPorMesNightly] Nenhuma loja habilitada em', IMAGE_CHECK_CONFIG_PATH);
        return null;
      }

      const storeSnapshots = await db.getAll(
        ...configuredIds.map((id) => db.collection('estabelecimentos').doc(id)),
      );
      const report = storeSnapshots
        .filter((snapshot) => !snapshot.exists)
        .map((snapshot) => ({ establishmentId: snapshot.id, status: 'inexistente' }));

      for (const snapshot of storeSnapshots.filter((store) => store.exists)) {
        const establishmentId = snapshot.id;
        try {
          const resultado = await atualizarVisitasPorMes({
            db,
            FieldValue: admin.firestore.FieldValue,
            lojaId: establishmentId,
            agora,
          });
          const meses = Object.keys(resultado.meses);
          report.push({ establishmentId, meses, encontrados: resultado.encontrados, atualizadoAte: resultado.atualizadoAte });
          await registrarNoite(snapshot.ref, 'visitasPorMesNightly', {
            dados: {
              meses: meses.join(','),
              diasEncontrados: resultado.encontrados,
              visitas: meses.reduce((soma, mes) => soma + resultado.meses[mes].app + resultado.meses[mes].agente, 0),
            },
          });
        } catch (error) {
          console.error('[visitasPorMesNightly] Falha na loja', { establishmentId, error });
          report.push({ establishmentId, status: 'falhou' });
        }
      }

      const result = { lojas: report, segundos: Math.round((Date.now() - startedAt) / 1000) };
      console.log('[visitasPorMesNightly] Passada concluida', result);
      return result;
    } catch (error) {
      console.error('[visitasPorMesNightly] Falha na passada', { error });
      return null;
    }
  },
);

// Instalacoes do app (Stats/instalacoesApp) para a tela Instalacoes do Admin: Android pelos CSVs da
// Google Play no bucket de relatorios, iPhone pelos relatorios de analise do App Store Connect.
// Semanal, segunda as 04:15 (decisao de 16/10/2026): recalcula os dois ultimos meses e grava por cima
// deles. Roda com a conta de servico relatorios-lojas (leitura do bucket da Play) e a chave de leitura
// da Apple no Secret Manager. A mesma montagem (atualizarTodasAsLojas) atende o "Atualizar agora".
const APPLE_RELATORIOS_LEITURA_P8 = defineSecret('APPLE_RELATORIOS_LEITURA_P8');
const APPLE_ISSUER_ID = defineString('APPLE_ISSUER_ID');
const APPLE_KEY_ID = defineString('APPLE_KEY_ID');
const PLAY_REPORTS_BUCKET = defineString('PLAY_REPORTS_BUCKET');
// Pedido automatico dos relatorios da Apple para app novo (Partes 32.3 e 36.2): a chave Admin mora no
// segredo APPLE_RELATORIOS_PEDIDO_P8 do projeto mobile-chaves-apple, lido em memoria pela conta da funcao
// (relatorios-lojas) pelo caminho completo; o defineSecret so enxerga segredos do proprio projeto. O Key
// ID e o caminho vem do functions/.env.appmobileprod-19505. Sem os dois, a rotina so registra app sem pedido.
const APPLE_PEDIDO_KEY_ID = defineString('APPLE_PEDIDO_KEY_ID', { default: '' });
const APPLE_PEDIDO_SEGREDO = defineString('APPLE_PEDIDO_SEGREDO', { default: '' });

// Le um segredo opcional com a credencial da funcao (sem prende-lo ao deploy, como os de defineSecret).
async function pedirAoGoogle({ url }) {
  const { access_token: token } = await applicationDefault().getAccessToken();
  const resposta = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resposta.ok) throw new Error(`Secret Manager respondeu ${resposta.status}`);
  return { data: await resposta.json() };
}

// Antes de ler os relatorios: os apps da conta Apple sem pedido ONGOING ganham um ONGOING (com a chave de
// pedido) ou ficam apontados como sem pedido (sem ela). Falha aqui nao para a rotina.
async function pedidosDaAppleDaSemana({ issuerId, chaveDeLeitura, keyIdDeLeitura }) {
  try {
    const keyIdDePedido = APPLE_PEDIDO_KEY_ID.value();
    const chaveDePedido = keyIdDePedido
      ? await lerSegredoOpcional({ pedirAoGoogle, caminho: APPLE_PEDIDO_SEGREDO.value() })
      : null;
    const resultado = await pedirRelatoriosQueFaltam({
      leitura: clienteDePedidos({ chaveP8: chaveDeLeitura, issuerId, keyId: keyIdDeLeitura }),
      pedido: chaveDePedido ? clienteDePedidos({ chaveP8: chaveDePedido, issuerId, keyId: keyIdDePedido }) : null,
    });
    console.log('[instalacoesAppNightly] Pedidos da Apple', {
      chaveDePedido: Boolean(chaveDePedido),
      apps: resultado.map(({ appId, bundle, situacao, pedidos, erro }) => ({ appId, bundle, situacao, pedidos, ...(erro ? { erro } : {}) })),
    });
    return resultado;
  } catch (error) {
    console.error('[instalacoesAppNightly] Falha ao conferir os pedidos da Apple', { error: error.message });
    return [];
  }
}

exports.instalacoesAppNightly = onSchedule(
  {
    schedule: '15 4 * * 1',
    timeZone: 'America/Sao_Paulo',
    region: 'us-central1',
    memory: '512MiB',
    timeoutSeconds: 1800,
    retryCount: 0,
    serviceAccount: 'relatorios-lojas@appmobileprod-19505.iam.gserviceaccount.com',
    secrets: [APPLE_RELATORIOS_LEITURA_P8],
  },
  async () => {
    try {
      const startedAt = Date.now();
      const meses = doisUltimosMeses(new Date());
      const configSnapshot = await db.doc(IMAGE_CHECK_CONFIG_PATH).get();
      const configuredIds = configuredEstablishmentIds(configSnapshot.data());
      if (!configuredIds.length) {
        console.log('[instalacoesAppNightly] Nenhuma loja habilitada em', IMAGE_CHECK_CONFIG_PATH);
        return null;
      }
      const pedidosDaApple = await pedidosDaAppleDaSemana({
        issuerId: APPLE_ISSUER_ID.value(),
        chaveDeLeitura: APPLE_RELATORIOS_LEITURA_P8.value(),
        keyIdDeLeitura: APPLE_KEY_ID.value(),
      });
      const situacaoDoPedido = (snapshot) => {
        const bundle = appsDaLoja(snapshot.get('whitelabelId'))?.ios;
        const app = pedidosDaApple.find((item) => item.bundle === bundle);
        return app ? `${app.situacao}${app.pedidos.length ? `:${app.pedidos.map((item) => item.tipo).join('+')}` : ''}` : '';
      };
      const report = await atualizarTodasAsLojas({
        db,
        FieldValue: admin.firestore.FieldValue,
        lojaIds: configuredIds,
        bucket: getStorage().bucket(PLAY_REPORTS_BUCKET.value()),
        apple: leitorDaApple({
          chaveP8: APPLE_RELATORIOS_LEITURA_P8.value(),
          issuerId: APPLE_ISSUER_ID.value(),
          keyId: APPLE_KEY_ID.value(),
        }),
        meses,
        aoTerminarLoja: async (snapshot, resultado) => {
          // Pedido da Apple do app da loja (app, situacao e motivo do erro) em Stats/instalacoesApp.
          const pedidoApple = pedidoAppleDaLoja(pedidosDaApple, appsDaLoja(snapshot.get('whitelabelId'))?.ios);
          if (pedidoApple) {
            await snapshot.ref.collection('Stats').doc('instalacoesApp').set({ pedidoApple }, { merge: true })
              .catch((error) => console.error('[instalacoesAppNightly] Falha ao registrar o pedido da Apple', { establishmentId: snapshot.id, error: error.message }));
          }
          await registrarNoite(snapshot.ref, 'instalacoesAppNightly', {
            dados: {
              meses: meses.join(','),
              androidAte: resultado.documento.dadosAte.android || '',
              iosAte: resultado.documento.dadosAte.ios || '',
              dimensaoAndroid: [...new Set((resultado.android?.arquivos || []).map((arquivo) => arquivo.dimensao))].join(','),
              // Pedido da Apple do app desta loja: ja-tinha, pedido-criado:ONGOING, sem-pedido ou falhou.
              pedidoApple: situacaoDoPedido(snapshot),
            },
          });
        },
        aoFalhar: (establishmentId, error) => console.error('[instalacoesAppNightly] Falha na loja', { establishmentId, error: error.message }),
      });

      const result = { lojas: report, segundos: Math.round((Date.now() - startedAt) / 1000) };
      console.log('[instalacoesAppNightly] Passada concluida', result);
      return result;
    } catch (error) {
      console.error('[instalacoesAppNightly] Falha na passada', { error: error.message });
      return null;
    }
  },
);
