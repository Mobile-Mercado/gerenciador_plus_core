import { FieldValue } from 'firebase-admin/firestore';
import { AppError } from '../../domain/errors/AppError.js';
import {
  COBRADO_EM, COBRADO_EM_PADRAO, FORMAS_DE_PAGAMENTO,
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
// Debito: a loja liga e desliga, sem liberacao do Admin (regra de pagamento 1; cola RP-62, B.6).
// Regra do Thay de 22/10 (cola RP-33): o lojista decide onde cada forma e cobrada e o app obedece.
// "app" e "ambos" so com o gateway da loja ligado e para as formas que ele cobra; debito nunca e
// cobrado pelo app. Com o gateway ligado, safrapay.methods (o que liga a cobranca no app) e gravado
// aqui, na mesma transacao, a partir do que ficou.
export const SUBCOLECAO_FORMAS = 'paymentMethods';
export const ESPELHO_DO_CREDITO = 'cartao';
const FORMAS = Object.keys(FORMAS_DE_PAGAMENTO);

// O que cada gateway cobra no app, com o campo de safrapay.methods (o mesmo que a web usava).
// Safrapay: Pix e credito; o debito nao entra e o campo debitcard vai sempre false.
export const COBRADO_PELO_GATEWAY = Object.freeze({ pix: 'pix', credito: 'creditcard' });
const CAMPO_DO_DEBITO_NO_GATEWAY = 'debitcard';

// Credencial da Safrapay que a API usa (safrapay_mobile_mercado__api, companyPaymentConfig.js,
// findMerchantConfig e merchantConfigFromData): safrapayMerchants/{loja}, com enabled e com
// merchantId e merchantToken (e os apelidos que a API le). Daqui nunca sai valor de credencial.
export const COLECAO_DE_CREDENCIAIS = 'safrapayMerchants';

// Mesmo teste de "ligado" da API (companyPaymentConfig.js, isEnabled).
function habilitado(valor) {
  return valor === true || valor === 'true' || valor === 1;
}

// Contrato K1 (cola RP-62): a mesma conta da API, sem devolver nenhum valor.
export function credencialPronta(credencial) {
  if (!credencial || typeof credencial !== 'object' || !habilitado(credencial.enabled)) return false;
  const merchantId = credencial.merchantId || credencial.safrapayMerchantId;
  const merchantToken = credencial.merchantToken || credencial.safrapayMerchantToken || credencial.token;
  return Boolean(merchantId) && Boolean(merchantToken);
}

// Contrato K1: a Safra esta ligada com safrapay.enabled === true e paymentGateway.safrapay.enabled
// diferente de false (a API le os dois; o Core grava os dois juntos, K3 e K4).
export function safraLigada(loja = {}) {
  return loja?.safrapay?.enabled === true && loja?.paymentGateway?.safrapay?.enabled !== false;
}

export function gatewayLigado(loja = {}) {
  return safraLigada(loja);
}

export function cobraNoApp(loja, forma) {
  return gatewayLigado(loja) && Object.hasOwn(COBRADO_PELO_GATEWAY, forma);
}

function recusa(mensagem, code, statusCode = 400) {
  return new AppError(mensagem, { statusCode, code });
}

function itemDoArray(lista, forma) {
  return lista.find((item) => item && item.id === forma) || null;
}

// Como esta gravado, para a tela: ativa pelo array (a fonte do app); sem item, pela subcolecao.
// cobradoEm pela subcolecao; credito e debito sem documento proprio caem no cartao de antes. Sem
// cobradoEm gravado, o que o app faz hoje (contrato da versao 55, item 2): "app" na forma que o
// gateway ligado cobra, "entrega" nas outras. Debito e dinheiro sao sempre "entrega".
export function formasDaLoja(loja = {}, documentos = new Map()) {
  const lista = Array.isArray(loja.paymentMethods) ? loja.paymentMethods : [];
  const formas = Object.fromEntries(FORMAS.map((forma) => {
    const item = itemDoArray(lista, forma);
    const documento = documentos.get(forma) || ((forma === 'credito' || forma === 'debito') ? documentos.get(ESPELHO_DO_CREDITO) : null);
    const ativa = item ? item.isActive === true : (documentos.has(forma) ? documentos.get(forma).isActive === true : false);
    const padrao = cobraNoApp(loja, forma) ? 'app' : COBRADO_EM_PADRAO;
    const cobradoEm = COBRADO_EM.includes(documento?.cobradoEm) ? documento.cobradoEm : padrao;
    return [forma, { ativa, cobradoEm: forma === 'dinheiro' || forma === 'debito' ? 'entrega' : cobradoEm }];
  }));
  return { formas };
}

// Corpo do GET (contrato K1 da cola RP-62). entrega: featureFlags.entrega ausente vale ligada;
// retirada: so com featureFlags.retirada === true. Mercado Pago ainda nao existe.
export function formasParaATela(lojaId, loja = {}, documentos = new Map(), credencial = null) {
  const flags = loja.featureFlags && typeof loja.featureFlags === 'object' ? loja.featureFlags : {};
  return {
    lojaId,
    formas: formasDaLoja(loja, documentos).formas,
    safra: { credencialPronta: credencialPronta(credencial), ligada: safraLigada(loja) },
    mercadoPago: { credencialPronta: false, ligada: false },
    entrega: flags.entrega !== false,
    retirada: flags.retirada === true,
  };
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
  return { paymentMethods: lista, documentos: docs, formas: final, gateway: gatewayDasFormas(loja, final) };
}

// safrapay.methods a partir das formas como ficaram: ligada e cobrada no app (ou nos dois). So com o
// gateway ligado; sem ele, nada e gravado.
export function gatewayDasFormas(loja, formas) {
  if (!gatewayLigado(loja)) return {};
  const metodos = Object.fromEntries(Object.entries(COBRADO_PELO_GATEWAY).map(([forma, campo]) => [
    `safrapay.methods.${campo}`,
    formas[forma]?.ativa === true && formas[forma]?.cobradoEm !== 'entrega',
  ]));
  return { ...metodos, [`safrapay.methods.${CAMPO_DO_DEBITO_NO_GATEWAY}`]: false };
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

  credencialRef(lojaId) {
    return this.firestore.collection(COLECAO_DE_CREDENCIAIS).doc(String(lojaId || ''));
  }

  async lerCredencial(lojaId, transacao = null) {
    const ref = this.credencialRef(lojaId);
    const snapshot = transacao ? await transacao.get(ref) : await ref.get();
    return snapshot.exists ? (snapshot.data() || {}) : null;
  }

  async ler(lojaId) {
    const ref = this.lojaRef(lojaId);
    const loja = await ref.get();
    if (!loja.exists) throw recusa('Loja não encontrada.', 'loja_nao_encontrada', 404);
    const [documentos, credencial] = await Promise.all([this.lerDocumentos(ref), this.lerCredencial(loja.id)]);
    return formasParaATela(loja.id, loja.data() || {}, documentos, credencial);
  }

  // `formas`: { pix?, credito?, debito?, dinheiro? }, cada uma { ativa?, cobradoEm? }.
  async salvar(lojaId, formas = {}) {
    const mudancas = Object.fromEntries(Object.entries(formas).filter(([forma, valor]) => FORMAS.includes(forma) && valor));
    if (!Object.keys(mudancas).length) throw recusa('Nada para gravar.', 'formas_sem_mudancas');
    if (mudancas.dinheiro?.cobradoEm && mudancas.dinheiro.cobradoEm !== 'entrega') {
      throw recusa('Dinheiro só é pago na entrega ou na retirada.', 'forma_cobranca_invalida');
    }
    if (mudancas.debito?.cobradoEm && mudancas.debito.cobradoEm !== 'entrega') {
      throw recusa('O cartão de débito não é cobrado pelo app: só na entrega ou na retirada.', 'debito_so_presencial');
    }
    const ref = this.lojaRef(lojaId);
    await this.firestore.runTransaction(async (transacao) => {
      const loja = await transacao.get(ref);
      if (!loja.exists) throw recusa('Loja não encontrada.', 'loja_nao_encontrada', 404);
      const dados = loja.data() || {};
      // "No app" e "Nos dois" so com o gateway ligado e nas formas que ele cobra.
      const semGateway = Object.entries(mudancas)
        .find(([forma, valor]) => valor.cobradoEm && valor.cobradoEm !== 'entrega' && !cobraNoApp(dados, forma));
      if (semGateway) {
        throw recusa('Esta loja ainda não recebe pagamento pelo app: escolha na entrega ou na retirada.', 'forma_sem_gateway');
      }
      const documentos = await this.lerDocumentos(ref, transacao);
      const gravacao = gravacaoDasFormas(dados, documentos, mudancas);
      transacao.update(ref, { paymentMethods: gravacao.paymentMethods, ...gravacao.gateway, updatedAt: this.serverTimestamp() });
      Object.entries(gravacao.documentos).forEach(([forma, documento]) => {
        transacao.set(ref.collection(SUBCOLECAO_FORMAS).doc(forma), documento, { merge: true });
      });
    });
    return this.ler(lojaId);
  }
}
