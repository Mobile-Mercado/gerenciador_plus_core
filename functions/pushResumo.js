// Resultado de cada envio de notificacao, por loja e por dia (cola RP-172, item 5).
//
// Um documento por dia (fuso de Sao Paulo) em PushResumo/{aaaa-mm-dd}, so com contagens:
//   total.{resultado}
//   lojas.{loja}.{origem}.{audiencia}.{plataforma}.{resultado}
//   codigos.{codigo do FCM}            (so os que nao foram aceitos)
// Resultado: aceito, token_inexistente, sem_apns, outro; e sem_token quando a conta nao
// tinha aparelho para mandar. Nunca entra token, id de cliente nem texto da mensagem.
//
// O mobile_old_web_platform grava no mesmo documento, com o mesmo formato
// (functions/src/services/push-results.ts). Mudou aqui, muda la.
//
// Arquivo puro: o banco e o FieldValue chegam por parametro.

const { diaDe } = require('./buscasResumo');

const COLECAO = 'PushResumo';
const RESULTADOS = Object.freeze(['aceito', 'token_inexistente', 'sem_apns', 'outro', 'sem_token']);
const SEM_LOJA = 'sem-loja';

const TOKEN_INEXISTENTE = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);
// O FCM nao conseguiu falar com a APNs: iPhone de app sem chave APNs (RP-168, item 1).
const SEM_APNS = new Set(['messaging/third-party-auth-error']);

function resultadoDoErro(codigo) {
  if (TOKEN_INEXISTENTE.has(codigo)) return 'token_inexistente';
  if (SEM_APNS.has(codigo)) return 'sem_apns';
  return 'outro';
}

// Chave de mapa do Firestore: so letras minusculas, digitos e "_".
function chave(valor, padrao) {
  const texto = String(valor ?? '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return texto ? texto.slice(0, 80) : padrao;
}

// Id da loja como esta no banco (letras, digitos, "_" e "-"); outro formato vira sem-loja.
function chaveDaLoja(loja) {
  const texto = String(loja ?? '');
  return /^[A-Za-z0-9_-]{1,128}$/.test(texto) ? texto : SEM_LOJA;
}

// responses: o `responses` do sendEachForMulticast; plataformas: a plataforma de cada
// token, na mesma ordem (ausente vira "desconhecida").
function contarEnvios(responses = [], plataformas = []) {
  const contagens = new Map();
  const codigos = {};
  responses.forEach((resposta, indice) => {
    const plataforma = chave(plataformas[indice], 'desconhecida');
    let resultado = 'aceito';
    if (!resposta?.success) {
      const codigo = resposta?.error?.code || 'desconhecido';
      resultado = resultadoDoErro(codigo);
      const chaveDoCodigo = chave(codigo, 'desconhecido');
      codigos[chaveDoCodigo] = (codigos[chaveDoCodigo] || 0) + 1;
    }
    const id = `${plataforma}|${resultado}`;
    if (!contagens.has(id)) contagens.set(id, { plataforma, resultado, vezes: 0 });
    contagens.get(id).vezes += 1;
  });
  return { contagens: [...contagens.values()], codigos };
}

// O envio inteiro falhou (excecao no sendEachForMulticast): cada token conta com o codigo
// da excecao.
function contarFalhaGeral(codigo, plataformas = []) {
  return contarEnvios(plataformas.map(() => ({ success: false, error: { code: codigo } })), plataformas);
}

function semToken() {
  return { contagens: [{ plataforma: 'nenhuma', resultado: 'sem_token', vezes: 1 }], codigos: {} };
}

// Objeto para set(..., { merge: true }) com os incrementos.
function incrementosDoDia({
  dia, loja, origem, audiencia, contagens = [], codigos = {}, increment,
}) {
  // Somas antes do increment: o mesmo resultado em duas plataformas soma no total.
  const somaTotal = {};
  const somaPorPlataforma = {};
  contagens.forEach(({ plataforma, resultado, vezes }) => {
    if (!vezes) return;
    somaTotal[resultado] = (somaTotal[resultado] || 0) + vezes;
    somaPorPlataforma[plataforma] = somaPorPlataforma[plataforma] || {};
    somaPorPlataforma[plataforma][resultado] = (somaPorPlataforma[plataforma][resultado] || 0) + vezes;
  });
  const total = Object.fromEntries(Object.entries(somaTotal).map(([resultado, n]) => [resultado, increment(n)]));
  const porPlataforma = Object.fromEntries(Object.entries(somaPorPlataforma).map(([plataforma, resultados]) => [
    plataforma,
    Object.fromEntries(Object.entries(resultados).map(([resultado, n]) => [resultado, increment(n)])),
  ]));
  const codigosIncrementados = {};
  Object.entries(codigos).forEach(([codigo, vezes]) => {
    if (vezes) codigosIncrementados[codigo] = increment(vezes);
  });
  return {
    dia,
    total,
    lojas: {
      [chaveDaLoja(loja)]: {
        [chave(origem, 'desconhecida')]: {
          [chave(audiencia, 'desconhecida')]: porPlataforma,
        },
      },
    },
    ...(Object.keys(codigosIncrementados).length ? { codigos: codigosIncrementados } : {}),
  };
}

// Nunca lanca: a contagem nao pode atrapalhar o envio.
async function gravarResultadoDosEnvios({
  db, FieldValue, agora = new Date(), loja = null, origem, audiencia, contagens = [], codigos = {},
}) {
  try {
    if (!contagens.some((item) => item.vezes)) return false;
    const dia = diaDe(agora);
    await db.collection(COLECAO).doc(dia).set({
      ...incrementosDoDia({
        dia, loja, origem, audiencia, contagens, codigos, increment: (n) => FieldValue.increment(n),
      }),
      atualizadoEm: FieldValue.serverTimestamp(),
    }, { merge: true });
    return true;
  } catch (error) {
    console.error('[pushResumo] Contagem do envio nao gravada', { origem, error: error?.message || String(error) });
    return false;
  }
}

module.exports = {
  COLECAO,
  RESULTADOS,
  SEM_LOJA,
  chaveDaLoja,
  contarEnvios,
  contarFalhaGeral,
  gravarResultadoDosEnvios,
  incrementosDoDia,
  resultadoDoErro,
  semToken,
};
