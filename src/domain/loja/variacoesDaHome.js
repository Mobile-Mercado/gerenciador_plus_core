// Variacoes da Inicio (cola B56-08, B1 e B2): a tabela unica dos ajustes que cada variacao do
// app traz, e as faixas aceitas. A web le daqui (GET /api/admin/aparencia-home/variacoes) e,
// depois, o app. Medidas numa tela de 390 de largura.

export const BLOCOS = Object.freeze(['topo', 'meio', 'fim']);
export const NUMEROS = Object.freeze({ topo: 6, meio: 3, fim: 4 });
export const ALINHAMENTOS_DA_LOGO = Object.freeze(['base', 'centro', 'topo']);
export const ENDERECOS = Object.freeze(['card', 'linha', 'sem']);

const congelar = (objeto) => Object.freeze({ ...objeto });

// Topo 1 a 3: a Matriz. Topo 4 a 6: o desenho guardado em TopoPreviaAntiga (1, 2 e 3 dele),
// sem endereco. Topos 1 e 4 nao tem largura da busca (a busca ocupa a linha) nem alinhamento
// da logo (o icone fica dentro da busca).
const TOPO = (larguraBusca, endereco, { alinhamento = 'base' } = {}) => congelar({
  alturaBusca: 38,
  larguraBusca,
  distanciaTopo: 62,
  tamanhoLogo: 100,
  alinhamentoLogo: larguraBusca === null ? null : alinhamento,
  endereco,
});

const MEIO = congelar({
  alturaBanner: 150,
  cantosBanner: 12,
  margemBanner: 16,
  tamanhoIcones: 63,
  espacoIcones: 22.5,
  espacoFileiras: 12,
  margemEsquerda: 35.5,
  espacoAcima: 26,
  espacoAbaixo: 27.2,
  nomeLigado: true,
  tamanhoNome: 11,
  fileiras: 2,
});

const FIM = congelar({ larguraCards: 132, espacoCards: 8, tamanhoTitulo: 21 });
// Cola B56-09: o Fim 4 tem cards de 136, como o app; os Fins 1 a 3 ficam com 132.
const FIM4 = congelar({ ...FIM, larguraCards: 136 });

export const VARIACOES = Object.freeze({
  topo: Object.freeze({
    1: TOPO(null, 'linha'),
    2: TOPO(191, 'card'),
    3: TOPO(248.3, 'card'),
    4: TOPO(null, 'sem'),
    5: TOPO(199.6, 'sem'),
    6: TOPO(248.3, 'sem'),
  }),
  meio: Object.freeze({ 1: MEIO, 2: MEIO, 3: MEIO }),
  fim: Object.freeze({ 1: FIM, 2: FIM, 3: FIM, 4: FIM4 }),
});

// Faixas aceitas (B2). numero: [min, max]; lista: valores aceitos.
export const FAIXAS = Object.freeze({
  topo: Object.freeze({
    alturaBusca: Object.freeze([32, 48]),
    larguraBusca: Object.freeze([150, 280]),
    distanciaTopo: Object.freeze([48, 80]),
    tamanhoLogo: Object.freeze([60, 160]),
    alinhamentoLogo: ALINHAMENTOS_DA_LOGO,
    endereco: ENDERECOS,
  }),
  meio: Object.freeze({
    alturaBanner: Object.freeze([110, 200]),
    cantosBanner: Object.freeze([0, 24]),
    margemBanner: Object.freeze([0, 32]),
    tamanhoIcones: Object.freeze([48, 80]),
    espacoIcones: Object.freeze([8, 32]),
    espacoFileiras: Object.freeze([4, 32]),
    margemEsquerda: Object.freeze([8, 48]),
    espacoAcima: Object.freeze([8, 48]),
    espacoAbaixo: Object.freeze([8, 48]),
    nomeLigado: Object.freeze([true, false]),
    tamanhoNome: Object.freeze([9, 14]),
    fileiras: Object.freeze([1, 2]),
  }),
  fim: Object.freeze({
    larguraCards: Object.freeze([108, 160]),
    espacoCards: Object.freeze([4, 20]),
    tamanhoTitulo: Object.freeze([14, 26]),
  }),
});

const LISTAS = new Set(['alinhamentoLogo', 'endereco', 'nomeLigado', 'fileiras']);

export function numeroValido(bloco, numero) {
  return BLOCOS.includes(bloco) && Number.isInteger(numero) && numero >= 1 && numero <= NUMEROS[bloco];
}

// Confere um conjunto de ajustes de um bloco e devolve so as chaves conhecidas. Fora da faixa:
// a lista dos problemas, para a recusa. As chaves que a variacao nao tem (null na tabela, como a
// largura da busca nos Topos 1 e 4) so aceitam null.
export function conferirAjustes(bloco, ajustes = {}, { numero = null } = {}) {
  const faixas = FAIXAS[bloco];
  const tabela = numero ? VARIACOES[bloco][numero] : null;
  const problemas = [];
  const limpo = {};
  Object.entries(ajustes || {}).forEach(([chave, valor]) => {
    const faixa = faixas[chave];
    if (!faixa) {
      problemas.push(`${chave}: ajuste desconhecido`);
      return;
    }
    if (tabela && tabela[chave] === null) {
      if (valor !== null) problemas.push(`${chave}: não vale para esta variação`);
      else limpo[chave] = null;
      return;
    }
    if (LISTAS.has(chave)) {
      if (!faixa.includes(valor)) problemas.push(`${chave}: use ${faixa.join(', ')}`);
      else limpo[chave] = valor;
      return;
    }
    if (typeof valor !== 'number' || !Number.isFinite(valor) || valor < faixa[0] || valor > faixa[1]) {
      problemas.push(`${chave}: de ${faixa[0]} a ${faixa[1]}`);
      return;
    }
    limpo[chave] = Math.round(valor * 10) / 10;
  });
  return { ajustes: limpo, problemas };
}

// Ajustes de uma variacao sem modelo: a tabela, com o padrao mudado por cima (aparenciaPadrao).
export function ajustesDaVariacao(bloco, numero, padroes = {}) {
  return { ...VARIACOES[bloco][numero], ...(padroes?.[bloco]?.[String(numero)] || {}) };
}

// Ajustes finais de um bloco da loja: o modelo (sobre a variacao base) ou a variacao.
export function ajustesFinais(bloco, { numero, modelo = null, padroes = {} }) {
  if (modelo) return { ...ajustesDaVariacao(bloco, modelo.base, padroes), ...(modelo.ajustes || {}) };
  return ajustesDaVariacao(bloco, numero, padroes);
}

// Variacao padrao da loja sem escolha gravada (HomeLayout.standard do app): 2 em todos.
export const VARIACAO_PADRAO = Object.freeze({ topo: 2, meio: 2, fim: 2 });
