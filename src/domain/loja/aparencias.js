// Aparencias da loja (cola B56-04), so a parte dos conjuntos de icones (branch icones-conjuntos,
// cola B56-16). Ofertas, Abertura e Primeira tela ficam na build-56.

// Conjunto "Lineares": nao tem documento, e a propria lista padrao (categoriasProdutos).
export const CONJUNTO_LINEARES = Object.freeze({ id: 'lineares', nome: 'Lineares' });

// Icone de um conjunto: SVG, PNG ou WEBP, quadrado, ate 20 KB. PNG acima disso pode virar WEBP.
export const ICONE_DO_CONJUNTO_TIPOS = Object.freeze({
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/webp': 'webp',
});
export const ICONE_DO_CONJUNTO_MAX_BYTES = 20 * 1024;

const mapa = (valor) => (valor && typeof valor === 'object' && !Array.isArray(valor) ? valor : {});

// Conjunto de icones da loja: sem campo, a lista padrao (Lineares).
export function conjuntoDaLoja(data = {}) {
  const id = mapa(data.aparencia).conjuntoIcones;
  return typeof id === 'string' && id.trim() ? id : CONJUNTO_LINEARES.id;
}

// Id de documento seguro para entrar num caminho com ponto (icones.{categoriaId}).
export const ID_SEGURO = /^[A-Za-z0-9_-]{1,120}$/;
