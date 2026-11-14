// Contrato da versao 55 do app do cliente (Documentos/rodada-paralela/contrato-versao-55.md,
// aprovado em 21/10/2026). Limites num lugar so: as rotas validam com eles e os casos de uso
// usam os padroes.

// Item 5: interruptores por loja das funcoes do app, sempre booleanos, dentro de featureFlags (o
// mapa que o app Gerenciador ja le com promotions, banners e allBannersTypes). Padrao: so o
// Resumo do mes ligado (decisao do Thay). O debito saiu daqui: nao pede mais liberacao do Admin
// (regra de pagamento 1; cola RP-62, item B.6).
export const FUNCOES_DO_APP = Object.freeze({
  retirada: false,
  substituicao: false,
  resumoDoMes: true,
  cuponsFiscais: false,
});

// Item 6: blocos da Home por loja. Valor ausente ou fora da faixa vale o padrao. Topo 4 a 6
// (cola B56-08): o desenho guardado em TopoPreviaAntiga.
export const BLOCOS_DA_HOME = Object.freeze({
  topo: Object.freeze({ maximo: 6, padrao: 2 }),
  meio: Object.freeze({ maximo: 3, padrao: 2 }),
  fim: Object.freeze({ maximo: 4, padrao: 2 }),
  rodape: Object.freeze({ maximo: 2, padrao: 2 }),
});
export const PREPOSICOES_DA_BUSCA = Object.freeze(['no', 'na', 'nos', 'nas', 'em']);
export const PREPOSICAO_PADRAO = 'no';

// Item 2: formas de pagamento. cobradoEm: 'entrega' e presencial (na entrega ou na retirada).
export const FORMAS_DE_PAGAMENTO = Object.freeze({
  pix: Object.freeze({ nome: 'Pix' }),
  credito: Object.freeze({ nome: 'Cartão de crédito' }),
  debito: Object.freeze({ nome: 'Cartão de débito' }),
  dinheiro: Object.freeze({ nome: 'Dinheiro' }),
});
export const COBRADO_EM = Object.freeze(['app', 'entrega', 'ambos']);
export const COBRADO_EM_PADRAO = 'entrega';

// Item 1: retirada na loja.
export const TEMPO_DE_PREPARO_PADRAO_MIN = 30;
export const TEMPO_DE_PREPARO_MAXIMO_MIN = 1440;
export const INSTRUCOES_MAXIMO = 300;

export function funcoesDoApp(featureFlags) {
  const gravado = featureFlags && typeof featureFlags === 'object' ? featureFlags : {};
  return Object.fromEntries(Object.entries(FUNCOES_DO_APP)
    .map(([chave, padrao]) => [chave, typeof gravado[chave] === 'boolean' ? gravado[chave] : padrao]));
}

export function aparenciaDaHome(gravada) {
  const valor = gravada && typeof gravada === 'object' ? gravada : {};
  const blocos = Object.fromEntries(Object.entries(BLOCOS_DA_HOME).map(([bloco, { maximo, padrao }]) => {
    const numero = valor[bloco];
    return [bloco, Number.isInteger(numero) && numero >= 1 && numero <= maximo ? numero : padrao];
  }));
  return {
    ...blocos,
    preposicaoBusca: PREPOSICOES_DA_BUSCA.includes(valor.preposicaoBusca) ? valor.preposicaoBusca : PREPOSICAO_PADRAO,
  };
}

// Cola B56-08 (B3.c): o modelo de cada bloco (id em modelosAparencia, ou null) e os ajustes finais ja
// resolvidos (topoAjustes, meioAjustes, fimAjustes), como estao gravados; sem gravacao, null.
export const BLOCOS_COM_AJUSTES = Object.freeze(['topo', 'meio', 'fim']);

export function ajustesDaHome(gravada) {
  const valor = gravada && typeof gravada === 'object' ? gravada : {};
  return Object.fromEntries(BLOCOS_COM_AJUSTES.flatMap((bloco) => {
    const modelo = valor[`${bloco}Modelo`];
    const ajustes = valor[`${bloco}Ajustes`];
    return [
      [`${bloco}Modelo`, typeof modelo === 'string' && modelo ? modelo : null],
      [`${bloco}Ajustes`, ajustes && typeof ajustes === 'object' && !Array.isArray(ajustes) ? ajustes : null],
    ];
  }));
}
