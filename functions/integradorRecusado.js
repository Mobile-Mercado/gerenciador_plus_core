// Aviso para o Thay quando um computador for recusado no integrador (Cola 76, item 3).
//
// As funcoes do integrador (mobile_firebase_api e mobile_old_web_platform) gravam
// estabelecimentos/{loja}/IntegradorDaLoja/atual.tentativaRecusada = { maquina, nome, em } quando
// um computador diferente do registrado chama a nuvem (no maximo uma vez a cada 10 min por loja) e,
// com configuracoes/integradorUmPorLoja.recusar === true, respondem 409. O gatilho
// avisarComputadorRecusado (functions/index.js) chama avisarComputadorRecusadoUmaVez, que:
//   1. so segue quando chegou uma tentativa nova (o "em" mudou);
//   2. so avisa com a recusa ligada (recusar === true); no modo "so registrar" ninguem foi recusado;
//   3. abre um alerta na aba Alertas do Admin (alertasDoAdmin), com loja, data e hora no texto e o
//      nome do computador so nos detalhes do alerta. O id do alerta junta loja, computador e dia
//      (fuso de Sao Paulo) e e criado com create(), que falha se ja existe: no maximo um alerta por
//      computador recusado e por dia, mesmo com duas entregas do mesmo evento.
//
// Nunca registra o nome nem o hash do computador em log.
// Arquivo puro: o banco chega por parametro.

const { diaDe } = require('./buscasResumo');

const COLECAO_DE_ALERTAS = 'alertasDoAdmin';
const CHAVE_DO_ALERTA = 'integrador-recusado';
const CAMINHO_DA_CHAVE = ['configuracoes', 'integradorUmPorLoja'];
const TITULO_DO_ALERTA = 'Computador recusado no integrador';
// Codigo gRPC ALREADY_EXISTS, devolvido pelo create() do Admin SDK quando o documento existe.
const JA_EXISTE = 6;
const HASH_VALIDO = /^[0-9a-f]{64}$/;
const ID_VALIDO = /^[A-Za-z0-9_-]{1,128}$/;
const DATA_E_HORA = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function paraData(valor) {
  if (!valor) return null;
  const data = typeof valor.toDate === 'function' ? valor.toDate() : new Date(valor);
  return Number.isNaN(data.getTime()) ? null : data;
}

// A tentativa que acabou de chegar, ou null (sem tentativa, mesma tentativa de antes, ou fora do
// formato).
function tentativaNova(antes = {}, depois = {}) {
  const tentativa = depois?.tentativaRecusada;
  if (!tentativa || typeof tentativa.maquina !== 'string' || !HASH_VALIDO.test(tentativa.maquina)) return null;
  const em = paraData(tentativa.em);
  if (!em) return null;
  const anterior = paraData(antes?.tentativaRecusada?.em);
  if (anterior && anterior.getTime() === em.getTime() && antes?.tentativaRecusada?.maquina === tentativa.maquina) return null;
  return { maquina: tentativa.maquina, nome: typeof tentativa.nome === 'string' ? tentativa.nome : null, em };
}

// "21/11/2026 às 11:43" (horario de Sao Paulo).
function dataEHora(data) {
  const p = Object.fromEntries(DATA_E_HORA.formatToParts(data).map((parte) => [parte.type, parte.value]));
  return `${p.day}/${p.month}/${p.year} às ${p.hour}:${p.minute}`;
}

function idDoAlerta({ lojaId, maquina, dia }) {
  return `${CHAVE_DO_ALERTA}_${lojaId}_${maquina.slice(0, 16)}_${dia}`;
}

// Nome do computador como o integrador mandou, so sem caracteres de controle e com no maximo 100
// caracteres. Vai so para os detalhes do alerta, que so o Admin ve.
function nomeDoComputador(nome) {
  if (typeof nome !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return nome.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}

function alertaDoComputadorRecusado({ lojaId, nomeDaLoja, tentativa, agora }) {
  const nome = nomeDoComputador(tentativa.nome);
  return {
    item: null,
    chave: CHAVE_DO_ALERTA,
    titulo: TITULO_DO_ALERTA,
    texto: `${nomeDaLoja}: um computador diferente do registrado tentou usar o integrador em ${dataEHora(tentativa.em)} e foi recusado.`,
    gravidade: 'atencao',
    alcance: { tipo: 'loja', lojaId, nome: nomeDaLoja },
    detalhes: [
      `Computador recusado: ${nome || 'nome não informado'}`,
      `Recusado em: ${dataEHora(tentativa.em)}`,
    ],
    situacao: 'aberto',
    abertoEm: tentativa.em,
    atualizadoEm: agora,
    resolvidoEm: null,
    resolvidoPor: null,
  };
}

async function recusaLigada(db) {
  const chave = await db.collection(CAMINHO_DA_CHAVE[0]).doc(CAMINHO_DA_CHAVE[1]).get();
  return chave.exists === true && chave.data()?.recusar === true;
}

// Resultado: { avisado: true, id } ou { avisado: false, motivo }.
async function avisarComputadorRecusadoUmaVez({ db, lojaId, antes, depois, agora = new Date() }) {
  if (typeof lojaId !== 'string' || !ID_VALIDO.test(lojaId)) return { avisado: false, motivo: 'loja_invalida' };
  const tentativa = tentativaNova(antes, depois);
  if (!tentativa) return { avisado: false, motivo: 'sem_tentativa_nova' };
  if (!(await recusaLigada(db))) return { avisado: false, motivo: 'so_registrar' };

  const loja = await db.collection('estabelecimentos').doc(lojaId).get();
  const dadosDaLoja = loja.exists ? loja.data() || {} : {};
  const nomeDaLoja = String(dadosDaLoja.name || dadosDaLoja.nomeEstabelecimento || lojaId).trim().slice(0, 100) || lojaId;
  const id = idDoAlerta({ lojaId, maquina: tentativa.maquina, dia: diaDe(tentativa.em) });
  try {
    await db.collection(COLECAO_DE_ALERTAS).doc(id).create(alertaDoComputadorRecusado({ lojaId, nomeDaLoja, tentativa, agora }));
  } catch (error) {
    if (error?.code === JA_EXISTE) return { avisado: false, motivo: 'ja_avisado_no_dia' };
    throw error;
  }
  return { avisado: true, id };
}

module.exports = {
  CHAVE_DO_ALERTA,
  COLECAO_DE_ALERTAS,
  TITULO_DO_ALERTA,
  alertaDoComputadorRecusado,
  avisarComputadorRecusadoUmaVez,
  dataEHora,
  idDoAlerta,
  tentativaNova,
};
