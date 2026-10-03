// Marcador de mudancas de cada loja, em estabelecimentos/{loja}/Stats/marcador.
//
// Existe para o painel trocar os streams sempre abertos de pedidos e conversas por uma
// leitura pequena a cada 30 s: o painel le este documento e so rele a lista quando o
// contador dela muda.
//
// Cinco contadores: pedidos (pedido gravado), conversas (chat ou mensagem gravados),
// clientes (resumo de um cliente gravado ou removido em ResumoClientes), listaDePedidos
// (resumo de um pedido gravado ou removido em ResumoPedidos) e vendas (soma de vendas
// mudou em ResumoVendas, lida pela Home e pelo Financeiro). As telas Clientes e Pedidos
// seguem o contador do resumo delas, nao o de pedidos, porque o de pedidos sobe antes de
// o resumo estar pronto.
//
// Quem soma, em functions/index.js:
//   pedidos   marcarPedidoNoMarcador            PurchaseRequests/{orderId} gravado
//   conversas marcarConversaNoMarcador          Chats/{chatId} gravado
//             marcarMensagemNoMarcador          Chats/{chatId}/Messages/{id} criado
//             marcarConversaDoAgenteNoMarcador  AgenteVendas/{u}/conversas/{c} gravado
//             marcarMensagemDoAgenteNoMarcador  AgenteVendas/{u}/conversas/{c}/mensagens/{id} criado
//   clientes  recalcularCliente (resumoClientes.js), segmentarClientesNightly e o script
//             gerarResumoClientes.js
//   listaDePedidos resumirPedidoNaLista (atualizarResumoDoPedido, resumoPedidos.js) e o
//             script gerarResumoPedidos.js: o resumo de um pedido mudou em ResumoPedidos
//   vendas    resumirVendasDoPedido (atualizarResumoDeVendas, resumoVendas.js) e o script
//             gerarResumoVendas.js
//
// O marcador so CONTA mudancas. Nao guarda dado de pedido, de conversa nem de cliente:
// apenas um contador e a hora da ultima mudanca de cada tipo.
//
// Arquivo puro: nao requer firebase-admin nem firebase-functions. Recebe db e, para
// gravar, o FieldValue de quem chamou.
const MARCADOR_VERSION = 1;
const MARCADOR_DOCUMENT = 'marcador';
const TIPOS = new Set(['pedidos', 'conversas', 'clientes', 'listaDePedidos', 'vendas']);

function idDeReferencia(valor) {
  if (!valor) return '';
  if (typeof valor === 'string') return valor.split('/').filter(Boolean).at(-1) || '';
  if (valor.id) return String(valor.id);
  if (valor.path) return String(valor.path).split('/').filter(Boolean).at(-1) || '';
  return '';
}

function marcadorReference(db, lojaId) {
  return db.collection('estabelecimentos').doc(lojaId).collection('Stats').doc(MARCADOR_DOCUMENT);
}

async function marcarMudanca({ db, FieldValue, lojaId, tipo }) {
  if (!TIPOS.has(tipo)) throw new Error(`Tipo de marcador invalido: ${tipo}`);
  if (!lojaId) return;
  await marcadorReference(db, String(lojaId)).set({
    [tipo]: FieldValue.increment(1),
    [`${tipo}Em`]: FieldValue.serverTimestamp(),
    versaoMarcador: MARCADOR_VERSION,
  }, { merge: true });
}

// As pontas de um documento de Chats que sao lojas. A outra ponta e usuario (id de Users
// ou uid do Authentication) e nunca recebe marcador: so passa o id que existe como
// documento em estabelecimentos.
async function lojasDaConversa({ db, chat }) {
  const ids = [...new Set([idDeReferencia(chat?.senderId), idDeReferencia(chat?.receiverId)])]
    .filter(Boolean);
  const snapshots = await Promise.all(ids.map((id) => db.collection('estabelecimentos').doc(id).get()));
  return ids.filter((_id, indice) => snapshots[indice].exists);
}

// Loja de uma conversa do agente (AgenteVendas/{u}/conversas/{c}): o companyId do
// documento depois da gravacao ou, se ele foi apagado, o de antes. Sem companyId, null.
function lojaDaConversaDoAgente({ antes = null, depois = null } = {}) {
  const dados = depois || antes;
  const lojaId = typeof dados?.companyId === 'string' ? dados.companyId.trim() : '';
  return lojaId || null;
}

module.exports = {
  MARCADOR_DOCUMENT,
  MARCADOR_VERSION,
  lojaDaConversaDoAgente,
  lojasDaConversa,
  marcarMudanca,
};
