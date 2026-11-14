import { FieldValue } from 'firebase-admin/firestore';
import { AppError } from '../../domain/errors/AppError.js';
import {
  BLOCOS_COM_AJUSTES, BLOCOS_DA_HOME, ajustesDaHome, aparenciaDaHome, funcoesDoApp,
} from '../../domain/loja/appDoCliente.js';
import { ajustesFinais, conferirAjustes } from '../../domain/loja/variacoesDaHome.js';

// Cola B56-08 (B3): modelos e padroes mudados das variacoes da Inicio.
export const COLECAO_DE_MODELOS = 'modelosAparencia';
export const DOCUMENTO_DE_PADROES = 'aparenciaPadrao/padroes';

// Funcoes do app e aparencia da Home de cada loja (contrato da versao 55, itens 5 e 6; cola
// RP-13). O Admin grava: featureFlags.{retirada, substituicao, resumoDoMes, cuponsFiscais}
// e aparenciaHome.{topo, meio, fim, rodape, preposicaoBusca}; a propria loja grava so
// featureFlags.cuponsFiscais (PATCH /api/loja/app-do-cliente, cola RP-58). Cada chave e gravada sozinha
// (featureFlags.x, aparenciaHome.x), para nao apagar promotions, banners e allBannersTypes, que o
// app Gerenciador le no mesmo mapa. O debito nao passa mais por aqui: a loja liga e desliga nas
// formas de pagamento, sem liberacao (cola RP-62, item B.6).
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
      const ajustesAntes = ajustesDaHome(atual.aparenciaHome);
      const home = entrada.aparenciaHome || {};
      // Rodape e preposicao como antes; topo, meio e fim com a variacao, o modelo e os ajustes finais.
      Object.entries(home).forEach(([chave, valor]) => {
        if (BLOCOS_COM_AJUSTES.some((bloco) => chave === bloco || chave === `${bloco}Modelo` || chave === `${bloco}Ajustes`)) return;
        mudancas[`aparenciaHome.${chave}`] = valor;
        antes[`aparenciaHome.${chave}`] = aparenciaAntes[chave];
      });
      const tocados = BLOCOS_COM_AJUSTES.filter((bloco) => [bloco, `${bloco}Modelo`, `${bloco}Ajustes`].some((chave) => chave in home));
      const padroes = tocados.length ? ((await transacao.get(this.firestore.doc(DOCUMENTO_DE_PADROES))).data() || {}) : {};
      for (const bloco of tocados) {
        const resolvido = await this.resolverBloco(transacao, bloco, home, aparenciaAntes, ajustesAntes, padroes);
        Object.entries(resolvido).forEach(([chave, valor]) => {
          mudancas[`aparenciaHome.${chave}`] = valor;
          antes[`aparenciaHome.${chave}`] = chave === bloco ? aparenciaAntes[bloco] : ajustesAntes[chave];
        });
      }
      if (!Object.keys(mudancas).length) throw recusa('Nada para gravar.', 'app_do_cliente_sem_mudancas');

      transacao.update(ref, { ...mudancas, updatedAt: this.serverTimestamp() });
      return { antes, campos: Object.keys(mudancas) };
    });
    return { ...resultado, app: await this.ler(lojaId) };
  }

  // Um bloco da Inicio (cola B56-08, B4.g): a variacao (topo 1-6, meio 1-3, fim 1-4), o modelo (que
  // fixa a variacao na base dele) e os ajustes finais. Ajustes enviados sao conferidos pelas faixas
  // (B2) e vao por cima dos da variacao ou do modelo; sem eles, os da variacao ou do modelo.
  // Trocar a variacao sem dizer o modelo tira o modelo.
  async resolverBloco(transacao, bloco, home, aparenciaAntes, ajustesAntes, padroes) {
    const chaveDoModelo = `${bloco}Modelo`;
    let numero = home[bloco] ?? aparenciaAntes[bloco];
    let modeloId = chaveDoModelo in home ? home[chaveDoModelo] : (bloco in home ? null : ajustesAntes[chaveDoModelo]);
    let modelo = null;
    if (modeloId) {
      const documento = await transacao.get(this.firestore.collection(COLECAO_DE_MODELOS).doc(modeloId));
      if (!documento.exists || documento.data()?.bloco !== bloco) {
        throw recusa(`Modelo de ${bloco} não encontrado.`, 'modelo_nao_encontrado', 404);
      }
      modelo = documento.data();
      numero = modelo.base;
    } else {
      modeloId = null;
    }
    if (!Number.isInteger(numero) || numero < 1 || numero > BLOCOS_DA_HOME[bloco].maximo) {
      throw recusa(`Variação de ${bloco} inválida.`, 'variacao_invalida');
    }
    let ajustes = ajustesFinais(bloco, { numero, modelo, padroes });
    const enviados = home[`${bloco}Ajustes`];
    if (enviados) {
      const { ajustes: conferidos, problemas } = conferirAjustes(bloco, enviados, { numero });
      if (problemas.length) {
        throw new AppError(`Ajuste fora da faixa: ${problemas.join('; ')}.`, { statusCode: 400, code: 'ajuste_fora_da_faixa', details: { problemas } });
      }
      ajustes = { ...ajustes, ...conferidos };
    }
    return { [bloco]: numero, [chaveDoModelo]: modeloId, [`${bloco}Ajustes`]: ajustes };
  }
}

function paraATela(lojaId, data) {
  return {
    lojaId,
    featureFlags: funcoesDoApp(data.featureFlags),
    aparenciaHome: aparenciaDaHome(data.aparenciaHome),
    ajustesDaHome: ajustesDaHome(data.aparenciaHome),
  };
}
