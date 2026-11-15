import { blocoDaLoja } from './primeiroAcesso.js';

// Aparencias da loja (cola B56-04): conjuntos de icones, Ofertas e Abertura. Limites num lugar
// so: as rotas validam com eles e os casos de uso usam os padroes.

// Conjunto "Lineares": nao tem documento, e a propria lista padrao (categoriasProdutos).
export const CONJUNTO_LINEARES = Object.freeze({ id: 'lineares', nome: 'Lineares' });

// Icone de um conjunto: SVG, PNG ou WEBP, quadrado, ate 20 KB. PNG acima disso pode virar WEBP.
export const ICONE_DO_CONJUNTO_TIPOS = Object.freeze({
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/webp': 'webp',
});
export const ICONE_DO_CONJUNTO_MAX_BYTES = 20 * 1024;

// Arquivos de Ofertas, Abertura e Primeira tela: imagem ate 40 KB; animacao .json ate 120 KB.
export const IMAGEM_DA_APARENCIA_TIPOS = Object.freeze({
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
});
export const IMAGEM_DA_APARENCIA_MAX_BYTES = 40 * 1024;
export const ANIMACAO_TIPOS = Object.freeze({ 'application/json': 'json' });
export const ANIMACAO_MAX_BYTES = 120 * 1024;

export const TIPOS_DE_FUNDO = Object.freeze(['cor', 'imagem', 'animacao']);
export const TIPOS_DE_ABERTURA = Object.freeze(['imagem', 'animacao']);
export const TITULO_MAX = 60;
export const TEXTO_MAX = 200;
export const COR = /^#[0-9A-Fa-f]{6}$/;

// Imagens da jornada Primeiro acesso (cola B56-24, A2): PNG, WEBP ou SVG, com o limite de cada
// quadro do mockup (aparencias-login.html).
export const IMAGEM_DA_JORNADA_TIPOS = Object.freeze({
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/webp': 'webp',
});
const daJornada = (campo, maxKb) => Object.freeze({ campo, tipo: 'imagem', tipos: IMAGEM_DA_JORNADA_TIPOS, maxBytes: maxKb * 1024 });

// Onde cada arquivo enviado e gravado. abertura.imagem reaproveita o splashImageUrl de hoje.
// Sem tipos/maxBytes: imagem ate 40 KB (IMAGEM_DA_APARENCIA_*) ou animacao ate 120 KB.
export const ARQUIVOS_DA_APARENCIA = Object.freeze({
  'ofertas-fundo-imagem': Object.freeze({ campo: 'ofertas.fundo.imagemUrl', tipo: 'imagem' }),
  'ofertas-fundo-animacao': Object.freeze({ campo: 'ofertas.fundo.animacaoUrl', tipo: 'animacao' }),
  'ofertas-cabecalho-imagem': Object.freeze({ campo: 'ofertas.cabecalho.imagemUrl', tipo: 'imagem' }),
  'abertura-imagem': Object.freeze({ campo: 'splashImageUrl', tipo: 'imagem' }),
  'abertura-animacao': Object.freeze({ campo: 'abertura.animacaoUrl', tipo: 'animacao' }),
  'primeira-tela-logo': Object.freeze({ campo: 'primeiraTela.logoUrl', tipo: 'imagem' }),
  'primeira-tela-imagem': daJornada('primeiraTela.imagemUrl', 300),
  'boas-vindas-fundo': daJornada('boasVindas.imagemFundoUrl', 120),
  'boas-vindas-imagem': daJornada('boasVindas.imagemUrl', 150),
  'login-logo': daJornada('login.logoUrl', 80),
  'login-fundo': daJornada('login.imagemFundoUrl', 80),
  'folha-nome-ilustracao': daJornada('folhaNome.ilustracaoUrl', 80),
});
// Os do fundo de Ofertas, que o lojista tambem envia quando o Admin libera.
export const ARQUIVOS_DO_FUNDO = Object.freeze({ imagem: 'ofertas-fundo-imagem', animacao: 'ofertas-fundo-animacao' });

const mapa = (valor) => (valor && typeof valor === 'object' && !Array.isArray(valor) ? valor : {});
const textoOuNulo = (valor) => (typeof valor === 'string' && valor.trim() ? valor : null);
const corOuNula = (valor) => (typeof valor === 'string' && COR.test(valor) ? valor.toUpperCase() : null);

// Ofertas como o app e o painel leem. A cor do fundo e o offerColor de hoje enquanto
// ofertas.fundo.cor nao existir. Fundo sem tipo gravado e "cor".
export function ofertasDaLoja(data = {}) {
  const ofertas = mapa(data.ofertas);
  const fundo = mapa(ofertas.fundo);
  const cabecalho = mapa(ofertas.cabecalho);
  return {
    fundo: {
      tipo: TIPOS_DE_FUNDO.includes(fundo.tipo) ? fundo.tipo : 'cor',
      cor: corOuNula(fundo.cor) || corOuNula(data.offerColor),
      corVemDoOfferColor: !corOuNula(fundo.cor),
      imagemUrl: textoOuNulo(fundo.imagemUrl),
      animacaoUrl: textoOuNulo(fundo.animacaoUrl),
    },
    cabecalho: {
      ligado: cabecalho.ligado === true,
      titulo: textoOuNulo(cabecalho.titulo),
      texto: textoOuNulo(cabecalho.texto),
      imagemUrl: textoOuNulo(cabecalho.imagemUrl),
    },
    lojistaPodeTrocarFundo: ofertas.lojistaPodeTrocarFundo === true,
  };
}

// Abertura: a imagem e o splashImageUrl de hoje. Sem tipo gravado, "imagem". Cola B56-24 (A2):
// rodape, tempo minimo e os padroes de primeiroAcesso.js; animacaoPropria diz se a loja tem a sua
// (sem ela, o app usa a animacao padrao de aparenciaPadrao/abertura).
export function aberturaDaLoja(data = {}) {
  const abertura = blocoDaLoja('abertura', data);
  return {
    ...abertura,
    imagemUrl: textoOuNulo(data.splashImageUrl),
    animacaoPropria: Boolean(abertura.animacaoUrl),
  };
}

// Primeira tela: so guardada; entra no build da marca (cola B56-24, C2.1).
export function primeiraTelaDaLoja(data = {}) {
  return blocoDaLoja('primeiraTela', data);
}

// Conjunto de icones da loja: sem campo, a lista padrao (Lineares).
export function conjuntoDaLoja(data = {}) {
  const id = mapa(data.aparencia).conjuntoIcones;
  return typeof id === 'string' && id.trim() ? id : CONJUNTO_LINEARES.id;
}

// Id de documento seguro para entrar num caminho com ponto (icones.{categoriaId}).
export const ID_SEGURO = /^[A-Za-z0-9_-]{1,120}$/;
