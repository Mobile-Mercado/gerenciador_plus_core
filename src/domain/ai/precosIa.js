// Preco estimado por modelo, em dolar por milhao de tokens (entrada e saida). Tabela de
// referencia de 12/10/2026, so para estimar o custo gravado em UsoIa: a cobranca real e a
// do painel do provedor. Modelo fora da tabela fica sem custo estimado (null).
const PRECOS_USD_POR_MILHAO = Object.freeze({
  'gpt-4o': { entrada: 2.5, saida: 10 },
  'gpt-4o-mini': { entrada: 0.15, saida: 0.6 },
  'gpt-4.1': { entrada: 2, saida: 8 },
  'gpt-4.1-mini': { entrada: 0.4, saida: 1.6 },
  'gpt-4.1-nano': { entrada: 0.1, saida: 0.4 },
});

export function custoEstimadoUsd(modelo, { inputTokens = 0, outputTokens = 0 } = {}) {
  const preco = PRECOS_USD_POR_MILHAO[String(modelo || '').toLowerCase()];
  if (!preco) return null;
  const custo = (Number(inputTokens) || 0) * preco.entrada / 1e6 + (Number(outputTokens) || 0) * preco.saida / 1e6;
  return Math.round(custo * 1e6) / 1e6;
}
