// Cola 65, item 3.8: a rotina da madrugada tira do produto a promocao que ja venceu e que NAO
// veio do ERP. Promocao do ERP (promotionSource 'erp', gravado pelo integrador 1.0.35:
// constants.dart promotionSourceErp, mobile_old_web_platform updateProductsIntoCompany.ts) fica
// com o integrador, que ja a limpa quando a regra do ERP acaba.
//
// "Vencida": promotionEndAt gravado e anterior ao instante da rotina. Sem promotionEndAt a
// promocao nao tem fim e fica. Sem promotionalPrice (null ou ausente) nao ha promocao e nada e
// gravado. Remover e gravar os quatro campos da promocao em null, como o Gerenciador web grava
// ao tirar a promocao (web_gerenciador_plus promocao.js, camposDaPromocao).
//
// Cada remocao entra no Log das acoes da equipe (estabelecimentos/{loja}/AcoesEquipe, cola 65,
// item 3.5), no formato do web (registrarAcao.js), na mesma transacao da gravacao do produto:
// ou os dois entram, ou nenhum.
//
// Arquivo puro: recebe db, FieldValue e Timestamp por parametro.

const ORIGEM = 'removerPromocaoVencidaNightly';
const ORIGEM_DO_ERP = 'erp';
const CAMPOS_DA_PROMOCAO = Object.freeze(['promotionalPrice', 'promotionStartAt', 'promotionEndAt', 'promotionSource']);

function emMilissegundos(valor) {
  if (valor === null || valor === undefined) return null;
  if (typeof valor.toMillis === 'function') return valor.toMillis();
  if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? null : valor.getTime();
  if (typeof valor.seconds === 'number') return valor.seconds * 1000;
  if (typeof valor._seconds === 'number') return valor._seconds * 1000;
  return null;
}

function veioDoErp(produto) {
  return String(produto?.promotionSource ?? '').trim().toLowerCase() === ORIGEM_DO_ERP;
}

function promocaoVencidaForaDoErp(produto, agoraMs) {
  if (!produto || veioDoErp(produto)) return false;
  if (produto.promotionalPrice === null || produto.promotionalPrice === undefined) return false;
  const fim = emMilissegundos(produto.promotionEndAt);
  return fim !== null && fim < agoraMs;
}

// So os campos que mudam (null e ausente contam como iguais, como camposQueMudaram do web).
function mudancaDaRemocao(produto) {
  const campos = CAMPOS_DA_PROMOCAO.filter((campo) => produto[campo] !== null && produto[campo] !== undefined);
  return {
    antes: Object.fromEntries(campos.map((campo) => [campo, produto[campo]])),
    depois: Object.fromEntries(campos.map((campo) => [campo, null])),
  };
}

function registroDaRemocao({ produtoId, produto, FieldValue }) {
  const { antes, depois } = mudancaDaRemocao(produto);
  return {
    em: FieldValue.serverTimestamp(),
    // Rotina, sem pessoa: quem fica vazio e a origem diz qual rotina foi.
    quem: '',
    tela: 'produtos',
    acao: 'produto.editar',
    alvo: { tipo: 'produto', id: produtoId, rotulo: produto.name || produtoId },
    antes,
    depois,
    origem: ORIGEM,
  };
}

// Uma loja. A consulta usa so promotionEndAt (indice simples, que o Firestore cria sozinho); a
// origem e conferida aqui. Cada produto vai numa transacao que le de novo e confere de novo: se o
// integrador ou o lojista mudou a promocao entre a consulta e a gravacao, nada e gravado.
async function removerPromocoesVencidasDaLoja({ db, FieldValue, Timestamp, lojaId, agora = new Date() }) {
  const agoraMs = agora.getTime();
  const loja = db.collection('estabelecimentos').doc(lojaId);
  const snapshot = await loja.collection('Products')
    .where('promotionEndAt', '<', Timestamp.fromMillis(agoraMs))
    .get();
  const candidatos = snapshot.docs.filter((documento) => promocaoVencidaForaDoErp(documento.data(), agoraMs));
  let removidas = 0;
  let falhas = 0;
  for (const candidato of candidatos) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const removeu = await db.runTransaction(async (transacao) => {
        const atual = await transacao.get(candidato.ref);
        const produto = atual.exists ? atual.data() || {} : null;
        if (!produto || !promocaoVencidaForaDoErp(produto, agoraMs)) return false;
        transacao.update(candidato.ref, {
          promotionalPrice: null,
          promotionStartAt: null,
          promotionEndAt: null,
          promotionSource: null,
          updatedAt: FieldValue.serverTimestamp(),
        });
        transacao.create(
          loja.collection('AcoesEquipe').doc(),
          registroDaRemocao({ produtoId: candidato.id, produto, FieldValue }),
        );
        return true;
      });
      if (removeu) removidas += 1;
    } catch (error) {
      falhas += 1;
      console.error(`[${ORIGEM}] Falha no produto`, { establishmentId: lojaId, productId: candidato.id, error });
    }
  }
  return { vencidas: candidatos.length, removidas, falhas };
}

module.exports = {
  CAMPOS_DA_PROMOCAO,
  ORIGEM,
  emMilissegundos,
  mudancaDaRemocao,
  promocaoVencidaForaDoErp,
  registroDaRemocao,
  removerPromocoesVencidasDaLoja,
};
