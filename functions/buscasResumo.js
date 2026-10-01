// Resumo diario das buscas do app, por loja, a partir de estabelecimentos/{loja}/SearchLogs.
//
// Arquivo puro: nao requer firebase-admin nem firebase-functions e recebe as
// referencias por parametro, como categoriasContagem.js e agenteConversas.js.
//
// REGRA QUE NAO SE VIOLA: o termo e guardado exatamente como foi registrado. A unica
// juncao e contar repeticao do mesmo texto. "COCA COLA 1", "COCA COLA 1 LI" e
// "COCA COLA 1 LITRO" sao tres termos, e continuam tres. Nao ha agrupamento por
// prefixo, por semelhanca nem escolha do termo mais longo: interpretar o que o cliente
// quis dizer e assunto de outra camada, depois desta.

const RESUMO_VERSION = 1;
const RESUMO_DOCUMENT = 'buscasResumo';
const DIAS_SUBCOLECAO = 'dias';
// Duas janelas, de proposito. O topo guarda um ano de contagem, para o periodo "Ano" da
// tela mostrar doze meses de verdade; sao 365 linhas pequenas, uns 40 KB. O documento de
// cada dia, com termos e clientes, e a limpeza de SearchLogs ficam em 90 dias. Pedido de
// lista de termos alem de 90 dias devolve o que existe, sem erro.
const DIAS_NO_TOPO = 365;
const DIAS_COM_DOCUMENTO = 90;
const LOTE_DE_EXCLUSAO = 300;
const TIME_ZONE = 'America/Sao_Paulo';

const formatador = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function partes(data) {
  const mapa = {};
  formatador.formatToParts(data).forEach(({ type, value }) => { mapa[type] = value; });
  return mapa;
}

// Dia no fuso da loja, no formato aaaa-mm-dd.
function diaDe(data) {
  const p = partes(data);
  return `${p.year}-${p.month}-${p.day}`;
}

// Quantos minutos o fuso esta a frente do UTC naquele instante.
function deslocamentoMinutos(data) {
  const p = partes(data);
  const comoUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour === '24' ? 0 : p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return (comoUtc - data.getTime()) / 60000;
}

// Comeco e fim do dia no fuso da loja, em instantes UTC.
function limitesDoDia(dia) {
  const [ano, mes, dias] = String(dia).split('-').map(Number);
  const palpite = new Date(Date.UTC(ano, mes - 1, dias, 12, 0, 0));
  const deslocamento = deslocamentoMinutos(palpite);
  const inicio = new Date(Date.UTC(ano, mes - 1, dias, 0, 0, 0) - deslocamento * 60000);
  const fim = new Date(inicio.getTime() + 24 * 60 * 60 * 1000);
  return { inicio, fim };
}

function diaAnterior(agora = new Date()) {
  const { inicio } = limitesDoDia(diaDe(agora));
  return diaDe(new Date(inicio.getTime() - 60 * 60 * 1000));
}

function paraData(valor) {
  if (!valor) return null;
  if (typeof valor.toDate === 'function') return valor.toDate();
  if (valor instanceof Date) return valor;
  const convertido = new Date(valor);
  return Number.isNaN(convertido.getTime()) ? null : convertido;
}

const maisVezes = (a, b) => b.vezes - a.vezes || a.termo.localeCompare(b.termo);

// buscas: documentos do dia, como objetos simples. Nenhum texto alem do termo sai daqui.
function resumirBuscas({ buscas = [], dia }) {
  const termos = new Map();
  const clientes = new Map();
  let semResultado = 0;

  buscas.forEach((busca) => {
    const termo = String(busca?.termo ?? '');
    if (!termo) return;
    const quando = paraData(busca?.em);
    const vazio = Number(busca?.resultados || 0) === 0;
    if (vazio) semResultado += 1;

    if (!termos.has(termo)) {
      termos.set(termo, { termo, vezes: 0, semResultado: 0, ultima: null });
    }
    const registro = termos.get(termo);
    registro.vezes += 1;
    if (vazio) registro.semResultado += 1;
    if (quando && (!registro.ultima || quando > registro.ultima)) registro.ultima = quando;

    const clienteId = String(busca?.clienteId || '');
    if (!clienteId) return;
    if (!clientes.has(clienteId)) clientes.set(clienteId, { clienteId, buscas: 0, termos: new Map() });
    const cliente = clientes.get(clienteId);
    cliente.buscas += 1;
    if (!cliente.termos.has(termo)) {
      cliente.termos.set(termo, { termo, vezes: 0, primeira: quando, ultima: quando });
    }
    const doCliente = cliente.termos.get(termo);
    doCliente.vezes += 1;
    if (quando) {
      if (!doCliente.primeira || quando < doCliente.primeira) doCliente.primeira = quando;
      if (!doCliente.ultima || quando > doCliente.ultima) doCliente.ultima = quando;
    }
  });

  return {
    version: RESUMO_VERSION,
    dia,
    buscas: buscas.length,
    semResultado,
    termosDistintos: termos.size,
    clientes: clientes.size,
    termos: [...termos.values()].sort(maisVezes),
    porCliente: [...clientes.values()]
      .map((cliente) => ({
        clienteId: cliente.clienteId,
        buscas: cliente.buscas,
        termos: [...cliente.termos.values()].sort(maisVezes),
      }))
      .sort((a, b) => b.buscas - a.buscas || a.clienteId.localeCompare(b.clienteId)),
  };
}

function resumoReference(storeRef) {
  return storeRef.collection('Stats').doc(RESUMO_DOCUMENT);
}

function diaReference(storeRef, dia) {
  return resumoReference(storeRef).collection(DIAS_SUBCOLECAO).doc(dia);
}

async function carregarBuscasDoDia({ storeRef, dia }) {
  const { inicio, fim } = limitesDoDia(dia);
  const snapshot = await storeRef
    .collection('SearchLogs')
    .where('em', '>=', inicio)
    .where('em', '<', fim)
    .get();
  return snapshot.docs.map((documento) => documento.data());
}

// Dia no formato aaaa-mm-dd, n dias para tras.
function diaMenos(dia, n) {
  const { inicio } = limitesDoDia(dia);
  return diaDe(new Date(inicio.getTime() - n * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000));
}

// Duas partes: o documento do dia, com termos e clientes, e o resumo de topo, que guarda
// so a contagem de cada dia. A tela filtra qualquer periodo ate um ano pelo topo, numa
// leitura, e abre os dias quando quiser a lista de termos.
//
// Cada linha do topo traz `documento`, dizendo se o documento daquele dia ainda existe.
// E por isso que a limpeza nao tenta apagar de novo, toda noite, dia que ja foi apagado.
async function escreverResumoDeBuscas({
  storeRef,
  resumo,
  atualizadoEm,
  diasNoTopo = DIAS_NO_TOPO,
  diasComDocumento = DIAS_COM_DOCUMENTO,
}) {
  await diaReference(storeRef, resumo.dia).set({ ...resumo, atualizadoEm });

  const referencia = resumoReference(storeRef);
  const atual = await referencia.get();
  const anteriores = (atual.exists ? atual.get('dias') : null) || [];
  const linha = {
    dia: resumo.dia,
    buscas: resumo.buscas,
    semResultado: resumo.semResultado,
    termosDistintos: resumo.termosDistintos,
    clientes: resumo.clientes,
    documento: true,
  };
  // A janela do topo e de data, nao de quantidade: dia mais velho que ela perde a linha.
  // O corte por quantidade fica como teto, para o documento nunca crescer sem limite.
  const limiteDoTopo = diaMenos(resumo.dia, diasNoTopo);
  const dias = [...anteriores.filter((entrada) => entrada?.dia !== resumo.dia), linha]
    .filter((entrada) => entrada?.dia && String(entrada.dia) >= limiteDoTopo)
    .sort((a, b) => String(a.dia).localeCompare(String(b.dia)))
    .slice(-diasNoTopo);

  // Documento de dia mais velho que a retencao sai; a linha de contagem fica.
  const corte = diaMenos(resumo.dia, diasComDocumento);
  const semDocumento = [];
  for (const entrada of dias) {
    if (entrada.documento === false) continue;
    if (String(entrada.dia) >= corte) continue;
    await diaReference(storeRef, entrada.dia).delete();
    entrada.documento = false;
    semDocumento.push(entrada.dia);
  }

  await referencia.set({
    version: RESUMO_VERSION,
    atualizadoEm,
    primeiroDia: dias[0]?.dia || resumo.dia,
    ultimoDia: dias.at(-1)?.dia || resumo.dia,
    primeiroDiaComDocumento: dias.find((entrada) => entrada.documento !== false)?.dia || resumo.dia,
    dias,
  });

  // Linha que saiu da janela do topo: o documento dela, se ainda existia, vai embora.
  const mantidos = new Set(dias.map((entrada) => entrada.dia));
  const fora = anteriores
    .filter((entrada) => entrada?.dia && !mantidos.has(entrada.dia))
    .map((entrada) => entrada.dia);
  for (const dia of fora) {
    await diaReference(storeRef, dia).delete();
  }

  return {
    dias: dias.length,
    diasSemDocumento: semDocumento.length,
    linhasRemovidas: fora.length,
  };
}

// Chamada so depois de o resumo estar gravado: se falhar aqui, o resumo fica.
async function limparBuscasAntigas({
  storeRef, antesDe, lote = LOTE_DE_EXCLUSAO, maximo = 5000,
}) {
  let removidos = 0;
  while (removidos < maximo) {
    const snapshot = await storeRef
      .collection('SearchLogs')
      .where('em', '<', antesDe)
      .limit(lote)
      .get();
    if (snapshot.empty) break;
    for (const documento of snapshot.docs) {
      await documento.ref.delete();
      removidos += 1;
    }
    if (snapshot.size < lote) break;
  }
  return removidos;
}

function limiteDeRetencao(agora = new Date(), diasComDocumento = DIAS_COM_DOCUMENTO) {
  return new Date(agora.getTime() - diasComDocumento * 24 * 60 * 60 * 1000);
}

// Resumo do dia anterior, gravacao, e so entao a limpeza.
async function rodarResumoDeBuscas({
  storeRef,
  agora = new Date(),
  atualizadoEm,
  diasNoTopo = DIAS_NO_TOPO,
  diasComDocumento = DIAS_COM_DOCUMENTO,
  limpar = true,
}) {
  const dia = diaAnterior(agora);
  const buscas = await carregarBuscasDoDia({ storeRef, dia });
  const resumo = resumirBuscas({ buscas, dia });
  const gravado = await escreverResumoDeBuscas({
    storeRef, resumo, atualizadoEm, diasNoTopo, diasComDocumento,
  });

  let removidos = 0;
  let falhaNaLimpeza = null;
  if (limpar) {
    try {
      removidos = await limparBuscasAntigas({
        storeRef,
        antesDe: limiteDeRetencao(agora, diasComDocumento),
      });
    } catch (error) {
      falhaNaLimpeza = error?.message || String(error);
    }
  }

  return {
    dia,
    buscas: resumo.buscas,
    semResultado: resumo.semResultado,
    termosDistintos: resumo.termosDistintos,
    clientes: resumo.clientes,
    ...gravado,
    removidos,
    ...(falhaNaLimpeza ? { falhaNaLimpeza } : {}),
  };
}

module.exports = {
  DIAS_COM_DOCUMENTO,
  DIAS_NO_TOPO,
  RESUMO_DOCUMENT,
  RESUMO_VERSION,
  carregarBuscasDoDia,
  diaAnterior,
  diaDe,
  diaMenos,
  diaReference,
  escreverResumoDeBuscas,
  limiteDeRetencao,
  limitesDoDia,
  limparBuscasAntigas,
  resumirBuscas,
  resumoReference,
  rodarResumoDeBuscas,
};
