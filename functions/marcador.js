// Marcador de mudancas de cada loja, em estabelecimentos/{loja}/Stats/marcador.
//
// Existe para o painel trocar os streams sempre abertos de pedidos e conversas por uma
// leitura pequena a cada 30 s: o painel le este documento e so rele a lista quando o
// contador dela muda.
//
// Tres contadores: pedidos (pedido gravado), conversas (chat ou mensagem gravados) e
// clientes (resumo de um cliente gravado ou removido em ResumoClientes). A tela Clientes
// segue o de clientes, nao o de pedidos, porque o de pedidos sobe antes de o resumo
// estar pronto.
//
// O marcador so CONTA mudancas. Nao guarda dado de pedido, de conversa nem de cliente:
// apenas um contador e a hora da ultima mudanca de cada tipo.
//
// Arquivo puro: nao requer firebase-admin nem firebase-functions. Recebe db e, para
// gravar, o FieldValue de quem chamou.
const MARCADOR_VERSION = 1;
const MARCADOR_DOCUMENT = 'marcador';
const TIPOS = new Set(['pedidos', 'conversas', 'clientes']);

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

module.exports = {
  MARCADOR_DOCUMENT,
  MARCADOR_VERSION,
  lojasDaConversa,
  marcarMudanca,
};
