// Resumo por cliente de cada loja, em estabelecimentos/{loja}/ResumoClientes/{bloco}.
//
// Existe para a tela Clientes do painel parar de assinar todos os pedidos da loja so para
// montar a lista: o resumo traz, por cliente, o que a tabela mostra (contato, pedidos,
// LTV, primeira e ultima compra, frequencia e segmento).
//
// REGRA QUE PRENDE ESTE ARQUIVO AO PAINEL: as contas abaixo sao COPIA das do painel e
// precisam mudar junto com elas. Origem, no web_gerenciador_plus:
//   - src/shared/clientPanel.js: ignoredStatuses, toDate, toNumber, getNestedValue, refId,
//     getProductTotal, getOrderTotal, normalizeStatus, isValidPurchase, daysBetween e
//     averageFrequencyDays;
//   - src/features/clients/useClientsRealtimeBridge.js: getClientId, getClientName,
//     getClientEmail, getClientPhone, getAddressText, os scores RFM, getSegment e o
//     calculo por cliente de buildClients.
// Mudou a regua la, muda aqui; se nao, o painel e o resumo discordam do mesmo cliente.
// A unica parte de buildClients que nao vem e a marca local de conta de teste
// (localAccountTestFlag), que so existe na memoria da aba do navegador.
//
// BLOCO: cada cliente cai num dos 16 documentos pelo FNV-1a de 32 bits da chave (bytes
// UTF-8), com resto por 16, em texto de dois digitos ('00' a '15'). A conta nao depende de
// nada alem da chave, entao o mesmo cliente cai sempre no mesmo bloco.
//
// Arquivo puro: nao requer firebase-admin nem firebase-functions. Para gravar, recebe db e
// o FieldValue de quem chamou.
const RESUMO_VERSION = 1;
const RESUMO_COLLECTION = 'ResumoClientes';
const TOTAL_DE_BLOCOS = 16;

// ----- Copia de src/shared/clientPanel.js -----

const ignoredStatuses = new Set([
  'pending',
  'awaitingPayment',
  'waitingForOrderPayment',
  'waitingConfirmation',
  'denied',
  'giveUp',
  'return',
  'canceled',
  'cancelled',
  'cancelado',
]);

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === 'function') return value.toDate();
  if (typeof value.seconds === 'number') return new Date(value.seconds * 1000);
  if (typeof value === 'number') return new Date(value);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return 0;
  const cleaned = value.replace(/[^\d,.-]/g, '');
  const parsed = Number(
    cleaned.includes(',') ? cleaned.replaceAll('.', '').replace(',', '.') : cleaned,
  );
  return Number.isFinite(parsed) ? parsed : 0;
}

function getNestedValue(source, paths) {
  for (const path of paths) {
    const value = path.split('.').reduce((current, key) => current?.[key], source);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function refId(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.split('/').filter(Boolean).at(-1) || value;
  return value.id || value.path?.split('/').filter(Boolean).at(-1) || '';
}

function getProductTotal(item) {
  const explicitTotal = getNestedValue(item, [
    'total',
    'totalPrice',
    'amount',
    'subtotal',
    'finalPrice',
    'priceTotal',
  ]);
  if (explicitTotal !== null) return toNumber(explicitTotal);

  const quantity = toNumber(item.quantity) || 1;
  const price = toNumber(
    getNestedValue(item, [
      'price',
      'currentPrice',
      'unitPrice',
      'product.price',
      'product.currentPrice',
      'product.promotionalPrice',
    ]),
  );
  return quantity * price;
}

function getOrderTotal(data) {
  const directTotal = getNestedValue(data, [
    'total',
    'totalPrice',
    'totalValue',
    'orderTotal',
    'priceTotal',
    'cartTotal',
    'amount',
    'payment.total',
    'payment.amount',
    'summary.total',
  ]);
  if (directTotal !== null) return toNumber(directTotal);

  return (data.productsCart || data.items || []).reduce((sum, item) => sum + getProductTotal(item), 0);
}

function normalizeStatus(status) {
  return String(status || '').replace('PurchaseStatus.', '');
}

function isValidPurchase(data) {
  const status = normalizeStatus(data.currentPurchaseStatus || data.purchaseStatus || data.status || data.stats);
  return !ignoredStatuses.has(status);
}

function daysBetween(a, b) {
  return Math.max(0, Math.floor((a.getTime() - b.getTime()) / 86400000));
}

function averageFrequencyDays(orders) {
  const dates = orders
    .map((order) => order.createdAt)
    .filter(Boolean)
    .sort((a, b) => a.getTime() - b.getTime());
  if (dates.length < 2) return null;
  const totalDays = dates.slice(1).reduce((sum, date, index) => sum + daysBetween(date, dates[index]), 0);
  return totalDays / (dates.length - 1);
}

// ----- Copia de src/features/clients/useClientsRealtimeBridge.js -----

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

function getClientId(data) {
  return refId(
    getNestedValue(data, [
      'clientId',
      'customerId',
      'userId',
      'clientReference',
      'customerReference',
      'userReference',
      'client.id',
      'customer.id',
      'user.id',
    ]),
  );
}

function getClientName(data) {
  return (
    getNestedValue(data, [
      'clientName',
      'customerName',
      'client.name',
      'customer.name',
      'user.name',
    ]) || 'Cliente não identificado'
  );
}

function getClientEmail(data, user) {
  return user?.email || getNestedValue(data, ['clientEmail', 'customerEmail', 'email']) || '';
}

function getClientPhone(data, user) {
  return user?.phone || user?.telefone || getNestedValue(data, ['clientPhone', 'customerPhone', 'phone']) || '';
}

function getAddressText(user, fallbackOrder) {
  const address = user?.deliveryAddressSelected || fallbackOrder?.address || fallbackOrder?.deliveryAddress;
  if (!address || typeof address !== 'object') return '';
  return (
    address.fullAddress ||
    [address.street, address.number, address.neighborhood, address.city, address.uf].filter(Boolean).join(', ')
  );
}

// O painel mostra a recencia nos pontinhos RFM; getSegment nao a usa. Fica copiada para o
// dia em que o resumo levar os pontinhos.
function scoreRecency(days) {
  if (days <= 7) return 5;
  if (days <= 15) return 4;
  if (days <= 30) return 3;
  if (days <= 60) return 2;
  return 1;
}

function scoreFrequency(count) {
  if (count >= 20) return 5;
  if (count >= 10) return 4;
  if (count >= 5) return 3;
  if (count >= 2) return 2;
  return 1;
}

function scoreMonetary(ltv, averageLtv) {
  if (!averageLtv) return ltv > 0 ? 3 : 1;
  const multiplier = ltv / averageLtv;
  if (multiplier >= 2) return 5;
  if (multiplier >= 1.25) return 4;
  if (multiplier >= 0.75) return 3;
  if (multiplier >= 0.35) return 2;
  return 1;
}

function getSegment(client) {
  if (client.daysSinceLast >= 60) {
    return { label: 'Inativo', className: 'pill-bad' };
  }
  if (client.daysSinceLast >= 30 && client.ordersCount > 1) {
    return { label: 'Em risco', className: 'pill-warn' };
  }
  if (client.rfm.frequency >= 4 && client.rfm.monetary >= 4) {
    return { label: 'VIP', className: 'pill-vip' };
  }
  if (client.ordersCount <= 2) {
    return { label: 'Novo', className: 'pill-info' };
  }
  if (client.rfm.frequency >= 3 || (client.frequencyDays !== null && client.frequencyDays <= 14)) {
    return { label: 'Fiel', className: 'pill-good' };
  }
  return { label: 'Regular', className: 'pill-neutral' };
}

// Mesmo formato do orderFromSnapshot do painel, so com o que o resumo usa.
function pedidoDoPainel(data) {
  return {
    data,
    clientId: getClientId(data),
    clientName: getClientName(data),
    createdAt: toDate(data.createdAt || data.scheduling || data.updatedAt),
    total: getOrderTotal(data),
  };
}

// ----- Resumo -----

// Chave do grupo, como em buildClients: o id do cliente ou, sem ele, o nome normalizado.
function chaveDoPedido(data) {
  return getClientId(data) || `name:${normalize(getClientName(data))}`;
}

function blocoDoCliente(chave) {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(String(chave))) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return String(hash % TOTAL_DE_BLOCOS).padStart(2, '0');
}

// Um cliente numa loja: os pedidos crus dele e o documento de Users (ou null). O painel
// le os pedidos do mais novo para o mais antigo e o grupo guarda o nome do primeiro que
// chega; a ordenacao abaixo reproduz isso.
function resumirCliente({ pedidos = [], usuario = null }) {
  const validos = pedidos
    .filter((data) => isValidPurchase(data) && data?.isTest !== true)
    .map(pedidoDoPainel);
  if (!validos.length) return null;

  const ordersByDate = [...validos].sort(
    (a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0),
  );
  const primeiroDoGrupo = ordersByDate[0];
  const chave = chaveDoPedido(primeiroDoGrupo.data);
  const userId = primeiroDoGrupo.clientId;
  const user = userId ? usuario : null;
  const firstOrder = ordersByDate.at(-1);
  const lastOrder = ordersByDate[0];
  const ltv = ordersByDate.reduce((sum, order) => sum + order.total, 0);

  return {
    chave,
    userId,
    nome: user?.name || user?.nome || primeiroDoGrupo.clientName || 'Cliente não identificado',
    email: getClientEmail(lastOrder?.data || {}, user),
    telefone: getClientPhone(lastOrder?.data || {}, user),
    endereco: getAddressText(user, lastOrder?.data),
    cpf: user?.cpf || '',
    cadastroEm: toDate(user?.createAt || user?.createdAt) || firstOrder?.createdAt || null,
    primeiroPedidoEm: firstOrder?.createdAt || null,
    ultimoPedidoEm: lastOrder?.createdAt || null,
    pedidos: ordersByDate.length,
    ltv,
    frequenciaDias: averageFrequencyDays(ordersByDate),
    contaDeTeste: user?.isTestAccount === true || validos.some((order) => order.data?.isTestAccount === true),
    provedoresDeLogin: Array.isArray(user?.provedoresDeLogin) ? user.provedoresDeLogin : [],
    aniversario: getNestedValue(user || {}, ['birthDate', 'birthday', 'dateOfBirth', 'dataNascimento']),
    versaoResumo: RESUMO_VERSION,
  };
}

// Segmento pela regua do painel. ltvMedio e a media de LTV de todos os clientes da loja.
function segmentoDoCliente({ resumo, ltvMedio, agora = new Date() }) {
  const ultimo = toDate(resumo.ultimoPedidoEm);
  const client = {
    daysSinceLast: ultimo ? daysBetween(agora, ultimo) : 9999,
    ordersCount: resumo.pedidos,
    frequencyDays: resumo.frequenciaDias,
    rfm: {
      frequency: scoreFrequency(resumo.pedidos),
      monetary: scoreMonetary(resumo.ltv, ltvMedio),
    },
  };
  return getSegment(client).label;
}

// ----- Gravacao de um cliente -----

// Campos de Users que entram no resumo. Mudanca fora deles (segmento, lastSeen, tokens)
// nao dispara recalculo.
const CAMPOS_DO_CADASTRO = Object.freeze([
  'name',
  'nome',
  'email',
  'phone',
  'telefone',
  'deliveryAddressSelected',
  'createAt',
  'createdAt',
  'isTestAccount',
  'provedoresDeLogin',
  'birthDate',
  'birthday',
  'dateOfBirth',
  'dataNascimento',
  'cpf',
]);

// Timestamp do Firestore vira milissegundos para a comparacao nao depender da classe.
function serializado(valor) {
  return JSON.stringify(valor ?? null, (_chave, v) => (v && typeof v.toMillis === 'function' ? { ms: v.toMillis() } : v));
}

function cadastroMudou(antes, depois) {
  return CAMPOS_DO_CADASTRO.some((campo) => serializado(antes?.[campo]) !== serializado(depois?.[campo]));
}

function blocoReference(db, lojaId, bloco) {
  return db.collection('estabelecimentos').doc(lojaId).collection(RESUMO_COLLECTION).doc(bloco);
}

// Recalcula um cliente numa loja e grava so a entrada dele no bloco. O segmento nao e
// recalculado aqui: depende do LTV medio da loja inteira e fica com a rotina da madrugada.
// Merge com objeto aninhado (e nao caminho com ponto) para o id nunca virar caminho.
async function recalcularCliente({ db, FieldValue, lojaId, clienteId }) {
  const lojaRef = db.collection('estabelecimentos').doc(lojaId);
  const [pedidos, usuario] = await Promise.all([
    db.collection('PurchaseRequests').where('companyReference', '==', lojaRef).where('clientId', '==', clienteId).get(),
    db.collection('Users').doc(clienteId).get(),
  ]);
  const resumo = resumirCliente({
    pedidos: pedidos.docs.map((doc) => doc.data()),
    usuario: usuario.exists ? { id: usuario.id, ...usuario.data() } : null,
  });

  const bloco = blocoDoCliente(clienteId);
  const ref = blocoReference(db, lojaId, bloco);
  const atual = await ref.get();
  const gravado = atual.exists ? atual.get('clientes')?.[clienteId] : undefined;

  if (!resumo) {
    if (!gravado) return { acao: 'nada', bloco };
    await ref.set({ clientes: { [clienteId]: FieldValue.delete() } }, { merge: true });
    return { acao: 'removeu', bloco };
  }

  const entrada = Object.fromEntries(Object.entries(resumo).map(([campo, valor]) => [campo, valor ?? null]));
  await ref.set({
    clientes: { [clienteId]: { ...entrada, segmento: gravado?.segmento ?? null } },
    versaoResumo: RESUMO_VERSION,
    atualizadoEm: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { acao: 'gravou', bloco };
}

module.exports = {
  CAMPOS_DO_CADASTRO,
  RESUMO_COLLECTION,
  RESUMO_VERSION,
  TOTAL_DE_BLOCOS,
  blocoDoCliente,
  cadastroMudou,
  chaveDoPedido,
  recalcularCliente,
  resumirCliente,
  segmentoDoCliente,
};
