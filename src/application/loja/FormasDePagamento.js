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

// Regra de pagamento 10 (contrato K2, cola RP-62, item B.5): a forma esta disponivel ao cliente
// quando esta ativa e e presencial ("entrega" ou "ambos"), ou quando e pelo app ("app" ou "ambos")
// com a Safra ligada.
export function formaDisponivel(loja, forma = {}) {
  if (forma?.ativa !== true) return false;
  if (forma.cobradoEm === 'entrega' || forma.cobradoEm === 'ambos') return true;
  return (forma.cobradoEm === 'app' || forma.cobradoEm === 'ambos') && safraLigada(loja);
}

export function temFormaDisponivel(loja, formas = {}) {
  return Object.values(formas).some((forma) => formaDisponivel(loja, forma));
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

// Contrato K4 (cola RP-62, item A.2): campos de safrapayMerchants/{loja} que o Admin grava. A API
// le (companyPaymentConfig.js, findMerchantConfig e merchantConfigFromData): enabled, env (ou
// environment), merchantId (ou safrapayMerchantId), merchantToken (ou safrapayMerchantToken ou
// token), gatewayUrl e portalUrl (ou safrapay*), cardSource, pixSource, requestTimeoutMs e
// antifraudEnabled. O Admin grava enabled, env, merchantId e merchantToken. Os apelidos e as URLs
// saem: a API tira as URLs do env, e URL de outro ambiente seria recusada. cardSource, pixSource,
// requestTimeoutMs e antifraudEnabled ficam como estao; ausentes, valem os padroes da API.
export const AMBIENTES_DA_SAFRA = Object.freeze(['prod', 'hml']);
const CAMPOS_QUE_SAEM_DA_CREDENCIAL = Object.freeze([
  'environment', 'safrapayMerchantId', 'safrapayMerchantToken', 'token',
  'gatewayUrl', 'safrapayGatewayUrl', 'portalUrl', 'safrapayPortalUrl',
]);

function emIso(valor) {
  if (!valor) return null;
  if (typeof valor.toDate === 'function') return valor.toDate().toISOString();
  if (valor instanceof Date) return valor.toISOString();
  return null;
}

// Corpo do GET do Admin (K4): nunca traz merchantId nem merchantToken.
export function credencialParaOAdmin(loja = {}, credencial = null) {
  const ambiente = credencial ? (credencial.env || credencial.environment) : null;
  return {
    gateway: 'safrapay',
    temCredencial: credencialPronta(credencial),
    ambiente: AMBIENTES_DA_SAFRA.includes(ambiente) ? ambiente : null,
    salvoEm: emIso(credencial?.salvoEm),
    salvoPor: typeof credencial?.salvoPorNome === 'string' && credencial.salvoPorNome ? credencial.salvoPorNome : null,
    ligadaNaLoja: safraLigada(loja),
  };
}

export class FormasDePagamento {
  constructor({ firestore, serverTimestamp = () => FieldValue.serverTimestamp(), apagarCampo = () => FieldValue.delete() }) {
    this.firestore = firestore;
    this.serverTimestamp = serverTimestamp;
    this.apagarCampo = apagarCampo;
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
  // `entrega` (contrato K2, cola RP-62, item B.4): booleano de "Entrega em casa", gravado so em
  // featureFlags.entrega, pelo caminho pontuado. Desligar a entrega sem a retirada ligada: 409.
  async salvar(lojaId, formas = {}, { entrega } = {}) {
    const mudancas = Object.fromEntries(Object.entries(formas || {}).filter(([forma, valor]) => FORMAS.includes(forma) && valor));
    const mudaEntrega = typeof entrega === 'boolean';
    if (!Object.keys(mudancas).length && !mudaEntrega) throw recusa('Nada para gravar.', 'formas_sem_mudancas');
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
      if (entrega === false && dados.featureFlags?.retirada !== true) {
        throw recusa('Deixe pelo menos uma forma de seus clientes receberem as compras ligada.', 'sem_forma_de_receber', 409);
      }
      const daEntrega = mudaEntrega ? { 'featureFlags.entrega': entrega } : {};
      if (!Object.keys(mudancas).length) {
        transacao.update(ref, { ...daEntrega, updatedAt: this.serverTimestamp() });
        return;
      }
      // "No app" e "Nos dois" so com o gateway ligado e nas formas que ele cobra.
      const semGateway = Object.entries(mudancas)
        .find(([forma, valor]) => valor.cobradoEm && valor.cobradoEm !== 'entrega' && !cobraNoApp(dados, forma));
      if (semGateway) {
        throw recusa('Esta loja ainda não recebe pagamento pelo app: escolha na entrega ou na retirada.', 'forma_sem_gateway');
      }
      const documentos = await this.lerDocumentos(ref, transacao);
      const gravacao = gravacaoDasFormas(dados, documentos, mudancas);
      if (!temFormaDisponivel(dados, gravacao.formas)) {
        throw recusa('Deixe pelo menos uma forma de pagamento ligada.', 'sem_forma_de_pagamento', 409);
      }
      transacao.update(ref, { paymentMethods: gravacao.paymentMethods, ...gravacao.gateway, ...daEntrega, updatedAt: this.serverTimestamp() });
      Object.entries(gravacao.documentos).forEach(([forma, documento]) => {
        transacao.set(ref.collection(SUBCOLECAO_FORMAS).doc(forma), documento, { merge: true });
      });
    });
    return this.ler(lojaId);
  }

  // Contrato K3 (cola RP-62, item A.3): o lojista liga e desliga a Safra, so com a credencial da
  // Mobile pronta em safrapayMerchants/{loja}. safrapay.enabled e paymentGateway.safrapay.enabled
  // vao sempre com o mesmo valor, na mesma escrita. Ao ligar, safrapay.methods sai das formas como
  // estao (a mesma conta de salvar com a Safra ligada). Desligar nao passa pela regra 10.
  async ligarSafra(lojaId, ligada) {
    const ref = this.lojaRef(lojaId);
    await this.firestore.runTransaction(async (transacao) => {
      const loja = await transacao.get(ref);
      if (!loja.exists) throw recusa('Loja não encontrada.', 'loja_nao_encontrada', 404);
      const credencial = await this.lerCredencial(loja.id, transacao);
      if (!credencialPronta(credencial)) {
        throw recusa('Fale com a Móbile para ligar um gateway.', 'safra_sem_credencial', 409);
      }
      const documentos = await this.lerDocumentos(ref, transacao);
      transacao.update(ref, { ...gravacaoDaSafra(loja.data() || {}, documentos, ligada), updatedAt: this.serverTimestamp() });
    });
    return this.ler(lojaId);
  }

  // ----- Admin da plataforma (contrato K4) -----
  async credencialNoAdmin(lojaId) {
    const loja = await this.lojaRef(lojaId).get();
    if (!loja.exists) throw recusa('Loja não encontrada.', 'loja_nao_encontrada', 404);
    return credencialParaOAdmin(loja.data() || {}, await this.lerCredencial(loja.id));
  }

  // `entrada`: { ambiente, merchantId, merchantToken }, ja conferida pela rota. `ator`: { uid, nome }.
  // Grava a credencial e liga a Safra na loja, na mesma transacao.
  async salvarCredencial(lojaId, { ambiente, merchantId, merchantToken }, ator = {}) {
    const ref = this.lojaRef(lojaId);
    await this.firestore.runTransaction(async (transacao) => {
      const loja = await transacao.get(ref);
      if (!loja.exists) throw recusa('Loja não encontrada.', 'loja_nao_encontrada', 404);
      const documentos = await this.lerDocumentos(ref, transacao);
      const credencial = {
        enabled: true,
        env: ambiente,
        merchantId,
        merchantToken,
        salvoEm: this.serverTimestamp(),
        salvoPorUid: ator.uid || null,
        salvoPorNome: ator.nome || null,
        ...Object.fromEntries(CAMPOS_QUE_SAEM_DA_CREDENCIAL.map((campo) => [campo, this.apagarCampo()])),
      };
      transacao.set(this.credencialRef(loja.id), credencial, { merge: true });
      transacao.update(ref, { ...gravacaoDaSafra(loja.data() || {}, documentos, true), updatedAt: this.serverTimestamp() });
    });
    return this.credencialNoAdmin(lojaId);
  }

  // Apaga a credencial e desliga a Safra na loja, na mesma transacao.
  async apagarCredencial(lojaId) {
    const ref = this.lojaRef(lojaId);
    await this.firestore.runTransaction(async (transacao) => {
      const loja = await transacao.get(ref);
      if (!loja.exists) throw recusa('Loja não encontrada.', 'loja_nao_encontrada', 404);
      transacao.delete(this.credencialRef(loja.id));
      transacao.update(ref, { ...gravacaoDaSafra(loja.data() || {}, new Map(), false), updatedAt: this.serverTimestamp() });
    });
    return this.credencialNoAdmin(lojaId);
  }
}

// Os dois enabled com o mesmo valor (K3 e K4). Ligando, safrapay.methods a partir das formas como
// ficam com a Safra ligada.
export function gravacaoDaSafra(loja, documentos, ligada) {
  const valor = ligada === true;
  const gravacao = { 'safrapay.enabled': valor, 'paymentGateway.safrapay.enabled': valor };
  if (!valor) return gravacao;
  const comSafra = {
    ...loja,
    safrapay: { ...(loja.safrapay || {}), enabled: true },
    paymentGateway: { ...(loja.paymentGateway || {}), safrapay: { ...(loja.paymentGateway?.safrapay || {}), enabled: true } },
  };
  return { ...gravacao, ...gatewayDasFormas(comSafra, formasDaLoja(comSafra, documentos).formas) };
}
