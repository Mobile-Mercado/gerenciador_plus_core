import { AppError } from '../../domain/errors/AppError.js';
import resumoVendasModulo from '../../../functions/resumoVendas.js';

const { contribuicaoDoPedido } = resumoVendasModulo;

// Mais vendidos da loja nos ultimos 30 dias, para a prateleira "MAIS VENDIDOS NA LOJA" de "Minhas
// compras" vazia no app usuario (cola do Thay B57-03, C1, e B57-03c, item 5: "rota nova no Core que
// soma os pedidos dos ultimos 30 dias, so da loja").
//
// Soma os pedidos da loja (PurchaseRequests com companyReference da loja) criados nos ultimos 30
// dias, com a mesma regra de venda do resumo de vendas (functions/resumoVendas.js): so status
// confirmado, sem pedido de teste, quantidade de cada item. Usa o indice que ja existe
// (companyReference + createdAt). Devolve so o id do produto e a quantidade, do mais vendido para o
// menos; o app le os produtos como ja le os outros e, sem dados, mostra os Destaques do dia.
// So le: nada e gravado.
export const DIAS_DOS_MAIS_VENDIDOS = 30;
export const LIMITE_DOS_MAIS_VENDIDOS = 20;

const LOJA_VALIDA = /^[A-Za-z0-9_-]{1,128}$/;
const DIA_EM_MS = 24 * 60 * 60 * 1000;

export class MaisVendidosDaLoja {
  constructor({ firestore, clock = () => Date.now() }) {
    this.firestore = firestore;
    this.clock = clock;
  }

  async listar(lojaId) {
    const id = String(lojaId || '').trim();
    if (!LOJA_VALIDA.test(id)) {
      throw new AppError('Loja nao encontrada.', { statusCode: 404, code: 'loja_nao_encontrada' });
    }
    const loja = this.firestore.collection('estabelecimentos').doc(id);
    const desde = new Date(this.clock() - DIAS_DOS_MAIS_VENDIDOS * DIA_EM_MS);
    const pedidos = await this.firestore
      .collection('PurchaseRequests')
      .where('companyReference', '==', loja)
      .where('createdAt', '>=', desde)
      .get();

    const quantidades = new Map();
    pedidos.docs.forEach((pedido) => {
      const contribuicao = contribuicaoDoPedido(pedido.id, pedido.data());
      if (!contribuicao) return;
      Object.entries(contribuicao.produtos).forEach(([chave, produto]) => {
        // Item sem id de produto (so o nome) nao vira card no app.
        if (chave.startsWith('name:') || !(produto.qtd > 0)) return;
        quantidades.set(chave, (quantidades.get(chave) || 0) + produto.qtd);
      });
    });

    const produtos = [...quantidades.entries()]
      .sort(([idA, a], [idB, b]) => b - a || idA.localeCompare(idB))
      .slice(0, LIMITE_DOS_MAIS_VENDIDOS)
      .map(([produtoId, quantidade]) => ({ produtoId, quantidade }));
    return { desde: desde.toISOString(), produtos };
  }
}
