// Situacao de um banner da loja (estabelecimentos/{loja}/Banners/{id}), rodada de 15/10/2026.
//
// Existe porque o app do cliente mostra banner com status == true e endAt no futuro, sem olhar
// startAt (mobile_cliente firebase_banners_repository_impl.dart:16-20). Banner com inicio no futuro
// fica com status false e aguardandoInicio true ate a data; a rotina ligarBannersAgendados liga.
//
// Regra unica, usada pelo Core (BannersDaLoja.js) e pelas functions (index.js). O painel web tem
// uma copia (src/features/shell/situacaoDoBanner.js), com o mesmo teste.
//   noApp      status true e startAt <= agora < endAt
//   agendado   aguardandoInicio true, ou status true com startAt > agora
//   pausado    status false, aguardandoInicio diferente de true, endAt no futuro
//   encerrado  endAt <= agora
//
// Arquivo puro: nao requer firebase-admin nem firebase-functions.
const SITUACOES = Object.freeze({
  NO_APP: 'noApp',
  AGENDADO: 'agendado',
  PAUSADO: 'pausado',
  ENCERRADO: 'encerrado',
});

// Timestamp do Admin SDK, objeto { seconds } ou { _seconds }, Date, texto ISO ou milissegundos.
function emMilissegundos(valor) {
  if (valor === null || valor === undefined) return null;
  if (typeof valor.toMillis === 'function') return valor.toMillis();
  if (typeof valor.toDate === 'function') return valor.toDate().getTime();
  if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? null : valor.getTime();
  if (typeof valor.seconds === 'number') return valor.seconds * 1000 + Math.floor((valor.nanoseconds || 0) / 1e6);
  if (typeof valor._seconds === 'number') return valor._seconds * 1000 + Math.floor((valor._nanoseconds || 0) / 1e6);
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  const data = new Date(valor);
  return Number.isNaN(data.getTime()) ? null : data.getTime();
}

function situacaoDoBanner(banner, agora = Date.now()) {
  const momento = emMilissegundos(agora);
  const inicio = emMilissegundos(banner?.startAt);
  const fim = emMilissegundos(banner?.endAt);
  if (fim !== null && fim <= momento) return SITUACOES.ENCERRADO;
  const ativo = banner?.status === true;
  const comecou = inicio === null || inicio <= momento;
  if (ativo && comecou) return SITUACOES.NO_APP;
  if (banner?.aguardandoInicio === true || ativo) return SITUACOES.AGENDADO;
  return SITUACOES.PAUSADO;
}

// Gatilho (7.3): banner com status true e inicio no futuro, de qualquer origem (o app gerenciador grava
// status true e started true mesmo com inicio no futuro), passa a aguardar o inicio. Devolve os campos a
// gravar ou null. Depois da gravacao status e false: a segunda passada devolve null (sem laco).
function normalizacaoDoAgendado(banner, agora = Date.now()) {
  if (!banner || banner.status !== true) return null;
  const inicio = emMilissegundos(banner.startAt);
  if (inicio === null || inicio <= emMilissegundos(agora)) return null;
  return { status: false, started: false, aguardandoInicio: true };
}

// Rotina (7.4): campos que ligam um banner que aguardava o inicio.
const CAMPOS_AO_LIGAR = Object.freeze({ status: true, started: true, aguardandoInicio: false });

// Pausar e Retomar (7.6). Pausar: status false, aguardandoInicio false; started fica como esta (agendado
// pausado nao liga na data). Retomar: inicio no futuro volta a Agendado; ja comecou e nao terminou, liga.
// Encerrado nao tem Pausar nem Retomar: devolve null.
function camposDaAcao(banner, acao, agora = Date.now()) {
  if (situacaoDoBanner(banner, agora) === SITUACOES.ENCERRADO) return null;
  if (acao === 'pausar') return { status: false, aguardandoInicio: false };
  if (acao !== 'retomar') throw new Error(`Acao de banner invalida: ${acao}`);
  const inicio = emMilissegundos(banner?.startAt);
  if (inicio !== null && inicio > emMilissegundos(agora)) return { status: false, started: false, aguardandoInicio: true };
  return { ...CAMPOS_AO_LIGAR };
}

// Gatilho ajustarBannerGravado (7.3 e 7.5): banner criado, atualizado ou removido, de qualquer origem
// (Core, app gerenciador, rotina). Criado ou atualizado com status true e inicio no futuro passa a
// aguardar o inicio. Toda gravacao marca 'banners' no marcador da loja, para a tela Loja reler.
// `depois` e null na remocao. Falha na normalizacao nao impede a marca.
async function tratarBannerGravado({
  lojaId, referencia, depois, agora = Date.now(), marcar, aoFalhar = () => {},
}) {
  let normalizou = false;
  const campos = depois ? normalizacaoDoAgendado(depois, agora) : null;
  if (campos && referencia) {
    try {
      await referencia.update(campos);
      normalizou = true;
    } catch (error) {
      aoFalhar('normalizar', error);
    }
  }
  await marcar(lojaId);
  return { normalizou };
}

// Rotina ligarBannersAgendados (7.4), a cada 5 minutos: banners com aguardandoInicio true e startAt ja
// passado viram status true, started true e aguardandoInicio false. So os de estabelecimentos/{loja}/Banners.
// Devolve quantos ligou por loja, com a referencia da loja (para Stats/rotinasNoturnas).
async function ligarBannersAgendados({ db, agora = new Date(), limite = 500, aoFalhar = () => {} }) {
  const snapshot = await db.collectionGroup('Banners')
    .where('aguardandoInicio', '==', true)
    .where('startAt', '<=', agora)
    .limit(limite)
    .get();
  const porLoja = new Map();
  for (const documento of snapshot.docs) {
    const lojaRef = documento.ref.parent?.parent;
    if (!lojaRef || lojaRef.parent?.id !== 'estabelecimentos') continue;
    try {
      await documento.ref.update({ ...CAMPOS_AO_LIGAR });
      const atual = porLoja.get(lojaRef.id) || { storeRef: lojaRef, ligados: 0 };
      atual.ligados += 1;
      porLoja.set(lojaRef.id, atual);
    } catch (error) {
      aoFalhar(documento.ref.path, error);
    }
  }
  return { lidos: snapshot.docs.length, porLoja };
}

module.exports = {
  CAMPOS_AO_LIGAR,
  SITUACOES,
  camposDaAcao,
  emMilissegundos,
  ligarBannersAgendados,
  normalizacaoDoAgendado,
  situacaoDoBanner,
  tratarBannerGravado,
};
