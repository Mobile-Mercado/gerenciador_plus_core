const COR_VALIDA = /^#[0-9A-Fa-f]{6}$/;

// Jornada "Primeiro acesso" da loja (cola B56-24, item A2). Uma tabela so com os campos de cada
// bloco, o padrao e a faixa, tirados do mockup aprovado (aparencias-login.html) e do contrato
// Documentos/rodada-paralela/B56-24/contrato-primeiro-acesso.md. A leitura (com os padroes), a
// validacao da rota e o app seguem esta tabela. Campo ausente vale o padrao; null na gravacao
// apaga a chave e volta ao padrao. As URLs de arquivo so entram pelo envio do arquivo.
//
// primeiraTela e abertura ja existiam (cola B56-04): primeiraTela.logoUrl e .cor, abertura.tipo,
// .cor e .animacaoUrl. A imagem da abertura continua sendo o splashImageUrl de hoje (o app
// publicado le esse campo), e nao entra aqui.

export const ALINHAMENTOS = Object.freeze(['esquerda', 'centro', 'direita']);
export const TEXTO_DA_JORNADA_MAX = 200;

const numero = (minimo, maximo, passo, padrao) => Object.freeze({ tipo: 'numero', minimo, maximo, passo, padrao });
const opcao = (opcoes, padrao) => Object.freeze({ tipo: 'opcao', opcoes: Object.freeze(opcoes), padrao });
const ligado = (padrao) => Object.freeze({ tipo: 'bool', padrao });
const texto = (padrao) => Object.freeze({ tipo: 'texto', padrao });
// cor null = a cor principal da loja (a da Inicio).
const cor = (padrao) => Object.freeze({ tipo: 'cor', padrao });
const arquivo = () => Object.freeze({ tipo: 'url', padrao: null });

export const BLOCOS_DA_JORNADA = Object.freeze({
  primeiraTela: Object.freeze({
    logoUrl: arquivo(),
    logoTamanho: numero(40, 180, 1, 100),
    logoY: numero(15, 85, 1, 50),
    logoAlinhamento: opcao(ALINHAMENTOS, 'centro'),
    cor: cor('#FFFFFF'),
    mesmaCorDaAbertura: ligado(false),
    imagemUrl: arquivo(),
    escurecer: numero(0, 70, 1, 0),
    rodapeLigado: ligado(false),
    rodape: texto(''),
    // Cola B56-25 (item 6): cor do texto do rodape.
    rodapeCor: cor('#7A8099'),
  }),
  abertura: Object.freeze({
    tipo: opcao(['imagem', 'animacao'], 'imagem'),
    animacaoUrl: arquivo(),
    cor: cor(null),
    rodapeLigado: ligado(true),
    rodape: texto('Powered by: Móbile'),
    rodapeCor: cor('#FFFFFF'),
    // Padrao 0 (cola B57-03h, item 1; antes, 1,5 s): sem espera, salvo a loja que escolheu.
    tempoMinimo: numero(0, 6, 0.5, 0),
  }),
  boasVindas: Object.freeze({
    cor: cor(null),
    imagemFundoUrl: arquivo(),
    escurecer: numero(0, 70, 1, 20),
    logoLigado: ligado(false),
    logoTamanho: numero(60, 160, 1, 100),
    imagemLigada: ligado(true),
    imagemUrl: arquivo(),
    imagemTamanho: numero(50, 130, 1, 100),
    titulo: texto('Suas compras com mais\nrapidez e facilidade'),
    texto: texto(''),
    corTexto: cor('#FFFFFF'),
    botaoPrincipal: texto('Criar meu acesso e entrar'),
    botaoSecundario: texto('Já tenho acesso'),
    semCadastroLigado: ligado(true),
    semCadastro: texto('Entrar sem fazer cadastro'),
    corBotao: cor('#FFFFFF'),
    corTextoBotao: cor('#2E4BD6'),
  }),
  login: Object.freeze({
    logoUrl: arquivo(),
    logoTamanho: numero(60, 160, 1, 60),
    logoY: numero(30, 140, 1, 77),
    logoAlinhamento: opcao(ALINHAMENTOS, 'centro'),
    logoFundo: opcao(['sem', 'card'], 'sem'),
    logoCor: opcao(['original', 'branca', 'cor'], 'original'),
    logoCorHex: cor('#FFFFFF'),
    alturaArea: numero(140, 420, 1, 196),
    cantoFolha: numero(0, 40, 1, 28),
    cor: cor(null),
    imagemFundoUrl: arquivo(),
    imagemAjuste: opcao(['preencher', 'encaixar'], 'preencher'),
    escurecer: numero(0, 70, 1, 20),
    titulo: texto('Digite seu número de celular'),
    botao: texto('Continuar'),
    frase: texto('ou entre com sua conta Google ou Apple'),
    googleLigado: ligado(true),
    appleLigado: ligado(true),
  }),
  codigoSms: Object.freeze({
    // Cola B56-25 (item 5): sem cor propria, a cor da loja (antes #2E4BD6 fixo).
    cor: cor(null),
    corFundo: cor('#FFFFFF'),
    titulo: texto('Informe o código que você\nrecebeu por SMS:'),
    tempo: numero(10, 120, 5, 10),
    fraseReenvio: texto('Não recebeu o código?'),
    botaoReenvio: texto('Reenviar código'),
    outraFormaLigada: ligado(true),
    fraseOutraForma: texto('Não consegue receber SMS?'),
    botaoOutraForma: texto('Acessar de outra forma'),
  }),
  folhaNome: Object.freeze({
    titulo: texto('Como podemos te chamar?'),
    campo: texto('Qual seu nome'),
    botao: texto('Salvar'),
    ilustracaoUrl: arquivo(),
  }),
  folhaEndereco: Object.freeze({
    titulo: texto('Onde entregar as suas compras?'),
    texto: texto(''),
    botao: texto('Adicionar endereço'),
    pularLigado: ligado(true),
    pular: texto('Agora não'),
  }),
});

// Cola B56-25 (item 7): cores com que as lojas novas nascem (primaryColor = loja, secondaryColor =
// sistema), em aparenciaPadrao/cores. Sem documento, estas.
export const CORES_PADRAO_DE_FABRICA = Object.freeze({ loja: '#2E4BD6', sistema: '#1F9D4E' });

export function coresPadraoDe(data = {}) {
  const valida = (valor, padrao) => (typeof valor === 'string' && COR_VALIDA.test(valor) ? valor.toUpperCase() : padrao);
  return { loja: valida(data.loja, CORES_PADRAO_DE_FABRICA.loja), sistema: valida(data.sistema, CORES_PADRAO_DE_FABRICA.sistema) };
}

export const NOMES_DOS_BLOCOS = Object.freeze(Object.keys(BLOCOS_DA_JORNADA));

const mapa = (valor) => (valor && typeof valor === 'object' && !Array.isArray(valor) ? valor : {});

// O valor gravado vale se passa na faixa do campo; senao, o padrao.
export function valorDoCampo(campo, valor) {
  switch (campo.tipo) {
    case 'numero':
      return numeroValido(campo, valor) ? valor : campo.padrao;
    case 'opcao':
      return campo.opcoes.includes(valor) ? valor : campo.padrao;
    case 'bool':
      return typeof valor === 'boolean' ? valor : campo.padrao;
    case 'texto':
      return typeof valor === 'string' && valor.length <= TEXTO_DA_JORNADA_MAX ? valor : campo.padrao;
    case 'cor':
      return typeof valor === 'string' && COR_VALIDA.test(valor) ? valor.toUpperCase() : campo.padrao;
    case 'url':
      return typeof valor === 'string' && valor.trim() ? valor : null;
    default:
      return campo.padrao;
  }
}

export function numeroValido(campo, valor) {
  if (typeof valor !== 'number' || !Number.isFinite(valor)) return false;
  if (valor < campo.minimo || valor > campo.maximo) return false;
  const passos = (valor - campo.minimo) / campo.passo;
  return Math.abs(passos - Math.round(passos)) < 1e-9;
}

// Um bloco como o app e o painel leem: todos os campos, com o padrao onde nao ha valor gravado.
export function blocoDaLoja(nome, data = {}) {
  const gravado = mapa(data[nome]);
  return Object.fromEntries(Object.entries(BLOCOS_DA_JORNADA[nome]).map(([chave, campo]) => [chave, valorDoCampo(campo, gravado[chave])]));
}

// Os padroes de um bloco (loja sem nada gravado).
export function padroesDoBloco(nome) {
  return blocoDaLoja(nome, {});
}

// JSON de Lottie: objeto com v (texto), fr, ip, op, w e h numericos e layers lista.
export function eLottie(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return false;
  return typeof json.v === 'string'
    && ['fr', 'ip', 'op', 'w', 'h'].every((chave) => typeof json[chave] === 'number' && Number.isFinite(json[chave]))
    && Array.isArray(json.layers);
}
