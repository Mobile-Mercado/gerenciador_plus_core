// Dinheiro dos resumos arredondado a centavos ao gravar (cola RP-52, item 3.2).
//
// Mesma conta do emCentavos do mobile_firebase_api (functions/src/utils/dinheiro.ts): soma de
// reais em ponto flutuante deixa sobra de casas (ex.: 138.04800000000003); o toFixed(6) tira o
// ruido antes do arredondamento, para 1.005 virar 1.01 e nao 1.00.
//
// Regra de soma combinada: valor do item = arredondarCentavos(preco x quantidade); soma dos
// itens ja arredondados; o total arredondado de novo (a soma de valores em centavos ainda deixa
// ruido, ex.: 0.1 + 0.2).
function emCentavos(valor) {
  if (!Number.isFinite(valor)) return 0;
  const centavos = Math.round(Math.abs(Number((valor * 100).toFixed(6))));
  return valor < 0 && centavos !== 0 ? -centavos : centavos;
}

function arredondarCentavos(valor) {
  return emCentavos(valor) / 100;
}

// Delta de um FieldValue.increment: tira o valor antigo exatamente como foi somado e poe o novo,
// ja em centavos. Nao arredonda a centavos (a contribuicao antiga, de antes desta regra, pode ter
// fracao de centavo que precisa sair inteira); so tira o ruido de ponto flutuante da subtracao.
function semRuido(valor) {
  if (!Number.isFinite(valor)) return 0;
  return Number(valor.toFixed(6));
}

module.exports = { arredondarCentavos, emCentavos, semRuido };
