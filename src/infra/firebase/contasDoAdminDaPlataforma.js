import { contasDeUsersAdmin } from '../../domain/logs/acaoDoAdmin.js';

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
