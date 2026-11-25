import { sessaoValida } from '../../domain/logs/autorDaAcao.js';

// Nome do navegador em "Acessos conectados" (estabelecimentos/{loja}/SessoesWeb/{X-Sessao}.nome), para o
// autor das acoes no Log da equipe (cola B57-13, item 28). Sem sessao, sem nome ou com falha: null
// ("Navegador sem nome" no web); a acao e gravada do mesmo jeito.
export async function nomeDoComputadorNaLoja(firestore, lojaId, sessaoId) {
  const sessao = sessaoValida(sessaoId);
  if (!sessao || !lojaId) return null;
  try {
    const snapshot = await firestore.doc(`estabelecimentos/${lojaId}/SessoesWeb/${sessao}`).get();
    return snapshot.exists ? snapshot.data()?.nome || null : null;
  } catch {
    return null;
  }
}
