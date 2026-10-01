// Saude das rotinas da madrugada, por loja, em estabelecimentos/{loja}/Stats/rotinasNoturnas.
//
// Existe porque a origem dos produtos de cada rotina so vivia no log de execucao, que
// exige console do Google para ler. Aqui fica consultavel pelo mesmo proxy de dados que
// o painel ja usa.
//
// Arquivo puro: nao requer firebase-admin nem firebase-functions e recebe as referencias
// por parametro. Nao toca em documento de metrica nenhum: Stats/imageFileCheck,
// Stats/agenteConversas e Stats/buscasResumo continuam exatamente como estao.
const REGISTRO_VERSION = 1;
const REGISTRO_DOCUMENT = 'rotinasNoturnas';
// Trinta noites: um mes e o bastante para ver padrao e diagnosticar o dia em que o
// espelho parou, e cabe em 120 linhas com as quatro rotinas, uns 15 KB.
const NOITES_GUARDADAS = 30;
const TIME_ZONE = 'America/Sao_Paulo';

const formatador = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});

function noiteDe(data = new Date()) {
  const partes = {};
  formatador.formatToParts(data).forEach(({ type, value }) => { partes[type] = value; });
  return `${partes.year}-${partes.month}-${partes.day}`;
}

// 'espelho' ou 'recuo:<motivo>' viram dois campos, para a tela nao ter que quebrar texto.
function origemEmPartes(origem) {
  const texto = String(origem || '');
  if (!texto.startsWith('recuo')) return { origem: texto || 'desconhecida' };
  const motivo = texto.split(':')[1] || 'sem-motivo';
  return { origem: 'recuo', motivo };
}

function registroReference(storeRef) {
  return storeRef.collection('Stats').doc(REGISTRO_DOCUMENT);
}

// Uma linha por rotina por noite. Rodar a mesma rotina duas vezes na mesma noite
// substitui a linha, nao duplica.
async function registrarRotina({
  storeRef,
  rotina,
  noite = noiteDe(),
  origem = null,
  dados = {},
  atualizadoEm,
  noitesGuardadas = NOITES_GUARDADAS,
}) {
  const referencia = registroReference(storeRef);
  const atual = await referencia.get();
  const anteriores = (atual.exists ? atual.get('noites') : null) || [];

  const linha = {
    noite,
    rotina,
    ...(origem ? origemEmPartes(origem) : {}),
    ...dados,
  };

  const semEsta = anteriores.filter((entrada) => !(entrada?.noite === noite && entrada?.rotina === rotina));
  const noites = [...new Set([...semEsta.map((entrada) => entrada?.noite), noite].filter(Boolean))]
    .sort()
    .slice(-noitesGuardadas);
  const mantidas = new Set(noites);

  const linhas = [...semEsta, linha]
    .filter((entrada) => mantidas.has(entrada?.noite))
    .sort((a, b) => String(a.noite).localeCompare(String(b.noite))
      || String(a.rotina).localeCompare(String(b.rotina)));

  await referencia.set({
    version: REGISTRO_VERSION,
    atualizadoEm,
    primeiraNoite: noites[0] || noite,
    ultimaNoite: noites.at(-1) || noite,
    noites: linhas,
  });

  return { linhas: linhas.length, noites: noites.length };
}

module.exports = {
  NOITES_GUARDADAS,
  REGISTRO_DOCUMENT,
  REGISTRO_VERSION,
  noiteDe,
  origemEmPartes,
  registrarRotina,
  registroReference,
};
