// Visitas por mes de cada loja, em estabelecimentos/{loja}/Stats/visitasPorMes (rodada Financas,
// 16/10/2026). Existe para os periodos Ano e Desde o inicio do grafico "Visitas e pedidos" da tela
// Financas lerem um documento so, em vez de todo o DailyStats.
//
// Documento: { meses: { "AAAA-MM": { app, agente } }, atualizadoAte: "AAAA-MM-DD" (ultimo dia
// somado), atualizadoEm }. app = appViewsCount e agente = agentAppViewsCount do DailyStats (o
// viewsCount antigo fica fora, como na tela).
//
// A rotina visitasPorMesNightly recalcula do zero so o mes atual e o anterior (no maximo 62
// documentos do DailyStats por loja, lidos pelo id "DD-MM-AAAA") e grava por cima desses dois meses:
// rodar de novo nao soma duas vezes. A carga inicial (scripts/gerarVisitasPorMes.js) le todo o
// DailyStats da loja uma vez.
//
// Arquivo puro: nao requer firebase-admin nem firebase-functions. Recebe db e FieldValue.
const VISITAS_POR_MES_DOCUMENT = 'visitasPorMes';
const TIME_ZONE = 'America/Sao_Paulo';

const numero = (valor) => {
  const convertido = Number(valor);
  return Number.isFinite(convertido) ? convertido : 0;
};
const dois = (valor) => String(valor).padStart(2, '0');

// "DD-MM-AAAA" -> "AAAA-MM-DD"; id fora do formato -> null.
function diaDoId(id) {
  const partes = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(id || ''));
  if (!partes) return null;
  const [, dia, mes, ano] = partes;
  if (Number(mes) < 1 || Number(mes) > 12 || Number(dia) < 1 || Number(dia) > 31) return null;
  return `${ano}-${mes}-${dia}`;
}

// Soma documentos do DailyStats ({ id, dados }) por mes. Devolve os meses, o ultimo dia somado, os
// documentos lidos, os que ficaram fora (id fora do formato "DD-MM-AAAA") e quantos nao tem createdAt.
function somarVisitasPorMes(documentos) {
  const meses = {};
  let ultimoDia = null;
  let lidos = 0;
  let foraDoFormato = 0;
  let semCreatedAt = 0;
  (documentos || []).forEach(({ id, dados }) => {
    lidos += 1;
    if (!dados?.createdAt) semCreatedAt += 1;
    const dia = diaDoId(id);
    if (!dia) {
      foraDoFormato += 1;
      return;
    }
    const mes = dia.slice(0, 7);
    const atual = meses[mes] || { app: 0, agente: 0 };
    atual.app += numero(dados?.appViewsCount);
    atual.agente += numero(dados?.agentAppViewsCount);
    meses[mes] = atual;
    if (!ultimoDia || dia > ultimoDia) ultimoDia = dia;
  });
  return { meses, ultimoDia, lidos, foraDoFormato, semCreatedAt };
}

// Mes atual e anterior ("AAAA-MM") no fuso de Sao Paulo.
function mesesDaNoite(agora = new Date()) {
  const partes = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit' })
    .formatToParts(agora)
    .forEach(({ type, value }) => { partes[type] = value; });
  const ano = Number(partes.year);
  const mes = Number(partes.month);
  const anterior = mes === 1 ? `${ano - 1}-12` : `${ano}-${dois(mes - 1)}`;
  return [anterior, `${ano}-${dois(mes)}`];
}

// Ids "DD-MM-AAAA" de todos os dias dos meses dados.
function idsDosDias(meses) {
  return meses.flatMap((id) => {
    const [ano, mes] = id.split('-').map(Number);
    const diasNoMes = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
    return Array.from({ length: diasNoMes }, (_, i) => `${dois(i + 1)}-${dois(mes)}-${ano}`);
  });
}

function referenciaDaLoja(db, lojaId) {
  return db.collection('estabelecimentos').doc(String(lojaId));
}

// Rotina da noite: le pelo id os dias do mes atual e do anterior e grava por cima desses dois meses
// (merge no mapa meses: os outros meses ficam como estao). Mes sem documento grava zero.
async function atualizarVisitasPorMes({ db, FieldValue, lojaId, agora = new Date(), gravar = true }) {
  const loja = referenciaDaLoja(db, lojaId);
  const meses = mesesDaNoite(agora);
  const referencias = idsDosDias(meses).map((id) => loja.collection('DailyStats').doc(id));
  const snapshots = referencias.length ? await db.getAll(...referencias) : [];
  const soma = somarVisitasPorMes(snapshots
    .filter((snapshot) => snapshot.exists)
    .map((snapshot) => ({ id: snapshot.id, dados: snapshot.data() })));
  const mesesGravados = Object.fromEntries(meses.map((mes) => [mes, soma.meses[mes] || { app: 0, agente: 0 }]));
  const documento = {
    meses: mesesGravados,
    ...(soma.ultimoDia ? { atualizadoAte: soma.ultimoDia } : {}),
    atualizadoEm: FieldValue.serverTimestamp(),
  };
  if (gravar) await loja.collection('Stats').doc(VISITAS_POR_MES_DOCUMENT).set(documento, { merge: true });
  return { meses: mesesGravados, atualizadoAte: soma.ultimoDia, diasLidos: referencias.length, encontrados: soma.lidos };
}

module.exports = {
  TIME_ZONE,
  VISITAS_POR_MES_DOCUMENT,
  atualizarVisitasPorMes,
  diaDoId,
  idsDosDias,
  mesesDaNoite,
  somarVisitasPorMes,
};
