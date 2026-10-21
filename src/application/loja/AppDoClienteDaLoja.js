import { FieldValue } from 'firebase-admin/firestore';
import { AppError } from '../../domain/errors/AppError.js';
import { aparenciaDaHome, funcoesDoApp } from '../../domain/loja/appDoCliente.js';
import { SUBCOLECAO_FORMAS, gravacaoDasFormas } from './FormasDePagamento.js';

// Funcoes do app e aparencia da Home de cada loja (contrato da versao 55, itens 5 e 6; cola
// RP-13). So o Admin grava: featureFlags.{retirada, substituicao, resumoDoMes, cuponsFiscais,
// debito} e aparenciaHome.{topo, meio, fim, rodape, preposicaoBusca}. Cada chave e gravada sozinha
// (featureFlags.x, aparenciaHome.x), para nao apagar promotions, banners e allBannersTypes, que o
// app Gerenciador le no mesmo mapa. Mudar featureFlags.debito liga ou desliga junto o item debito
// do array paymentMethods[] e o documento debito da subcolecao (item 2 do contrato).
function recusa(mensagem, code, statusCode = 400) {
  return new AppError(mensagem, { statusCode, code });
}

export class AppDoClienteDaLoja {
  constructor({ firestore, serverTimestamp = () => FieldValue.serverTimestamp() }) {
    this.firestore = firestore;
    this.serverTimestamp = serverTimestamp;
  }

  lojaRef(lojaId) {
    return this.firestore.collection('estabelecimentos').doc(String(lojaId || ''));
  }

  async ler(lojaId) {
    const loja = await this.lojaRef(lojaId).get();
    if (!loja.exists) throw recusa('Loja não encontrada.', 'loja_nao_encontrada', 404);
    return paraATela(loja.id, loja.data() || {});
  }

  // `entrada`: { featureFlags?, aparenciaHome? }, ja conferida pela rota.
  async salvar(lojaId, entrada = {}) {
    const ref = this.lojaRef(lojaId);
    const resultado = await this.firestore.runTransaction(async (transacao) => {
      const loja = await transacao.get(ref);
      if (!loja.exists) throw recusa('Loja não encontrada.', 'loja_nao_encontrada', 404);
      const atual = loja.data() || {};
      const funcoesAntes = funcoesDoApp(atual.featureFlags);
      const aparenciaAntes = aparenciaDaHome(atual.aparenciaHome);
      const mudancas = {};
      const antes = {};
      Object.entries(entrada.featureFlags || {}).forEach(([chave, valor]) => {
        mudancas[`featureFlags.${chave}`] = valor;
        antes[`featureFlags.${chave}`] = funcoesAntes[chave];
      });
      Object.entries(entrada.aparenciaHome || {}).forEach(([chave, valor]) => {
        mudancas[`aparenciaHome.${chave}`] = valor;
        antes[`aparenciaHome.${chave}`] = aparenciaAntes[chave];
      });
      if (!Object.keys(mudancas).length) throw recusa('Nada para gravar.', 'app_do_cliente_sem_mudancas');

      const debito = entrada.featureFlags?.debito;
      const documentosDasFormas = {};
      if (typeof debito === 'boolean' && debito !== funcoesAntes.debito) {
        const consulta = ref.collection(SUBCOLECAO_FORMAS);
        const documentos = new Map((await transacao.get(consulta)).docs.map((documento) => [documento.id, documento.data() || {}]));
        const gravacao = gravacaoDasFormas(atual, documentos, { debito: { ativa: debito } });
        mudancas.paymentMethods = gravacao.paymentMethods;
        Object.assign(documentosDasFormas, gravacao.documentos);
      }
      transacao.update(ref, { ...mudancas, updatedAt: this.serverTimestamp() });
      Object.entries(documentosDasFormas).forEach(([forma, documento]) => {
        transacao.set(ref.collection(SUBCOLECAO_FORMAS).doc(forma), documento, { merge: true });
      });
      return { antes, campos: Object.keys(mudancas) };
    });
    return { ...resultado, app: await this.ler(lojaId) };
  }
}

function paraATela(lojaId, data) {
  return { lojaId, featureFlags: funcoesDoApp(data.featureFlags), aparenciaHome: aparenciaDaHome(data.aparenciaHome) };
}
