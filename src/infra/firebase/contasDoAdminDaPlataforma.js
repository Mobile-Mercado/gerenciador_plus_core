import { caminhosDoAdminNasAcoes, contasDeUsersAdmin } from '../../domain/logs/acaoDoAdmin.js';

// Cola do Thay B57-13k, item 35: e-mails e uids das contas de usersAdmin (inclusive as que ja
// perderam o acesso: o que fizeram como Admin continua sendo do Admin), lidos uma vez a cada 5
// minutos por banco.
const VALIDADE_MS = 5 * 60 * 1000;
const guardadas = new WeakMap();

export async function contasDoAdminDaPlataforma(firestore, { agora = Date.now() } = {}) {
  const guardada = guardadas.get(firestore);
  if (guardada && guardada.ate > agora) return guardada.contas;
  const snapshot = await firestore.collection('usersAdmin').get();
  const contas = contasDeUsersAdmin(snapshot.docs.map((documento) => ({ id: documento.id, data: documento.data() })));
  guardadas.set(firestore, { contas, ate: agora + VALIDADE_MS });
  return contas;
}

// Cola B57-13p, item 35: os documentos de AcoesEquipe que o Admin gravou na loja, pelo registro que
// ele deixa nela (AdminAuditLogs, action 'admin_plataforma'). Guardado por 1 minuto por loja.
const CAMINHOS_VALIDADE_MS = 60 * 1000;
const caminhosGuardados = new WeakMap();

export async function caminhosDoAdminNaLoja(firestore, lojaId, { agora = Date.now() } = {}) {
  let porLoja = caminhosGuardados.get(firestore);
  if (!porLoja) {
    porLoja = new Map();
    caminhosGuardados.set(firestore, porLoja);
  }
  const guardado = porLoja.get(lojaId);
  if (guardado && guardado.ate > agora) return guardado.caminhos;
  const snapshot = await firestore.collection('estabelecimentos').doc(lojaId).collection('AdminAuditLogs')
    .where('action', '==', 'admin_plataforma')
    .get();
  const caminhos = caminhosDoAdminNasAcoes(snapshot.docs.map((documento) => documento.data()), lojaId);
  porLoja.set(lojaId, { caminhos, ate: agora + CAMINHOS_VALIDADE_MS });
  return caminhos;
}
