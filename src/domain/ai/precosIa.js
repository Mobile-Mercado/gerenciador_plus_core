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

// Modelos de imagem (Thay, 27/11): dolar por milhao de tokens de texto e de imagem na entrada e de
// imagem na saida. Tabela da pagina do modelo em 27/11/2026, so para estimar; a cobranca real e a
// do painel do provedor.
const PRECOS_DE_IMAGEM_USD_POR_MILHAO = Object.freeze({
  'gpt-image-2.5-flare': { texto: 5, imagemEntrada: 8, imagemSaida: 30 },
});

export function custoDeImagemUsd(modelo, uso) {
  const preco = PRECOS_DE_IMAGEM_USD_POR_MILHAO[String(modelo || '').toLowerCase()];
  if (!preco || !uso) return null;
  const entrada = uso.input_tokens_details || {};
  const texto = Number(entrada.text_tokens ?? uso.input_tokens) || 0;
  const imagemEntrada = Number(entrada.image_tokens) || 0;
  const saida = Number(uso.output_tokens) || 0;
  const custo = (texto * preco.texto + imagemEntrada * preco.imagemEntrada + saida * preco.imagemSaida) / 1e6;
  return Math.round(custo * 1e6) / 1e6;
}
