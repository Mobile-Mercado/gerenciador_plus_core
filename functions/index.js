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
const { lojasDaConversa, marcarMudanca } = require('./marcador');
const {
  RESUMO_COLLECTION,
  TOTAL_DE_BLOCOS,
  cadastroMudou,
  recalcularCliente,
  segmentoDoCliente,
} = require('./resumoClientes');

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
