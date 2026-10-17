// Municipio nas contagens e tabelas do funil do cadastro (17/10/2026). A cidade do acesso chega da
// funcao cidadeDoAcesso em minusculas e as vezes sem acento ("vila velha"); a da Receita, em
// maiusculas ("VILA VELHA"). As duas se juntam pela chave sem acento e sem maiuscula.
export const NAO_IDENTIFICADA = 'Não identificada';

const CONECTIVOS = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);

function semAcento(texto) {
  return String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Nome limpo, sem os caracteres que o Firestore nao aceita em nome de campo.
function limpo(texto) {
  return String(texto || '').replace(/[./[\]*~`]/g, ' ').replace(/\s+/g, ' ').trim();
}

// "vila velha - es". Sem cidade: "Não identificada".
export function chaveDoMunicipio(cidade, uf) {
  const nome = semAcento(limpo(cidade)).toLowerCase();
  if (!nome) return NAO_IDENTIFICADA;
  const estado = String(uf || '').trim().toLowerCase();
  return estado ? `${nome} - ${estado}` : nome;
}

// Iniciais maiusculas, conectivos em minusculo: "vila velha" -> "Vila Velha",
// "cachoeiro de itapemirim" -> "Cachoeiro de Itapemirim".
export function iniciaisMaiusculas(cidade) {
  return limpo(cidade).toLowerCase().split(' ')
    .map((palavra, indice) => (indice > 0 && CONECTIVOS.has(palavra) ? palavra : palavra.charAt(0).toUpperCase() + palavra.slice(1)))
    .join(' ');
}
