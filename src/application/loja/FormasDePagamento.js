import { FieldValue } from 'firebase-admin/firestore';
import { AppError } from '../../domain/errors/AppError.js';
import {
  COBRADO_EM, COBRADO_EM_PADRAO, FORMAS_DE_PAGAMENTO, funcoesDoApp,
} from '../../domain/loja/appDoCliente.js';

// Formas de pagamento da loja (contrato da versao 55, item 2; cola RP-13). Duas fontes que os apps
// ja leem, gravadas juntas:
// - o array paymentMethods[] do documento da loja ({ id, name, isActive, order, icon }): e por ele
//   que o app do cliente decide quais formas mostrar (o id contem credito, debito, pix ou dinheiro);
// - a subcolecao estabelecimentos/{loja}/paymentMethods/{forma} ({ name, isActive, cobradoEm }):
//   onde cada forma e cobrada ('app', 'entrega' = presencial, ou 'ambos').
// Credito e debito sao separados. O documento cartao continua como espelho do credito, porque o
// app do cliente da versao 54 so le pix e cartao. Item do array que nao e uma das quatro formas
// (ids antigos, como cartao) fica como esta.
// Debito so liga com featureFlags.debito, que so o Admin muda (AppDoClienteDaLoja).
export const SUBCOLECAO_FORMAS = 'paymentMethods';
export const ESPELHO_DO_CREDITO = 'cartao';
const FORMAS = Object.keys(FORMAS_DE_PAGAMENTO);

function recusa(mensagem, code, statusCode = 400) {
  return new AppError(mensagem, { statusCode, code });
}

function itemDoArray(lista, forma) {
  return lista.find((item) => item && item.id === forma) || null;
}

// Como esta gravado, para a tela: ativa pelo array (a fonte do app); sem item, pela subcolecao.
// cobradoEm pela subcolecao; credito e debito sem documento proprio caem no cartao de antes.
export function formasDaLoja(loja = {}, documentos = new Map()) {
  const lista = Array.isArray(loja.paymentMethods) ? loja.paymentMethods : [];
  const formas = Object.fromEntries(FORMAS.map((forma) => {
    const item = itemDoArray(lista, forma);
    const documento = documentos.get(forma) || ((forma === 'credito' || forma === 'debito') ? documentos.get(ESPELHO_DO_CREDITO) : null);
    const ativa = item ? item.isActive === true : (documentos.has(forma) ? documentos.get(forma).isActive === true : false);
    const cobradoEm = COBRADO_EM.includes(documento?.cobradoEm) ? documento.cobradoEm : COBRADO_EM_PADRAO;
    return [forma, { ativa, cobradoEm: forma === 'dinheiro' ? 'entrega' : cobradoEm }];
  }));
  return { formas, debitoLiberado: funcoesDoApp(loja.featureFlags).debito };
}

// Gravacao das formas, ja conferidas. Devolve o array novo e os documentos da subcolecao a gravar.
export function gravacaoDasFormas(loja, documentos, mudancas) {
  const atual = formasDaLoja(loja, documentos).formas;
  const final = Object.fromEntries(FORMAS.map((forma) => [forma, { ...atual[forma], ...(mudancas[forma] || {}) }]));
  const lista = Array.isArray(loja.paymentMethods) ? loja.paymentMethods.map((item) => (item && typeof item === 'object' ? { ...item } : item)) : [];
  let ordem = lista.reduce((maior, item) => Math.max(maior, Number(item?.order) || 0), 0);
  const tocadas = FORMAS.filter((forma) => mudancas[forma]);
  tocadas.forEach((forma) => {
    const item = itemDoArray(lista, forma);
    if (item) {
      item.isActive = final[forma].ativa;
      return;
    }
    ordem += 1;
    lista.push({ id: forma, name: FORMAS_DE_PAGAMENTO[forma].nome, isActive: final[forma].ativa, order: ordem, icon: null });
  });
  const docs = Object.fromEntries(tocadas.map((forma) => [forma, {
    name: FORMAS_DE_PAGAMENTO[forma].nome, isActive: final[forma].ativa, cobradoEm: final[forma].cobradoEm,
  }]));
  if (mudancas.credito) {
    docs[ESPELHO_DO_CREDITO] = { name: FORMAS_DE_PAGAMENTO.credito.nome, isActive: final.credito.ativa, cobradoEm: final.credito.cobradoEm };
  }
  return { paymentMethods: lista, documentos: docs, formas: final };
}

export class FormasDePagamento {
  constructor({ firestore, serverTimestamp = () => FieldValue.serverTimestamp() }) {
    this.firestore = firestore;
    this.serverTimestamp = serverTimestamp;
  }

  lojaRef(lojaId) {
    return this.firestore.collection('estabelecimentos').doc(String(lojaId || ''));
  }

  async lerDocumentos(lojaRef, transacao = null) {
    const consulta = lojaRef.collection(SUBCOLECAO_FORMAS);
    const snapshot = transacao ? await transacao.get(consulta) : await consulta.get();
    return new Map(snapshot.docs.map((documento) => [documento.id, documento.data() || {}]));
  }

  async ler(lojaId) {
    const ref = this.lojaRef(lojaId);
    const loja = await ref.get();
    if (!loja.exists) throw recusa('Loja não encontrada.', 'loja_nao_encontrada', 404);
    return { lojaId: loja.id, ...formasDaLoja(loja.data() || {}, await this.lerDocumentos(ref)) };
  }

  // `formas`: { pix?, credito?, debito?, dinheiro? }, cada uma { ativa?, cobradoEm? }.
  async salvar(lojaId, formas = {}) {
    const mudancas = Object.fromEntries(Object.entries(formas).filter(([forma, valor]) => FORMAS.includes(forma) && valor));
    if (!Object.keys(mudancas).length) throw recusa('Nada para gravar.', 'formas_sem_mudancas');
    if (mudancas.dinheiro?.cobradoEm && mudancas.dinheiro.cobradoEm !== 'entrega') {
      throw recusa('Dinheiro só é pago na entrega ou na retirada.', 'forma_cobranca_invalida');
    }
    const ref = this.lojaRef(lojaId);
    await this.firestore.runTransaction(async (transacao) => {
      const loja = await transacao.get(ref);
      if (!loja.exists) throw recusa('Loja não encontrada.', 'loja_nao_encontrada', 404);
      const dados = loja.data() || {};
      if (mudancas.debito?.ativa === true && !funcoesDoApp(dados.featureFlags).debito) {
        throw recusa('O cartão de débito ainda não foi liberado para esta loja.', 'debito_nao_liberado', 409);
      }
      const documentos = await this.lerDocumentos(ref, transacao);
      const gravacao = gravacaoDasFormas(dados, documentos, mudancas);
      transacao.update(ref, { paymentMethods: gravacao.paymentMethods, updatedAt: this.serverTimestamp() });
      Object.entries(gravacao.documentos).forEach(([forma, documento]) => {
        transacao.set(ref.collection(SUBCOLECAO_FORMAS).doc(forma), documento, { merge: true });
      });
    });
    return this.ler(lojaId);
  }
}
