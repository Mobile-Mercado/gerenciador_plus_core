// Cola 100, item 6: "Alterados hoje" da faixa da aba Integrador (Logs do Gerenciador Web).
// Cada produto conta uma vez por dia: produtos distintos (codigo de barras) com preco, estoque ou
// situacao mudados hoje, pelos itens que o integrador manda em cada carga
// (estabelecimentos/{loja}/IntegrationLogItems: action, priceFrom/To, stockFrom/To, activeFrom/To,
// trashedFrom/To, promotionAction). Antes a faixa somava "atualizados + novos" de cada carga: o
// mesmo produto contava em cada arquivo, e "atualizado" incluia o produto que so trocou o motivo de
// estar fora do app ou o pesavel reenviado (integrador integration_controller.dart:121-139).
//
// Conta como mudado:
// - produto novo (action created);
// - preco: priceFrom preenchido e diferente de priceTo, ou promocao aplicada ou removida
//   (promotionAction applied/removed; a mantida nao conta);
// - estoque: stockFrom preenchido e diferente de stockTo;
// - situacao: activeFrom/activeTo ou trashedFrom/trashedTo diferentes (saiu ou voltou ao app, foi ou
//   saiu da lixeira).

// Dia de Sao Paulo (UTC-3, sem horario de verao desde 2019), como os outros contadores do Core.
const FUSO_MS = 3 * 60 * 60 * 1000;

export function diaEmSaoPaulo(agora) {
  return new Date(agora.getTime() - FUSO_MS).toISOString().slice(0, 10);
}

export function inicioDoDiaEmSaoPaulo(agora) {
  return new Date(Date.parse(`${diaEmSaoPaulo(agora)}T00:00:00Z`) + FUSO_MS);
}

function preenchido(valor) {
  return valor !== null && valor !== undefined;
}

function trocou(de, para) {
  return preenchido(de) && de !== para;
}

export function itemMudouOProduto(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.action === 'created') return true;
  if (item.action !== 'updated') return false;
  return trocou(item.priceFrom, item.priceTo)
    || item.promotionAction === 'applied'
    || item.promotionAction === 'removed'
    || trocou(item.stockFrom, item.stockTo)
    || trocou(item.activeFrom, item.activeTo)
    || trocou(item.trashedFrom, item.trashedTo);
}

function codigoDoItem(item) {
  const codigo = item.barCode ?? item.externalId;
  return codigo === null || codigo === undefined || codigo === '' ? null : String(codigo);
}

export function contarAlterados(itens) {
  const produtos = new Set();
  for (const item of itens) {
    if (!itemMudouOProduto(item)) continue;
    const codigo = codigoDoItem(item);
    if (codigo) produtos.add(codigo);
  }
  return produtos.size;
}
