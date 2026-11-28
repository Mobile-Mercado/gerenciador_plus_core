import { sessaoValida } from '../../domain/logs/autorDaAcao.js';
import { nomeAutomatico } from '../../domain/sessoes/navegadorDoAgente.js';

// Nome do navegador em "Acessos conectados" (estabelecimentos/{loja}/SessoesWeb/{X-Sessao}), para o
// autor das acoes no Log da equipe (cola B57-13, item 28). Cola B57-18l, item 2: devolve
// { nome, automatico }: o nome dado (ou null) e o nome automatico "{sistema} · {navegador}". Sem sessao
// ou com falha: null ("Navegador sem nome" no web); a acao e gravada do mesmo jeito.
export async function nomeDoComputadorNaLoja(firestore, lojaId, sessaoId) {
  const sessao = sessaoValida(sessaoId);
  if (!sessao || !lojaId) return null;
  try {
    const snapshot = await firestore.doc(`estabelecimentos/${lojaId}/SessoesWeb/${sessao}`).get();
    if (!snapshot.exists) return null;
    const dados = snapshot.data() || {};
    return { nome: dados.nome || null, automatico: dados.navegador ? nomeAutomatico(dados) : null };
  } catch {
    return null;
  }
}
