// Formatador do nome de categoria e subcategoria, aplicado pelo Core ao salvar (lista
// padrao no Admin e nome de exibicao da loja). Regra aprovada pelo Thay em 12/10/2026:
// - tira espacos nas pontas e espacos duplos;
// - abre P/ em "para", C/ em "com" e S/ em "sem";
// - siglas da lista em maiusculas;
// - conectivos em minusculo, menos na primeira palavra;
// - unidade de medida em minusculo (500 ml, 1l, un);
// - primeira letra de cada palavra em maiuscula e o resto em minusculo;
// - palavra nova depois de "/" e de "-";
// - nao poe nem tira acento.
// "Mercearia" e "Todos" ficam como vieram: o painel e o app acham essas duas pelo nome.

const SIGLAS = new Set(['FLV', 'PET', 'UHT']);
const CONECTIVOS = new Set([
  'a', 'o', 'as', 'os', 'e', 'ou', 'de', 'da', 'do', 'das', 'dos', 'em', 'na', 'no', 'nas', 'nos',
  'com', 'sem', 'para', 'por', 'ao', 'aos', 'à', 'às',
]);
const UNIDADES = new Set(['ml', 'l', 'g', 'kg', 'mg', 'un', 'cm', 'mm', 'm']);
const NOMES_INTOCADOS = new Set(['mercearia', 'todos']);
const NUMERO_COM_UNIDADE = /^(\d+(?:[.,]\d+)?)(ml|l|g|kg|mg|un|cm|mm|m)$/i;

function semAcento(texto) {
  return String(texto ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function capitalizar(parte) {
  const minusculo = parte.toLocaleLowerCase('pt-BR');
  return minusculo.charAt(0).toLocaleUpperCase('pt-BR') + minusculo.slice(1);
}

function formatarParte(parte, { primeira, anteriorNumero }) {
  if (!parte) return parte;
  const maiusculo = parte.toLocaleUpperCase('pt-BR');
  if (SIGLAS.has(maiusculo)) return maiusculo;
  const comUnidade = parte.match(NUMERO_COM_UNIDADE);
  if (comUnidade) return `${comUnidade[1]}${comUnidade[2].toLowerCase()}`;
  const minusculo = parte.toLocaleLowerCase('pt-BR');
  if (UNIDADES.has(minusculo) && (anteriorNumero || minusculo === 'un')) return minusculo;
  if (!primeira && CONECTIVOS.has(minusculo)) return minusculo;
  return capitalizar(parte);
}

export function formatarNome(nome) {
  const limpo = String(nome ?? '').trim().replace(/\s+/g, ' ');
  if (!limpo) return '';
  if (NOMES_INTOCADOS.has(semAcento(limpo))) return limpo;

  const aberto = limpo
    .replace(/(^|[\s(])P\/\s*/gi, '$1para ')
    .replace(/(^|[\s(])C\/\s*/gi, '$1com ')
    .replace(/(^|[\s(])S\/\s*/gi, '$1sem ')
    .trim()
    .replace(/\s+/g, ' ');

  let primeira = true;
  let anteriorNumero = false;
  return aberto.split(' ').map((palavra) => {
    // "/" e "-" comecam palavra nova: cada pedaco e formatado como palavra.
    const pedacos = palavra.split(/([/-])/);
    const formatada = pedacos.map((pedaco) => {
      if (pedaco === '/' || pedaco === '-' || !pedaco) return pedaco;
      const saida = formatarParte(pedaco, { primeira, anteriorNumero });
      primeira = false;
      anteriorNumero = /^\d+(?:[.,]\d+)?$/.test(pedaco);
      return saida;
    }).join('');
    return formatada;
  }).join(' ');
}

// Chave de comparacao para "nome repetido": sem acento, minusculo, espacos simples.
export function chaveDoNome(nome) {
  return semAcento(nome).replace(/\s+/g, ' ');
}
