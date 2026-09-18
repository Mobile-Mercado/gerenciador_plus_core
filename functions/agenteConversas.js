const { isTestOrder, orderClientId } = require('./hourlySalesAggregation');

const SUMMARY_VERSION = 1;
const TIME_ZONE = 'America/Sao_Paulo';
const MAX_TERMS = 500;
const MAX_FAMILIES = 200;
const MAX_UNGROUPED = 500;
const PROBABLE_ORDER_WINDOW_MS = 2 * 60 * 60 * 1000;
const MESSAGE_FETCH_CONCURRENCY = 20;

const STOPWORDS = new Set(['de', 'do', 'da', 'dos', 'das', 'o', 'a', 'um', 'uma']);

// Textos fixos dos botoes do fluxo do agente, ja normalizados.
const FLOW_BUTTONS = new Set([
  'finalizar pedido',
  'continuar comprando',
  'buscar produtos',
  'ver pedidos',
  'digitar a minha lista de compras',
]);

// Mensagem inteira, ate 4 palavras, feita so destas palavras: saudacao ou confirmacao.
const CONVERSATION_WORDS = new Set([
  'oi', 'ola', 'opa', 'eai', 'bom', 'boa', 'dia', 'tarde', 'noite', 'tudo', 'bem', 'e', 'ai',
  'obrigado', 'obrigada', 'obg', 'valeu', 'vlw', 'ok', 'okay', 'blz', 'beleza', 'sim', 'nao',
  'isso', 'certo', 'claro', 'pode', 'ser', 'entendi', 'ta', 'perfeito', 'otimo', 'show', 'joia',
  'tchau', 'ate', 'mais', 'logo', 'por', 'favor', 'tb', 'tambem', 's', 'n',
]);

const ADDRESS_WORDS = new Set([
  'rua', 'avenida', 'av', 'quadra', 'qd', 'lote', 'lt', 'bairro', 'setor', 'casa', 'apto',
  'apartamento', 'bloco', 'numero', 'cep', 'condominio', 'residencial', 'travessa', 'alameda',
  'rodovia', 'endereco', 'jardim', 'vila',
]);

const PAYMENT_WORDS = new Set([
  'pix', 'dinheiro', 'cartao', 'credito', 'debito', 'troco', 'boleto',
]);

// Embalagem ou medida nunca e familia (ja na forma normalizada: galoes -> galoe).
const PACKAGING_WORDS = new Set([
  'caixa', 'cx', 'pacote', 'pct', 'fardo', 'garrafa', 'lata', 'saco', 'unidade', 'un',
  'litro', 'l', 'ml', 'kg', 'g', 'grama', 'pote', 'galao', 'galoe', 'engradado',
]);

// Palavras de conversa, pedido e fluxo: nunca familia nem nao agrupado, mesmo
// que aparecam em nome de produto.
const NEVER_FAMILY_WORDS = new Set([
  'com', 'sem', 'por', 'para', 'pra', 'das', 'dos', 'nao', 'bem', 'boa', 'bom', 'dia',
  'tarde', 'noite', 'meu', 'minha', 'sou', 'ver', 'vou', 'quero', 'tem', 'tenho',
  'preciso', 'gostaria', 'oi', 'ola', 'sim', 'teste', 'preco', 'pedido',
]);

const PRODUCT_REQUEST_PATTERN = /\b(tem|quero|preco|quanto custa|valor)\b/;
const QUANTITY_PATTERN = /\b\d+(?:[.,]\d+)?\s*(kg|g|gr|ml|l|lt|litro|litros|un|und|unid|unidade|unidades|pct|pacote|pacotes|cx|caixa|caixas|duzia|fardo|fardos)\b/;
const CPF_PATTERN = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/;
const CEP_PATTERN = /\b\d{5}-?\d{3}\b/;
const PHONE_PATTERN = /\(?\d{2}\)?[\s.-]?9?\d{4}[\s.-]?\d{4}/g;

function withoutAccents(value) {
  return String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Minusculas, sem acento, sem pontuacao, espacos simples.
function normalizeText(value) {
  return withoutAccents(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Plural simples: tira o s final de palavra com 4+ letras (leites -> leite; gas fica).
function singular(word) {
  return word.length >= 4 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

function normalizeTerm(value) {
  return normalizeText(value)
    .split(' ')
    .filter((word) => word && !STOPWORDS.has(word))
    .map(singular)
    .filter(Boolean)
    .slice(0, 3)
    .join(' ');
}

// Palavras de 3+ letras dos nomes dos produtos (pao, sal, gas), na mesma forma dos termos.
function catalogDictionary(names = []) {
  const dictionary = new Set();
  names.forEach((name) => {
    normalizeText(name).split(' ').forEach((word) => {
      if (/^[a-z]{3,}$/.test(word)) dictionary.add(singular(word));
    });
  });
  return dictionary;
}

// Palavra que comeca com numero (300, 2l, 350ml) e quantidade, nunca familia.
function isNumericWord(word) {
  return /^\d/.test(word);
}

function isFamilyCandidate(word) {
  return !PACKAGING_WORDS.has(word) && !isNumericWord(word) && !NEVER_FAMILY_WORDS.has(word);
}

// Primeira palavra do termo que exista no catalogo, pulando numero, embalagem,
// medida e palavras de conversa. Sem palavra do catalogo: com ate duas palavras que
// sobrem (pedido curto fora do catalogo) fica sem familia; com mais, fica com a
// primeira que sobrou.
function familyOf(term, dictionary) {
  const words = String(term || '').split(' ').filter(Boolean);
  if (!words.length) return '';
  const candidates = words.filter(isFamilyCandidate);
  const inCatalog = candidates.find((word) => dictionary.has(word));
  if (inCatalog) return inCatalog;
  if (candidates.length <= 2) return '';
  return candidates[0];
}

// Termo so de numeros (2l, 300) ou de palavras de conversa (ver pedido, preco)
// nao entra na lista de nao agrupados.
function hasUngroupableWord(term) {
  return String(term || '').split(' ')
    .some((word) => word && !isNumericWord(word) && !NEVER_FAMILY_WORDS.has(word));
}

function hasPhone(text) {
  return (String(text).match(PHONE_PATTERN) || [])
    .some((match) => {
      const digits = match.replace(/\D/g, '').length;
      return digits === 10 || digits === 11;
    });
}

// dados > conversa > botao > produto > outro. O texto nunca e guardado.
// flowState: estado do fluxo antes da mensagem; enquanto o agente coleta nome ou
// CPF, a resposta e dado. clientNameWords: palavras do nome do cliente, para o
// pedido curto nunca guardar um nome como termo.
function messageType(text, dictionary, { flowState = '', clientNameWords = null } = {}) {
  const raw = String(text ?? '');
  const normalized = normalizeText(raw);
  const words = normalized.split(' ').filter(Boolean);

  if (
    String(flowState || '').startsWith('collecting_')
    || CPF_PATTERN.test(raw)
    || hasPhone(raw)
    || CEP_PATTERN.test(raw)
    || normalized.includes('meu nome e')
    || words.some((word) => ADDRESS_WORDS.has(word) || PAYMENT_WORDS.has(word))
  ) return 'dados';

  if (words.length && words.length <= 4 && words.every((word) => CONVERSATION_WORDS.has(word))) {
    return 'conversa';
  }

  if (FLOW_BUTTONS.has(normalized)) return 'botao';

  if (
    words.some((word) => dictionary.has(singular(word)))
    || PRODUCT_REQUEST_PATTERN.test(normalized)
    || QUANTITY_PATTERN.test(normalized)
  ) return 'produto';

  // Pedido curto fora do catalogo: uma ou duas palavras que sobraram das regras acima.
  if (words.length >= 1 && words.length <= 2) {
    if (clientNameWords && words.some((word) => clientNameWords.has(word))) return 'dados';
    return 'produto';
  }

  return 'outro';
}

function nameWordsOf(name) {
  return new Set(normalizeText(name).split(' ').filter((word) => word.length >= 3));
}

function toMillis(value) {
  if (!value) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (typeof value.seconds === 'number') return value.seconds * 1000;
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

const monthFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
});

function monthOf(millis) {
  const parts = monthFormatter.formatToParts(new Date(millis));
  const value = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${value('year')}-${value('month')}`;
}

function normalizeStatus(value) {
  return String(value || '').replace(/^PurchaseStatus\./i, '').trim().toLowerCase();
}

function isAgentOrder(order = {}) {
  return order.agentOrder === true
    || order.createdByAgent === true
    || order.origem === 'agente_ia'
    || [order.source, order.channel, order.purchaseOrigin].some((value) => value === 'agent');
}

// Pedidos da loja: marcados pela origem de agente, e provaveis pelo cliente que
// conversou com o agente e comprou ate 2 horas depois do inicio de uma conversa.
function summarizeAgentOrders(orders = [], conversations = [], { testAccountIds = new Set() } = {}) {
  const startsByClient = new Map();
  conversations.forEach(({ data }) => {
    const started = toMillis(data.startedAt);
    if (!data.userId || started === null) return;
    if (!startsByClient.has(data.userId)) startsByClient.set(data.userId, []);
    startsByClient.get(data.userId).push(started);
  });

  let marcados = 0;
  let provaveis = 0;
  let provaveisConcluidos = 0;
  orders.forEach((order) => {
    const clientId = orderClientId(order);
    if (isTestOrder(order, { testAccount: testAccountIds.has(clientId) })) return;
    if (isAgentOrder(order)) {
      marcados += 1;
      return;
    }
    const created = toMillis(order.createdAt);
    const starts = startsByClient.get(clientId);
    if (created === null || !starts) return;
    const probable = starts.some((start) => created >= start && created - start <= PROBABLE_ORDER_WINDOW_MS);
    if (!probable) return;
    provaveis += 1;
    const status = normalizeStatus(order.currentPurchaseStatus || order.purchaseStatus || order.status);
    if (status === 'completed') provaveisConcluidos += 1;
  });

  return { marcados, provaveis, provaveisConcluidos };
}

const byCountThenText = (field) => (a, b) => b.vezes - a.vezes || a[field].localeCompare(b[field]);

// conversations: [{ id, data, messages: [dados da mensagem] }]. Guarda so termos e
// contagens: nenhum texto de mensagem, nome, telefone ou endereco sai daqui.
function summarizeConversations({ conversations = [], dictionary = new Set(), orders = [], testAccountIds } = {}) {
  const clients = new Set();
  const terms = new Map();
  const months = new Map();
  let periodStart = null;
  let periodEnd = null;
  let abandonadas = 0;
  let ativas = 0;
  let comPedidoMarcado = 0;
  let mensagensCliente = 0;
  let pedidosDeProduto = 0;
  let botoesDoFluxo = 0;

  conversations.forEach(({ data = {}, messages = [] }) => {
    const started = toMillis(data.startedAt);
    const updated = toMillis(data.updatedAt) ?? started;
    if (started !== null && (periodStart === null || started < periodStart)) periodStart = started;
    if (updated !== null && (periodEnd === null || updated > periodEnd)) periodEnd = updated;
    if (data.userId) clients.add(data.userId);
    const abandoned = data.status === 'abandonada';
    if (abandoned) abandonadas += 1;
    if (data.status === 'ativa') ativas += 1;
    if (data.pedidoGerado === true) comPedidoMarcado += 1;
    const emptyCart = !Array.isArray(data.carrinhoFinal) || data.carrinhoFinal.length === 0;

    let month = null;
    if (started !== null) {
      const key = monthOf(started);
      if (!months.has(key)) {
        months.set(key, { mes: key, conversas: 0, abandonadas: 0, clientes: new Set(), pedidosDeProduto: 0 });
      }
      month = months.get(key);
      month.conversas += 1;
      if (abandoned) month.abandonadas += 1;
      if (data.userId) month.clientes.add(data.userId);
    }

    const ordered = messages
      .map((message) => ({ message, at: toMillis(message.timestamp) }))
      .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    const clientNameWords = nameWordsOf(data.clienteNome);

    ordered.forEach(({ message, at }, index) => {
      if (message.role !== 'user') return;
      mensagensCliente += 1;
      const type = messageType(message.content, dictionary, {
        flowState: message.flowStateAntes,
        clientNameWords,
      });
      if (type === 'botao') botoesDoFluxo += 1;
      if (type !== 'produto') return;
      pedidosDeProduto += 1;
      if (month) month.pedidosDeProduto += 1;

      const term = normalizeTerm(message.content);
      if (!term) return;
      const reply = ordered.slice(index + 1).find(({ message: next }) => next.role === 'assistant');
      const withProduct = Array.isArray(reply?.message.produtosCardIds) && reply.message.produtosCardIds.length > 0;

      if (!terms.has(term)) {
        terms.set(term, {
          termo: term,
          familia: familyOf(term, dictionary),
          vezes: 0,
          primeira: null,
          ultima: null,
          comProduto: 0,
          semProduto: 0,
          semCarrinho: 0,
        });
      }
      const entry = terms.get(term);
      entry.vezes += 1;
      if (withProduct) entry.comProduto += 1;
      else entry.semProduto += 1;
      if (emptyCart) entry.semCarrinho += 1;
      if (at !== null) {
        if (entry.primeira === null || at < entry.primeira) entry.primeira = at;
        if (entry.ultima === null || at > entry.ultima) entry.ultima = at;
      }
    });
  });

  const allTerms = [...terms.values()].sort(byCountThenText('termo'));
  const families = new Map();
  allTerms.forEach(({ termo, familia, vezes }) => {
    if (!familia) return;
    if (!families.has(familia)) families.set(familia, { familia, vezes: 0, variantes: [] });
    const family = families.get(familia);
    family.vezes += vezes;
    family.variantes.push({ termo, vezes });
  });

  const asDate = (millis) => (millis === null ? null : new Date(millis));
  return {
    version: SUMMARY_VERSION,
    periodoInicio: asDate(periodStart),
    periodoFim: asDate(periodEnd),
    conversas: conversations.length,
    clientes: clients.size,
    abandonadas,
    ativas,
    comPedidoMarcado,
    mensagensCliente,
    pedidosDeProduto,
    botoesDoFluxo,
    termos: allTerms.slice(0, MAX_TERMS).map((entry) => ({
      ...entry,
      primeira: asDate(entry.primeira),
      ultima: asDate(entry.ultima),
    })),
    familias: [...families.values()].sort(byCountThenText('familia')).slice(0, MAX_FAMILIES),
    naoAgrupados: allTerms
      .filter(({ termo, familia }) => !familia && hasUngroupableWord(termo))
      .map(({ termo, vezes }) => ({ termo, vezes }))
      .slice(0, MAX_UNGROUPED),
    porMes: [...months.values()]
      .sort((a, b) => a.mes.localeCompare(b.mes))
      .map(({ clientes, ...month }) => ({ ...month, clientes: clientes.size })),
    pedidos: summarizeAgentOrders(orders, conversations, { testAccountIds }),
  };
}

async function mapWithConcurrency(items, concurrency, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// Le conversas (qualquer caminho, via collectionGroup), mensagens, nomes dos
// produtos ativos e pedidos da loja. testAccountIdsFor cruza os clientes de teste.
async function loadAgentConversationData({
  db,
  storeRef,
  documentIdPath,
  testAccountIdsFor,
  concurrency = MESSAGE_FETCH_CONCURRENCY,
  queryPageSize = 1000,
}) {
  const conversationSnapshot = await db
    .collectionGroup('conversas')
    .where('companyId', '==', storeRef.id)
    .get();
  const conversations = await mapWithConcurrency(conversationSnapshot.docs, concurrency, async (conversation) => {
    const messages = await conversation.ref.collection('mensagens').get();
    return {
      id: conversation.id,
      data: conversation.data(),
      messages: messages.docs.map((message) => message.data()),
    };
  });

  const names = [];
  let lastDocument = null;
  while (true) {
    let productsQuery = storeRef
      .collection('Products')
      .where('isTrashed', '==', false)
      .orderBy(documentIdPath)
      .select('name')
      .limit(queryPageSize);
    if (lastDocument) productsQuery = productsQuery.startAfter(lastDocument);
    const snapshot = await productsQuery.get();
    if (snapshot.empty) break;
    snapshot.docs.forEach((product) => names.push(product.get('name')));
    lastDocument = snapshot.docs.at(-1);
    if (snapshot.size < queryPageSize) break;
  }

  const ordersSnapshot = await db
    .collection('PurchaseRequests')
    .where('companyReference', '==', storeRef)
    .get();
  const orders = ordersSnapshot.docs.map((order) => order.data());
  const testAccountIds = testAccountIdsFor ? await testAccountIdsFor(db, orders) : new Set();

  return {
    conversations,
    dictionary: catalogDictionary(names),
    orders,
    testAccountIds,
    counts: {
      conversas: conversations.length,
      mensagens: conversations.reduce((sum, { messages }) => sum + messages.length, 0),
      produtos: names.length,
      pedidos: orders.length,
    },
  };
}

async function writeAgentConversationsSummary({ storeRef, summary, generatedAt }) {
  await storeRef.collection('Stats').doc('agenteConversas').set({ ...summary, geradoEm: generatedAt });
}

module.exports = {
  MAX_FAMILIES,
  MAX_TERMS,
  MAX_UNGROUPED,
  SUMMARY_VERSION,
  catalogDictionary,
  familyOf,
  isAgentOrder,
  loadAgentConversationData,
  messageType,
  normalizeTerm,
  normalizeText,
  summarizeAgentOrders,
  summarizeConversations,
  writeAgentConversationsSummary,
};
