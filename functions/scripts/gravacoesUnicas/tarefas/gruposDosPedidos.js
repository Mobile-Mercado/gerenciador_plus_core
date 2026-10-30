// Gravacao 3 (cola RP-76; contrato da versao 55, item 7; carga autorizada pelo Thay em 21/10):
// grupos do Resumo do mes nos pedidos antigos. Grava gruposDosItens, resumoPorGrupo e gruposVersao
// com a mesma conta do gatilho agruparItensDoPedido (classificarPedido e carregarMeta de
// functions/resumoDoMes.js). Pedido ja na versao da tabela fica de fora.
//
// Le do pedido so productsCart, a loja, o status, o desconto e os tres campos; nada do cliente.
// Na tela e no relatorio, so contagens; os ids dos pedidos ficam so na copia (para desfazer).
const { GRUPOS, GRUPOS_VERSAO, carregarMeta, classificarPedido } = require('../../../resumoDoMes');
const { AUSENTE, lerCampos, valorNoCaminho, valorRest } = require('../firestoreRest');

const CAMPOS_GRAVADOS = ['gruposDosItens', 'resumoPorGrupo', 'gruposVersao'];
const CAMPOS_LIDOS = [...CAMPOS_GRAVADOS, 'productsCart', 'companyReference', 'companyId', 'currentPurchaseStatus', 'discountValue'];

// Status em que o gatilho onPurchaseSeparated da versao 55 (mobile_firebase_api) refaz o total
// (STATUS_DA_SEPARACAO em onPurchaseSeparated.ts). Ele roda em qualquer update do pedido.
const STATUS_DA_SEPARACAO = new Set([
  'PurchaseStatus.separatingOrder', 'PurchaseStatus.readyForPickup', 'PurchaseStatus.waitingForDelivery',
  'PurchaseStatus.deliveryRoute', 'PurchaseStatus.completed', 'PurchaseStatus.deliveryConfirmed',
]);

// Pedido que esse gatilho pode regravar (price, total, descontoNaSeparacao e o acerto) quando a
// carga tocar nele: no status da separacao, com cupom ou com item removido ou pesado
// (correcaoDoTotal). E o teto: ele so grava o que diferir da conta.
function podeSerRecalculado(pedido) {
  if (!STATUS_DA_SEPARACAO.has(pedido.currentPurchaseStatus)) return false;
  const itens = Array.isArray(pedido.productsCart) ? pedido.productsCart : [];
  if (!itens.length) return false;
  const comCupom = typeof pedido.discountValue === 'number' && Math.round(pedido.discountValue * 100) > 0;
  const mexido = itens.some((item) => item?.separated?.hasRemoved === true
    || (Array.isArray(item?.separated?.measures) && item.separated.measures.length > 0));
  return comCupom || mexido;
}

function jaNaVersao(pedido) {
  return pedido.gruposVersao === GRUPOS_VERSAO && Boolean(pedido.resumoPorGrupo);
}

function mudancaDoPedido(documento, classificacao) {
  return {
    caminho: documento.caminho,
    rotulo: null,
    updateTime: documento.updateTime,
    antes: Object.fromEntries(CAMPOS_GRAVADOS.map((campo) => [campo, valorNoCaminho(documento.campos, campo) ?? AUSENTE])),
    depois: Object.fromEntries(CAMPOS_GRAVADOS.map((campo) => [campo, valorRest(classificacao[campo])])),
  };
}

async function executar({ firestore }) {
  const documentos = await firestore.listar('PurchaseRequests', CAMPOS_LIDOS);
  const db = firestore.comoAdmin();
  const totais = Object.fromEntries(GRUPOS.map((grupo) => [grupo, { itens: 0, valor: 0 }]));
  const mudancas = [];
  let naVersao = 0;
  let semItens = 0;
  let recalculaveis = 0;
  for (const documento of documentos) {
    const pedido = lerCampos(documento.campos);
    if (jaNaVersao(pedido)) { naVersao += 1; continue; }
    if (!Array.isArray(pedido.productsCart) || !pedido.productsCart.length) semItens += 1;
    if (podeSerRecalculado(pedido)) recalculaveis += 1;
    const classificacao = classificarPedido(pedido, await carregarMeta({ db, pedido }));
    Object.values(classificacao.gruposDosItens).forEach((grupo) => { totais[grupo].itens += 1; });
    Object.entries(classificacao.resumoPorGrupo).forEach(([grupo, valor]) => { totais[grupo].valor += valor; });
    mudancas.push(mudancaDoPedido(documento, classificacao));
  }
  const avisos = [
    `pedidos lidos ${documentos.length} | ja na versao ${GRUPOS_VERSAO}: ${naVersao} | a classificar: ${mudancas.length} | sem itens: ${semItens}`,
    ...GRUPOS.map((grupo) => `${grupo}: ${totais[grupo].itens} itens, R$ ${totais[grupo].valor.toFixed(2)}`),
    `${recalculaveis} dos pedidos a classificar podem ter o total refeito pelo onPurchaseSeparated da versao 55 se ele ja estiver no ar quando a carga rodar (status da separacao, com cupom ou item removido/pesado)`,
  ];
  return { lidos: documentos.length, mudancas, avisos };
}

module.exports = {
  descricao: 'Pedidos antigos ganham gruposDosItens, resumoPorGrupo e gruposVersao (Resumo do mes), pela conta do resumoDoMes.js.',
  detalheNaTela: false,
  executar,
  jaNaVersao,
  mudancaDoPedido,
  podeSerRecalculado,
};
