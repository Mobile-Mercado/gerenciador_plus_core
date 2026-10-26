// Avisos de Web Push para a loja: pedido novo (uma vez por pedido; o pago pelo app so
// quando o pagamento confirma), mensagem nova do cliente no chat e pedido cancelado pelo
// cliente.
//
// Aqui so a decisao de avisar e o titulo e o texto. O envio (tokens, blocos, desativacao
// de token invalido) fica em enviarAvisoParaLoja, em functions/index.js. O push vai so
// como dados: o Service Worker do painel (public/firebase-messaging-sw.js) monta a
// notificacao visivel a partir de data.title, data.body, data.tag e data.url.
//
// Arquivo puro: nao requer firebase-admin nem firebase-functions (o banco e o FieldValue
// chegam por parametro).

// Status que o app do cliente grava quando o cliente desiste do pedido
// (mobile_cliente, purchase_firebase_repository_impl.dart).
const STATUS_DESISTENCIA = 'giveUp';
// Pedido pago pelo app: o app do cliente grava em waitingForOrderPayment antes da cobranca
// e muda para pending quando o pagamento confirma. Pedido pago na entrega nasce em pending.
const STATUS_ESPERANDO_PAGAMENTO_DO_APP = 'waitingForOrderPayment';
const STATUS_PENDENTE = 'pending';
// Marca de "pedido novo ja avisado": um documento por pedido, criado com create(), que
// falha se ja existe. Fica numa subcolecao do pedido (como AuditLog) para nao regravar o
// pedido e nao disparar de novo os gatilhos onDocumentWritten de PurchaseRequests.
const COLECAO_DE_AVISOS_DO_PEDIDO = 'Avisos';
const MARCA_DE_PEDIDO_NOVO = 'pedidoNovo';
// Codigo gRPC ALREADY_EXISTS, devolvido pelo create() do Admin SDK quando o documento existe.
const JA_EXISTE = 6;
const TAMANHO_DO_TRECHO = 80;

// Sanitiza strings para prevenir injecao em notificacoes.
function sanitizeString(str, maxLength = 200) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/<[^>]*>/g, '') // Remove tags HTML
    .replace(/[<>"'&]/g, '') // Remove caracteres perigosos
    .trim()
    .slice(0, maxLength);
}

function idDeReferencia(valor) {
  if (!valor) return '';
  if (typeof valor === 'string') return valor.split('/').filter(Boolean).at(-1) || '';
  if (valor.id) return String(valor.id);
  if (valor.path) return String(valor.path).split('/').filter(Boolean).at(-1) || '';
  return '';
}

function semPrefixo(status) {
  return String(status || '').replace(/^PurchaseStatus\./, '');
}

// Pedido novo: o mesmo titulo e texto que sendOrderNotification sempre mandou.
function avisoDePedidoNovo(order = {}) {
  const orderNumber = sanitizeString(order.orderNumber ? String(order.orderNumber) : '', 20);
  const clientName = sanitizeString(order.clientName, 100) || 'Cliente';
  const title = sanitizeString(order.notificationTitle, 100) || '🔔 Novo Pedido!';
  const body =
    sanitizeString(order.notificationBody, 200) ||
    `Pedido ${orderNumber ? `#${orderNumber}` : ''} de ${clientName}`;
  return { title, body, orderNumber, clientName };
}

// Pedido criado: avisa em qualquer status, menos o pedido pago pelo app ainda sem pagamento.
function avisaPedidoNovoNaCriacao(order = {}) {
  return semPrefixo(order?.currentPurchaseStatus) !== STATUS_ESPERANDO_PAGAMENTO_DO_APP;
}

// Pedido atualizado: avisa so quando o pagamento pelo app confirma, isto e, na troca de
// waitingForOrderPayment para pending.
function avisaPedidoNovoNaAtualizacao({ antes = {}, depois = {} } = {}) {
  return semPrefixo(antes?.currentPurchaseStatus) === STATUS_ESPERANDO_PAGAMENTO_DO_APP
    && semPrefixo(depois?.currentPurchaseStatus) === STATUS_PENDENTE;
}

// Reserva o aviso de pedido novo: cria PurchaseRequests/{pedido}/Avisos/pedidoNovo. Devolve
// true para quem criou e false se o aviso ja foi reservado (pelo outro gatilho ou por uma
// entrega repetida do mesmo evento). Outros erros sobem.
async function reservarAvisoDePedidoNovo({ db, FieldValue, pedidoId, origem }) {
  const marca = db.collection('PurchaseRequests').doc(String(pedidoId))
    .collection(COLECAO_DE_AVISOS_DO_PEDIDO).doc(MARCA_DE_PEDIDO_NOVO);
  try {
    await marca.create({ avisadoEm: FieldValue.serverTimestamp(), origem });
    return true;
  } catch (error) {
    if (error?.code === JA_EXISTE || error?.code === 'already-exists') return false;
    throw error;
  }
}

// Avisa a loja do pedido novo uma vez so por pedido: reserva a marca e so entao envia.
// Se o envio falhar depois da reserva, o aviso nao se repete (no maximo uma vez).
async function avisarPedidoNovoUmaVez({ db, FieldValue, order = {}, pedidoId, companyId, enviar, origem }) {
  const reservado = await reservarAvisoDePedidoNovo({ db, FieldValue, pedidoId, origem });
  if (!reservado) {
    console.log(`[${origem}] Pedido ${pedidoId} ja avisado; nao repete o aviso`);
    return null;
  }
  const { title, body, orderNumber, clientName } = avisoDePedidoNovo(order);
  return enviar({
    companyId,
    title,
    body,
    url: '/pedidos',
    tag: pedidoId,
    data: { orderId: pedidoId, orderNumber: orderNumber || '', clientName },
    origem,
  });
}

// Comeco da mensagem com ate 80 caracteres; o corte termina em reticencias.
function trechoDaMensagem(texto) {
  const limpo = sanitizeString(texto, 1000).replace(/\s+/g, ' ');
  if (limpo.length <= TAMANHO_DO_TRECHO) return limpo;
  return `${limpo.slice(0, TAMANHO_DO_TRECHO - 1).trimEnd()}…`;
}

// Nome do cliente no chat: o nome da ponta que nao e a loja.
function nomeDoClienteNoChat(chat = {}, lojaId) {
  const nome = idDeReferencia(chat.senderId) === lojaId ? chat.receiverName : chat.senderName;
  return sanitizeString(nome, 100) || sanitizeString(chat.clientName, 100) || 'Cliente';
}

// Mensagem nova no chat. So avisa quando quem enviou e o cliente: mensagem de qualquer
// loja do chat (painel ou app do lojista gravam o id da loja em senderId) nao avisa.
function avisoDeMensagem({ chat = {}, mensagem = {}, chatId, lojaId, lojasDoChat = [lojaId] }) {
  const remetente = idDeReferencia(mensagem.senderId);
  if (!remetente || lojasDoChat.includes(remetente)) return null;
  const nome = nomeDoClienteNoChat(chat, lojaId);
  const texto = trechoDaMensagem(mensagem.mensage || mensagem.message || '');
  return {
    title: 'Mensagem nova',
    body: texto ? `${nome}: ${texto}` : `${nome} enviou uma mensagem`,
    url: '/mensagens',
    tag: `chat-${chatId}`,
    data: { chatId },
  };
}

// Pedido cancelado pelo cliente: so na troca de outro status para a desistencia.
function avisoDePedidoCancelado({ antes = {}, depois = {}, pedidoId }) {
  const statusAntes = semPrefixo(antes?.currentPurchaseStatus);
  const statusDepois = semPrefixo(depois?.currentPurchaseStatus);
  if (statusDepois !== STATUS_DESISTENCIA || statusAntes === STATUS_DESISTENCIA) return null;
  const numero = sanitizeString(depois.orderNumber ? String(depois.orderNumber) : '', 20)
    || String(pedidoId || '').slice(-6).toUpperCase();
  const cliente = sanitizeString(depois.clientName, 100) || 'Cliente';
  return {
    title: 'Pedido cancelado pelo cliente',
    body: `Pedido #${numero.replace(/^#/, '')} de ${cliente}`,
    url: '/pedidos',
    tag: pedidoId,
    data: { orderId: pedidoId, orderNumber: numero, clientName: cliente },
  };
}

module.exports = {
  COLECAO_DE_AVISOS_DO_PEDIDO,
  MARCA_DE_PEDIDO_NOVO,
  STATUS_DESISTENCIA,
  STATUS_ESPERANDO_PAGAMENTO_DO_APP,
  STATUS_PENDENTE,
  TAMANHO_DO_TRECHO,
  avisaPedidoNovoNaAtualizacao,
  avisaPedidoNovoNaCriacao,
  avisarPedidoNovoUmaVez,
  avisoDeMensagem,
  avisoDePedidoCancelado,
  avisoDePedidoNovo,
  reservarAvisoDePedidoNovo,
  sanitizeString,
  trechoDaMensagem,
};
