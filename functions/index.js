const admin = require('firebase-admin');
const {
  onDocumentCreated,
  onDocumentWritten,
} = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { getStorage } = require('firebase-admin/storage');
const { handleOrderHourlySalesWrite } = require('./hourlySalesAggregation');
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

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();
const MAX_TOKENS_PER_REQUEST = 500;
const IMAGE_CHECK_CONFIG_PATH = 'CoreJobs/verifyProductImageFiles';
const IMAGE_CHECK_TIME_BUDGET_MS = 25 * 60 * 1000;

exports.aggregateOrderHourlySales = onDocumentWritten(
  'PurchaseRequests/{orderId}',
  async (event) => {
    try {
      const result = await handleOrderHourlySalesWrite({
        db,
        FieldValue: admin.firestore.FieldValue,
        event,
      });
      console.log('[aggregateOrderHourlySales] Pedido reconciliado', {
        orderId: event.params.orderId,
        ...result,
      });
      return result;
    } catch (error) {
      console.error('[aggregateOrderHourlySales] Falha ao agregar pedido', {
        orderId: event.params.orderId,
        error,
      });
      throw error;
    }
  },
);

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

const chunkArray = (items, size) => {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

// Sanitiza strings para prevenir injeção em notificações
const sanitizeString = (str, maxLength = 200) => {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/<[^>]*>/g, '') // Remove tags HTML
    .replace(/[<>"'&]/g, '') // Remove caracteres perigosos
    .trim()
    .slice(0, maxLength);
};

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

    const tokenDocsSnap = await db
      .collection('FcmTokens')
      .where('clientId', '==', companyId)
      .where('active', '==', true)
      .get();

    if (tokenDocsSnap.empty) {
      console.log(`[sendOrderNotification] Nenhum token ativo para ${companyId}`);
      return null;
    }

    const tokenEntries = tokenDocsSnap.docs
      .map((doc) => ({
        token: String(doc.data().token || doc.id || '').trim(),
        ref: doc.ref
      }))
      .filter((entry) => entry.token);

    console.log(`[sendOrderNotification] ${tokenEntries.length} tokens encontrados`);

    const orderNumber = sanitizeString(order.orderNumber ? String(order.orderNumber) : '', 20);
    const clientName = sanitizeString(order.clientName, 100) || 'Cliente';

    const title = sanitizeString(order.notificationTitle, 100) || '🔔 Novo Pedido!';
    const body =
      sanitizeString(order.notificationBody, 200) ||
      `Pedido ${orderNumber ? `#${orderNumber}` : ''} de ${clientName}`;

    const buildMessagePayload = (targetTokens) => ({
      data: {
        orderId,
        orderNumber: orderNumber || '',
        clientName,
        companyId,
        url: '/pedidos',
        title,
        body,
        icon: '/favicon.ico',
        tag: orderId,
        timestamp: new Date().toISOString()
      },
      webpush: {
        headers: {
          Urgency: 'high'
        },
        fcmOptions: {
          link: '/pedidos'
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

          console.warn(`[sendOrderNotification] Erro no token ${failedEntry.token}: ${errorCode}`);

          if (
            errorCode === 'messaging/registration-token-not-registered' ||
            errorCode === 'messaging/invalid-registration-token' ||
            errorCode === 'messaging/invalid-argument'
          ) {
            cleanupPromises.push(
              failedEntry.ref.update({ active: false }).catch((err) => {
                console.error('[sendOrderNotification] Falha ao desativar token', err);
              })
            );
          }
        });
      } catch (chunkError) {
        console.error('[sendOrderNotification] Erro ao enviar chunk de tokens', chunkError);
      }
    }

    if (cleanupPromises.length) {
      await Promise.all(cleanupPromises);
      console.log(
        `[sendOrderNotification] ${cleanupPromises.length} tokens inválidos desativados`
      );
    }

    console.log(
      `[sendOrderNotification] Envio concluído. Sucessos: ${totalSuccess}, Falhas: ${totalFailures}`
    );

    return { totalSuccess, totalFailures };
  }
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
        const summary = await runEstablishmentPass({
          storeRef,
          documentIdPath: admin.firestore.FieldPath.documentId(),
          index,
          checker,
          sampleSize,
          loadOrders: () => loadStoreOrders(storeRef),
          loadTestAccountIds: (orders) => testAccountIdsFor(db, orders),
        });
        await writeSummary({
          storeRef,
          summary,
          checkedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        report.push({
          establishmentId,
          produtosAVenda: summary.produtosAVenda,
          vendas30: summary.vendas30,
          semFoto: summary.semFoto,
          semFotoAVenda: summary.semFotoAVenda,
          semTag: summary.semTag,
          semCategoria: summary.semCategoria,
          metodo: summary.metodo,
        });
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
