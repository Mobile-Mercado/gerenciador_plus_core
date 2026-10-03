// Resumo dos pedidos de cada loja, em estabelecimentos/{loja}/ResumoPedidos/{mes}.
//
// Existe para a tela Pedidos parar de assinar todos os pedidos da loja: o pedido inteiro
// tem uns 15 KB e a tela so usa o que o card e os filtros mostram. O painel le so os
// meses do periodo escolhido e o documento `abertos`.
//
// Documentos:
//   {AAAA-MM}  pedidos criados naquele mes, no fuso America/Sao_Paulo ('sem-data' quando
//              o pedido nao tem createdAt);
//   abertos    so os pedidos que ainda nao estao encerrados, de qualquer mes.
// Os dois tem o formato { pedidos: { [pedidoId]: resumo }, versaoResumo, atualizadoEm }.
//
// REGRA QUE PRENDE ESTE ARQUIVO AO PAINEL: o resumo e COPIA de mapOrder e das funcoes que
// ele usa, no web_gerenciador_plus:
//   - src/features/orders/usePedidosRealtimeBridge.js (normalizeStatus, toDate, toNumber,
//     getNestedValue, getProductTotal, getOrderTotal, getClientName, getOrderChannel,
//     getAddress, getAddressSearchText, getShortAddress, getOrderNumber, getSeal, mapOrder);
//   - src/features/orders/enderecoDoPedido.js (partesDoEndereco, cidadeUfCep,
//     enderecoEmUmaLinha);
//   - src/features/orders/testOrders.js (isTestOrder);
//   - src/features/clients/useClientsRealtimeBridge.js (getClientId) e
//     src/shared/clientPanel.js (refId);
//   - versao 2: src/features/dashboard/useFinanceBridge.js (detectPaymentCategory e os
//     campos de classifyPayment) e useEarningsBridge.js (price sem frete).
// Mudou a regra la, muda aqui. Fica de fora so o que e de tela (rotulo, classe, cor e data
// formatada) e withLocalTestFlags, que so existe na memoria da aba.
//
// Arquivo puro: nao requer firebase-admin nem firebase-functions. Para gravar, recebe db e
// o FieldValue de quem chamou.
const { marcarMudanca } = require('./marcador');

const RESUMO_PEDIDOS_VERSION = 2;
const RESUMO_PEDIDOS_COLLECTION = 'ResumoPedidos';
const DOCUMENTO_ABERTOS = 'abertos';
const MES_SEM_DATA = 'sem-data';
const TIME_ZONE = 'America/Sao_Paulo';

// Mesmos status do STATUS_ENCERRADOS do Core (ManagerDataAccessPolicy.js).
const STATUS_ENCERRADOS = new Set([
  'completed', 'delivered', 'denied', 'giveUp', 'return',
  'canceled', 'cancelled', 'cancelado',
]);

// ----- Copia de usePedidosRealtimeBridge.js -----

function normalizeStatus(status = '') {
  return String(status || '').replace('PurchaseStatus.', '') || 'indefinido';
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === 'function') return value.toDate();
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (typeof value.seconds === 'number') return new Date(value.seconds * 1000);
  return null;
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[^\d,.-]/g, '');
    const normalized = cleaned.includes(',')
      ? cleaned.replaceAll('.', '').replace(',', '.')
      : cleaned;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function getNestedValue(source, paths) {
  for (const path of paths) {
    const value = path.split('.').reduce((current, key) => current?.[key], source);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
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

  if (Array.isArray(data.productsCart)) {
    return data.productsCart.reduce((sum, item) => sum + getProductTotal(item), 0);
  }

  return 0;
}

function getClientName(data) {
  return (
    getNestedValue(data, ['clientName', 'customerName', 'client.name', 'customer.name', 'user.name']) ||
    'Cliente não identificado'
  );
}

function getOrderChannel(data) {
  if (data.agentOrder || data.isAgentOrder || data.createdByAgent || data.fromAgent) return 'agent';
  const source = String(
    getNestedValue(data, ['channel', 'source', 'origin', 'platform', 'orderChannel', 'purchaseOrigin', 'createdBy']) || '',
  ).toLowerCase();
  return /(agent|agente|whatsapp|chat|ia)/.test(source) ? 'agent' : 'app';
}

function getAddress(data) {
  return enderecoEmUmaLinha(data.address || data.deliveryAddress || data.clientAddress);
}

function getAddressSearchText(data) {
  const endereco = data.address || data.deliveryAddress || data.clientAddress;
  const completo = typeof endereco === 'object' && endereco ? endereco.fullAddress : '';
  return [completo, getAddress(data), cidadeUfCep(endereco)].filter(Boolean).join(' ');
}

function getShortAddress(data) {
  const objectAddress = [data.address, data.deliveryAddress, data.clientAddress]
    .find((value) => value && typeof value === 'object');
  if (!objectAddress) return getAddress(data);

  let number = String(objectAddress.number || objectAddress.numero || '').trim();
  const neighborhood = String(objectAddress.neighborhood || objectAddress.bairro || '').trim();
  const streetParts = [];
  String(objectAddress.street || objectAddress.logradouro || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const numberPart = part.match(/^n\s*[º°o.]?\s*(\d+\S*)$/i);
      if (numberPart) {
        if (!number) number = numberPart[1];
        return;
      }
      if (!streetParts.some((item) => item.toLowerCase() === part.toLowerCase())) streetParts.push(part);
    });
  const street = streetParts.join(', ').replace(/^avenida\b\.?\s*/i, 'Av. ');
  const head = [street, number].filter(Boolean).join(', ');
  if (!head) return getAddress(data);
  return neighborhood ? `${head} · ${neighborhood}` : head;
}

function getOrderNumber(data, fallbackId) {
  const number = data.orderNumber || data.number || data.codigo || data.code;
  if (number) return `#${String(number).replace(/^#/, '')}`;
  return `#${fallbackId.slice(-6).toUpperCase()}`;
}

// getSeal devolve rotulo e classe; o resumo guarda so a chave.
function getSeal(data) {
  if (data.clientIsVip || data.vip || data.client?.vip) return 'vip';
  if (data.recurring || data.isRecurring || Number(data.clientOrderCount || 0) > 1) return 'recorrente';
  return 'comum';
}

// ----- Copia de enderecoDoPedido.js -----

const ENDERECO_NAO_INFORMADO = 'Endereço não informado';

function texto(valor) {
  if (typeof valor === 'number') return String(valor);
  return typeof valor === 'string' ? valor.trim() : '';
}

function partesDoEndereco(endereco) {
  if (typeof endereco === 'string') {
    return { ruaNumeroComplemento: endereco.trim() || ENDERECO_NAO_INFORMADO, bairro: '', referencia: '' };
  }
  const campos = endereco && typeof endereco === 'object' ? endereco : {};
  const referencia = texto(campos.reference) || texto(campos.referencia);
  const rua = texto(campos.street) || texto(campos.logradouro);
  if (!rua) {
    return { ruaNumeroComplemento: texto(campos.fullAddress) || ENDERECO_NAO_INFORMADO, bairro: '', referencia };
  }
  const numero = texto(campos.number) || texto(campos.numero);
  const complemento = texto(campos.complement) || texto(campos.complemento);
  const ruaComNumero = [rua, numero].filter(Boolean).join(', ');
  return {
    ruaNumeroComplemento: [ruaComNumero, complemento].filter(Boolean).join(' - '),
    bairro: texto(campos.neighborhood) || texto(campos.bairro),
    referencia,
  };
}

function cidadeUfCep(endereco) {
  if (!endereco || typeof endereco !== 'object') return '';
  if (!(texto(endereco.street) || texto(endereco.logradouro))) return '';
  const cep = texto(endereco.zipCode) || texto(endereco.cep);
  return [
    texto(endereco.city) || texto(endereco.cidade),
    texto(endereco.uf) || texto(endereco.state) || texto(endereco.estado),
    cep ? `CEP ${cep}` : '',
  ].filter(Boolean).join(', ');
}

function enderecoEmUmaLinha(endereco) {
  const { ruaNumeroComplemento, bairro } = partesDoEndereco(endereco);
  return [ruaNumeroComplemento, bairro].filter(Boolean).join(' · ');
}

// ----- Copia de testOrders.js, useClientsRealtimeBridge.js e clientPanel.js -----

function isTestOrder(data) {
  return data?.isTest === true || data?.isTestAccount === true;
}

function refId(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.split('/').filter(Boolean).at(-1) || value;
  return value.id || value.path?.split('/').filter(Boolean).at(-1) || '';
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

// ----- Copia de useFinanceBridge.js (forma de pagamento) -----

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function detectPaymentCategory(rawType) {
  const cleaned = normalizeText(String(rawType || '').replace('PaymentType.', ''));
  if (!cleaned) return null;
  if (cleaned.includes('pix')) return { key: 'pix', label: 'Pix' };
  if (cleaned.includes('cash') || cleaned.includes('money') || cleaned.includes('dinheiro') || cleaned.includes('especie')) {
    return { key: 'dinheiro', label: 'Dinheiro' };
  }
  if (cleaned.includes('credit') || cleaned.includes('debit') || cleaned.includes('card') || cleaned.includes('cartao')) {
    return { key: 'cartao', label: 'Cartão' };
  }
  return null;
}

// Categoria do pagamento como classifyPayment le do pedido. O nome mostrado continua
// vindo dos paymentMethods da loja, no painel; aqui fica so a categoria detectada.
function formaDePagamento(data) {
  const raw = getNestedValue(data, [
    'purchasePayment.paymentType',
    'purchasePayment.method',
    'purchasePayment.type',
    'payment.paymentType',
    'payment.method',
    'payment.type',
    'payment.paymentMethod',
    'payment.name',
    'payment.id',
    'paymentMethod',
    'paymentType',
  ]);
  return detectPaymentCategory(raw)?.key || null;
}

// Valor da venda pela regra unica (useEarningsBridge.js): o price do pedido, sem frete.
function precoDaVenda(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// ----- Resumo -----

const emMilissegundos = (date) => (date ? date.getTime() : null);

// O que mapOrder devolve, sem a parte de tela. Datas em milissegundos.
function resumirPedido(id, data = {}) {
  const status = normalizeStatus(
    data.currentPurchaseStatus || data.purchaseStatus || data.status || data.stats,
  );
  const createdAt = toDate(data.createdAt);
  const statusList = Array.isArray(data.statusList) ? data.statusList : [];
  const acceptedEntry = statusList.find((entry) => normalizeStatus(entry?.purchaseStatus) === 'accepted');
  const statusDates = statusList.map((entry) => toDate(entry?.createdAt)).filter(Boolean);
  const productsCount = Array.isArray(data.productsCart) ? data.productsCart.length : 0;

  const resumo = {
    id,
    clientId: getClientId(data),
    clientName: getClientName(data),
    orderNumber: getOrderNumber(data, id),
    status,
    createdAt: emMilissegundos(createdAt),
    acceptedAt: emMilissegundos(toDate(acceptedEntry?.createdAt) || createdAt),
    statusChangedAt: statusDates.length
      ? Math.max(...statusDates.map((date) => date.getTime()))
      : emMilissegundos(createdAt),
    address: getAddress(data),
    addressSearch: getAddressSearchText(data),
    shortAddress: getShortAddress(data),
    neighborhood: String(
      getNestedValue(data, ['address.neighborhood', 'address.bairro', 'deliveryAddress.neighborhood', 'deliveryAddress.bairro']) || '',
    ).trim(),
    deliveryPerson: String(data.deliveryPerson?.name || '').trim(),
    total: getOrderTotal(data),
    productsCount,
    channel: getOrderChannel(data),
    isTest: isTestOrder(data),
    isTestAccount: data.isTestAccount === true,
    paymentMode: String(data.purchasePayment?.mode || '').trim(),
    paymentStatus: String(data.purchasePayment?.paymentStatus || '').trim(),
    selo: getSeal(data),
    // Versao 2: valor da venda, data do pagamento e forma de pagamento.
    price: precoDaVenda(data.price),
    paidAt: emMilissegundos(toDate(data.paidAt)),
    formaPagamento: formaDePagamento(data),
  };
  // Campo ausente vira null: o merge nunca deixa sobra de versao antiga.
  return Object.fromEntries(Object.entries(resumo).map(([campo, valor]) => [campo, valor ?? null]));
}

const formatadorDeMes = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit',
});

// Mes de criacao no fuso de Sao Paulo, 'AAAA-MM'; sem data, 'sem-data'.
function mesDoPedido(createdAt) {
  const date = toDate(createdAt);
  if (!date || Number.isNaN(date.getTime())) return MES_SEM_DATA;
  const partes = {};
  formatadorDeMes.formatToParts(date).forEach(({ type, value }) => { partes[type] = value; });
  return `${partes.year}-${partes.month}`;
}

function pedidoAberto(status) {
  return !STATUS_ENCERRADOS.has(normalizeStatus(status));
}

function statusDoPedido(data) {
  return data.currentPurchaseStatus || data.purchaseStatus || data.status || data.stats;
}

// Mesma regra do extractCompanyId de functions/index.js; o gatilho passa o dele.
function lojaDoPedidoPadrao(data = {}) {
  if (data.companyId) return String(data.companyId);
  const ref = data.companyReference || data.companyRef;
  if (!ref) return null;
  if (typeof ref === 'string') return ref.split('/').filter(Boolean).at(-1) || null;
  if (ref.id) return String(ref.id);
  if (ref.path) return String(ref.path).split('/').filter(Boolean).at(-1) || null;
  return null;
}

// Onde o pedido mora no resumo: loja, mes, se esta aberto e o resumo em si.
function localDoPedido(pedidoId, data, lojaDe) {
  if (!data) return null;
  const lojaId = lojaDe(data);
  if (!lojaId) return null;
  return {
    lojaId: String(lojaId),
    mes: mesDoPedido(data.createdAt),
    aberto: pedidoAberto(statusDoPedido(data)),
    resumo: resumirPedido(pedidoId, data),
  };
}

function resumoReference(db, lojaId, documento) {
  return db.collection('estabelecimentos').doc(lojaId).collection(RESUMO_PEDIDOS_COLLECTION).doc(documento);
}

// Atualiza o resumo de um pedido a partir do antes e do depois da gravacao. Merge com
// objeto aninhado (e nao caminho com ponto) para o id nunca virar caminho, como
// recalcularCliente. Sem mudanca no resumo, na loja e no mes, nao grava nada: escrita so
// em campo que o card nao mostra (conferenciaEntrega, por exemplo) nao custa gravacao.
async function atualizarResumoDoPedido({
  db, FieldValue, antes = null, depois = null, pedidoId, lojaDe = lojaDoPedidoPadrao,
}) {
  const velho = localDoPedido(pedidoId, antes, lojaDe);
  const novo = localDoPedido(pedidoId, depois, lojaDe);
  if (!velho && !novo) return { acao: 'nada', lojas: [] };

  const mesmoLugar = velho && novo && velho.lojaId === novo.lojaId && velho.mes === novo.mes;
  if (mesmoLugar && velho.aberto === novo.aberto
    && JSON.stringify(velho.resumo) === JSON.stringify(novo.resumo)) {
    return { acao: 'nada', lojas: [] };
  }

  const carimbo = () => ({ versaoResumo: RESUMO_PEDIDOS_VERSION, atualizadoEm: FieldValue.serverTimestamp() });
  const gravar = (lojaId, documento, valor) => resumoReference(db, lojaId, documento)
    .set({ pedidos: { [pedidoId]: valor }, ...carimbo() }, { merge: true });
  const gravacoes = [];

  // Saida do lugar antigo: pedido apagado, que trocou de loja ou de mes.
  if (velho && !(novo && novo.lojaId === velho.lojaId && novo.mes === velho.mes)) {
    gravacoes.push(gravar(velho.lojaId, velho.mes, FieldValue.delete()));
  }
  if (velho && velho.aberto && !(novo && novo.lojaId === velho.lojaId)) {
    gravacoes.push(gravar(velho.lojaId, DOCUMENTO_ABERTOS, FieldValue.delete()));
  }

  if (novo) {
    gravacoes.push(gravar(novo.lojaId, novo.mes, novo.resumo));
    if (novo.aberto) {
      gravacoes.push(gravar(novo.lojaId, DOCUMENTO_ABERTOS, novo.resumo));
    } else if (velho && velho.aberto && velho.lojaId === novo.lojaId) {
      // Acabou de encerrar: sai de abertos. Pedido que ja estava encerrado nao grava em abertos.
      gravacoes.push(gravar(novo.lojaId, DOCUMENTO_ABERTOS, FieldValue.delete()));
    }
  }

  await Promise.all(gravacoes);
  // Contagem por status dos meses tocados, recontada do mapa ja gravado.
  const mesesTocados = new Map();
  [velho, novo].filter(Boolean).forEach(({ lojaId, mes }) => mesesTocados.set(`${lojaId}|${mes}`, { lojaId, mes }));
  await Promise.all([...mesesTocados.values()].map(({ lojaId, mes }) => recontarMes({ db, FieldValue, lojaId, mes })));
  const lojas = [...new Set([velho?.lojaId, novo?.lojaId].filter(Boolean))];
  await Promise.all(lojas.map((lojaId) => marcarMudanca({ db, FieldValue, lojaId, tipo: 'listaDePedidos' })));
  return { acao: novo ? 'gravou' : 'removeu', lojas };
}

// ----- Contagem por status (cards Pedidos, Entregues e Cancelados da Home) -----
//
// Copia de useDailyStatsBridge.js (web_gerenciador_plus/src/features/dashboard), com
// purchaseStatus.js e testOrders.js. Conta status, nao venda: por isso nao sai do
// ResumoVendas. O mes e o de criacao, o mesmo do ResumoPedidos, e a conta sai sempre do
// mapa pedidos do mes inteiro: numero exato, sem soma dupla.
// Unica diferenca possivel: o status do resumo cai para o campo stats quando os outros
// tres faltam; o card nao le stats. Nenhum pedido real das lojas depende disso (medido em
// 03/10/2026).
const CONTAGEM_COLLECTION = 'ResumoPedidosContagem';
const CONTAGEM_VERSION = 1;

const NOT_CONCRETIZED_STATUSES = new Set(['canceled', 'denied', 'giveup', 'refundrequested']);
const OPEN_STATUSES = new Set(['pending', 'waitingfororderpayment']);
const DELIVERED_STATUSES = new Set(['completed', 'delivered']);
const CANCELED_STATUSES = new Set(['canceled', 'cancelled']);
const confirmedPurchaseStatuses = new Set([
  'accepted',
  'picking',
  'separatingorder',
  'waitingfordelivery',
  'waiting',
  'deliveryroute',
  'on_route',
  'completed',
  'delivered',
]);

function normalizePurchaseStatus(value) {
  return String(value || '')
    .replace(/^PurchaseStatus\./i, '')
    .trim()
    .toLowerCase();
}

function isConfirmedPurchaseStatus(value) {
  return confirmedPurchaseStatuses.has(normalizePurchaseStatus(value));
}

// Grupos do card com os nomes do painel: confirmed (Pedidos), notConcretized (nao se
// concretizaram), open (em aberto), delivered (Entregues) e canceled (Cancelados).
const contagemVazia = () => ({
  app: { confirmed: 0, notConcretized: 0, open: 0, delivered: 0, canceled: 0 },
  agent: { confirmed: 0, notConcretized: 0, open: 0, delivered: 0, canceled: 0 },
});

// Conta os pedidos do mapa de um mes como summarizeOrders conta a janela. Teste fica fora,
// pedido sem data fica fora e status fora das tres regras fica fora.
function contagemDoMes(pedidos = {}) {
  const contagem = contagemVazia();
  Object.values(pedidos).forEach((resumo) => {
    if (!resumo || resumo.isTest === true) return;
    if (resumo.createdAt === null || resumo.createdAt === undefined) return;
    const rawStatus = resumo.status === 'indefinido' ? '' : resumo.status;
    const status = normalizePurchaseStatus(rawStatus);
    const group = isConfirmedPurchaseStatus(rawStatus)
      ? 'confirmed'
      : NOT_CONCRETIZED_STATUSES.has(status)
        ? 'notConcretized'
        : OPEN_STATUSES.has(status) ? 'open' : null;
    if (!group) return;
    const channel = resumo.channel === 'agent' ? 'agent' : 'app';
    contagem[channel][group] += 1;
    if (DELIVERED_STATUSES.has(status)) contagem[channel].delivered += 1;
    if (CANCELED_STATUSES.has(status)) contagem[channel].canceled += 1;
  });
  return contagem;
}

function contagemReference(db, lojaId, mes) {
  return db.collection('estabelecimentos').doc(lojaId).collection(CONTAGEM_COLLECTION).doc(mes);
}

const mesmasContagens = (a, b) => ['app', 'agent'].every((canal) => Object.keys(contagemVazia().app)
  .every((grupo) => Number(a?.[canal]?.[grupo] || 0) === Number(b?.[canal]?.[grupo] || 0)));

// Le o mes em transacao, reconta e grava so se mudou. Mes sem data nao tem contagem: o
// card deixa de fora pedido sem createdAt.
async function recontarMes({ db, FieldValue, lojaId, mes }) {
  if (mes === MES_SEM_DATA) return false;
  return db.runTransaction(async (transacao) => {
    const [mesSnap, contagemSnap] = await Promise.all([
      transacao.get(resumoReference(db, lojaId, mes)),
      transacao.get(contagemReference(db, lojaId, mes)),
    ]);
    const contagem = contagemDoMes(mesSnap.exists ? mesSnap.get('pedidos') || {} : {});
    if (contagemSnap.exists && mesmasContagens(contagemSnap.data(), contagem)) return false;
    transacao.set(contagemReference(db, lojaId, mes), {
      ...contagem,
      versaoContagem: CONTAGEM_VERSION,
      atualizadoEm: FieldValue.serverTimestamp(),
    });
    return true;
  });
}

module.exports = {
  CONTAGEM_COLLECTION,
  CONTAGEM_VERSION,
  DOCUMENTO_ABERTOS,
  contagemDoMes,
  recontarMes,
  MES_SEM_DATA,
  RESUMO_PEDIDOS_COLLECTION,
  RESUMO_PEDIDOS_VERSION,
  STATUS_ENCERRADOS,
  atualizarResumoDoPedido,
  lojaDoPedidoPadrao,
  mesDoPedido,
  pedidoAberto,
  formaDePagamento,
  getOrderTotal,
  resumirPedido,
};
