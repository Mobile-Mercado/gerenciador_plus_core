// Avisos de Web Push para a loja: pedido novo, mensagem nova do cliente no chat e pedido
// cancelado pelo cliente.
//
// Aqui so a decisao de avisar e o titulo e o texto. O envio (tokens, blocos, desativacao
// de token invalido) fica em enviarAvisoParaLoja, em functions/index.js. O push vai so
// como dados: o Service Worker do painel (public/firebase-messaging-sw.js) monta a
// notificacao visivel a partir de data.title, data.body, data.tag e data.url.
//
// Arquivo puro: nao requer firebase-admin nem firebase-functions.

// Status que o app do cliente grava quando o cliente desiste do pedido
// (mobile_cliente, purchase_firebase_repository_impl.dart).
const STATUS_DESISTENCIA = 'giveUp';
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
  STATUS_DESISTENCIA,
  TAMANHO_DO_TRECHO,
  avisoDeMensagem,
  avisoDePedidoCancelado,
  avisoDePedidoNovo,
  sanitizeString,
  trechoDaMensagem,
};
