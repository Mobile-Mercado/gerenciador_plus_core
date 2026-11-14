// Tentativas de login do app do cliente (cola RP-172, itens 1 a 3).
//
// O app manda um registro por etapa de cada tentativa (pediu o codigo, codigo enviado,
// codigo confirmado, entrou, falhou), antes ou depois do login, pela function
// registrarTentativaDeLogin. Aqui ficam a validacao, o limite por aparelho e o resumo da
// madrugada. Arquivo puro: nao requer firebase-admin nem firebase-functions e recebe as
// referencias por parametro, como buscasResumo.js.
//
// REGRA QUE NAO SE VIOLA: nenhum telefone, e-mail, nome ou codigo de SMS entra em
// LoginAttempts. Cada campo e de lista fechada (ou de formato fechado, no codigo do erro e
// nos ids aleatorios); o que nao cabe e recusado, nunca gravado "como veio". Sem uid antes
// do login: o uid so vai no registro "entrou", e vem do token da chamada, nao do corpo.

const crypto = require('node:crypto');
const { diaAnterior, diaDe, diaMenos, limitesDoDia } = require('./buscasResumo');

const COLECAO = 'LoginAttempts';
const COLECAO_DO_LIMITE = 'LoginAttemptsLimite';
const RESUMO_DOCUMENT = 'loginResumo';
const RESUMO_DE_TODAS = 'todas';
const RESUMO_DE_TODAS_COLECAO = 'LoginResumo';
const DIAS_SUBCOLECAO = 'dias';
const RESUMO_VERSION = 1;

const METODOS = Object.freeze(['telefone', 'google', 'apple', 'email', 'anonimo']);
const PLATAFORMAS = Object.freeze(['ios', 'android']);
const ETAPAS = Object.freeze(['pediu_codigo', 'codigo_enviado', 'codigo_confirmado', 'entrou', 'falhou']);

// Marca do app geral (nao whitelabel): o mesmo valor que o app compara em
// core_module/lib/src/env.dart (Env.isWhitelabel). As outras marcas vem de
// estabelecimentos.whitelabelId.
const MARCA_DO_APP_GERAL = 'br.com.mobile.cliente';

const MAX_REGISTROS_POR_CHAMADA = 20;
// Por aparelho e por hora. Uma tentativa pelo SMS gera ate 4 registros; 60 cobre 15
// tentativas por hora, bem acima do que uma pessoa faz, e corta um laco.
const MAX_REGISTROS_POR_APARELHO_POR_HORA = 60;
const DIAS_DE_RETENCAO = 90;
const DIAS_NO_TOPO = 365;
const DIAS_COM_DOCUMENTO = 90;
// Registro guardado sem internet e mandado depois: vale a hora do aparelho se for de ate 7
// dias atras e nao estiver no futuro (5 min de folga no relogio).
const ATRASO_MAXIMO_MS = 7 * 24 * 60 * 60 * 1000;
const FOLGA_DO_RELOGIO_MS = 5 * 60 * 1000;

const ID_ALEATORIO = /^[A-Za-z0-9-]{8,64}$/;
const ID_DE_LOJA = /^[A-Za-z0-9_-]{1,128}$/;
const VERSAO = /^\d{1,4}\.\d{1,4}\.\d{1,4}(\+\d{1,9})?$/;
// Codigo do Firebase ou do provedor: "invalid-verification-code", "google/canceled",
// "apple/unknown", "cadastro/permission-denied". Sem espaco, sem "@", sem sequencia
// longa de digitos: nada que traga telefone ou e-mail.
const CODIGO_DE_ERRO = /^[a-z0-9][a-z0-9_./-]{0,63}$/;
const DIGITOS_DEMAIS = /\d{7,}/;

class RegistroInvalido extends Error {}

function textoOuNulo(valor) {
  return typeof valor === 'string' && valor.trim() ? valor.trim() : null;
}

// Codigo do erro em minusculas, ou null se nao couber no formato.
function codigoDeErro(valor) {
  const codigo = textoOuNulo(valor)?.toLowerCase() ?? null;
  if (!codigo || !CODIGO_DE_ERRO.test(codigo) || DIGITOS_DEMAIS.test(codigo)) return null;
  return codigo;
}

function momentoDoRegistro(quando, agora) {
  const numero = Number(quando);
  if (!Number.isFinite(numero) || numero <= 0) return agora;
  const diferenca = agora.getTime() - numero;
  if (diferenca < -FOLGA_DO_RELOGIO_MS || diferenca > ATRASO_MAXIMO_MS) return agora;
  return new Date(Math.min(numero, agora.getTime()));
}

// Resumo do aparelho: os 16 primeiros caracteres do SHA-256 do id aleatorio que o app
// cria na instalacao. O id cru nao e gravado.
function resumoDoAparelho(aparelho) {
  return crypto.createHash('sha256').update(String(aparelho)).digest('hex').slice(0, 16);
}

// Um registro do corpo da chamada, ja validado, no formato de LoginAttempts. Lanca
// RegistroInvalido com o campo que nao passou; o motivo nunca traz o valor recebido.
function validarRegistro(bruto, {
  lojas, marcas, aparelho, uidDoLogin = null, agora = new Date(),
}) {
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) throw new RegistroInvalido('registro');

  const tentativa = textoOuNulo(bruto.tentativa);
  if (!tentativa || !ID_ALEATORIO.test(tentativa)) throw new RegistroInvalido('tentativa');

  const metodo = textoOuNulo(bruto.metodo);
  if (!METODOS.includes(metodo)) throw new RegistroInvalido('metodo');

  const plataforma = textoOuNulo(bruto.plataforma);
  if (!PLATAFORMAS.includes(plataforma)) throw new RegistroInvalido('plataforma');

  const etapa = textoOuNulo(bruto.etapa);
  if (!ETAPAS.includes(etapa)) throw new RegistroInvalido('etapa');

  const versao = textoOuNulo(bruto.versao);
  if (!versao || !VERSAO.test(versao)) throw new RegistroInvalido('versao');

  const marca = textoOuNulo(bruto.marca);
  if (!marca || !marcas.has(marca)) throw new RegistroInvalido('marca');

  const loja = textoOuNulo(bruto.loja);
  if (loja !== null && (!ID_DE_LOJA.test(loja) || !lojas.has(loja))) throw new RegistroInvalido('loja');

  let erro = null;
  if (etapa === 'falhou') {
    erro = codigoDeErro(bruto.erro);
    if (!erro) throw new RegistroInvalido('erro');
  } else if (bruto.erro !== undefined && bruto.erro !== null) {
    throw new RegistroInvalido('erro');
  }

  const em = momentoDoRegistro(bruto.quando, agora);
  return {
    tentativa,
    loja,
    marca,
    metodo,
    plataforma,
    versao,
    etapa,
    erro,
    // Sem uid antes do login. No "entrou", o da chamada (token do Firebase), se houver.
    uid: etapa === 'entrou' && uidDoLogin ? uidDoLogin : null,
    aparelho,
    em,
    expiraEm: new Date(em.getTime() + DIAS_DE_RETENCAO * 24 * 60 * 60 * 1000),
  };
}

// Corpo da chamada: { aparelho, registros: [...] }. Devolve os validos e quantos ficaram
// fora. Corpo sem aparelho ou sem lista e recusado inteiro.
function validarChamada(corpo, {
  lojas, marcas, uidDoLogin = null, agora = new Date(),
}) {
  const aparelhoCru = textoOuNulo(corpo?.aparelho);
  if (!aparelhoCru || !ID_ALEATORIO.test(aparelhoCru)) throw new RegistroInvalido('aparelho');
  const lista = corpo?.registros;
  if (!Array.isArray(lista) || !lista.length) throw new RegistroInvalido('registros');
  if (lista.length > MAX_REGISTROS_POR_CHAMADA) throw new RegistroInvalido('registros');

  const aparelho = resumoDoAparelho(aparelhoCru);
  const validos = [];
  const motivos = {};
  lista.forEach((bruto) => {
    try {
      validos.push(validarRegistro(bruto, {
        lojas, marcas, aparelho, uidDoLogin, agora,
      }));
    } catch (error) {
      if (!(error instanceof RegistroInvalido)) throw error;
      motivos[error.message] = (motivos[error.message] || 0) + 1;
    }
  });
  return { aparelho, validos, invalidos: lista.length - validos.length, motivos };
}

// Hora UTC no formato aaaammddhh: a janela do limite.
function horaDoLimite(agora = new Date()) {
  return agora.toISOString().slice(0, 13).replace(/[-T]/g, '');
}

function chaveDoLimite(aparelho, agora = new Date()) {
  return `${aparelho}_${horaDoLimite(agora)}`;
}

// Quantos registros ainda cabem na hora do aparelho.
function cabemNoLimite(jaGravados, pedidos, maximo = MAX_REGISTROS_POR_APARELHO_POR_HORA) {
  const usados = Math.max(0, Number(jaGravados) || 0);
  return Math.max(0, Math.min(pedidos, maximo - usados));
}

// Marcas aceitas e lojas existentes, a partir de estabelecimentos (id e whitelabelId).
function listasFechadas(lojasDoBanco = []) {
  const lojas = new Set();
  const marcas = new Set([MARCA_DO_APP_GERAL]);
  lojasDoBanco.forEach(({ id, whitelabelId }) => {
    if (id) lojas.add(String(id));
    const marca = textoOuNulo(whitelabelId);
    if (marca) marcas.add(marca);
  });
  return { lojas, marcas };
}

// Grava os registros validos numa transacao com o contador da hora do aparelho: o que
// passar do limite fica de fora (e e contado na resposta), nunca gravado.
async function gravarTentativas({
  db, validos, aparelho, agora = new Date(), recebidoEm = agora,
  maximo = MAX_REGISTROS_POR_APARELHO_POR_HORA,
}) {
  if (!validos.length) return { gravados: 0, descartadosPeloLimite: 0 };
  const limiteRef = db.collection(COLECAO_DO_LIMITE).doc(chaveDoLimite(aparelho, agora));
  return db.runTransaction(async (transacao) => {
    const atual = await transacao.get(limiteRef);
    const usados = atual.exists ? Number(atual.get('registros') || 0) : 0;
    const cabem = cabemNoLimite(usados, validos.length, maximo);
    validos.slice(0, cabem).forEach((registro) => {
      transacao.create(db.collection(COLECAO).doc(), { ...registro, recebidoEm });
    });
    transacao.set(limiteRef, {
      registros: usados + cabem,
      // A janela e de uma hora; o documento sai na limpeza da madrugada.
      expiraEm: new Date(agora.getTime() + 2 * 60 * 60 * 1000),
    }, { merge: true });
    return { gravados: cabem, descartadosPeloLimite: validos.length - cabem };
  });
}

// ---- Resumo da madrugada ----

function paraData(valor) {
  if (!valor) return null;
  if (typeof valor.toDate === 'function') return valor.toDate();
  if (valor instanceof Date) return valor;
  const convertido = new Date(valor);
  return Number.isNaN(convertido.getTime()) ? null : convertido;
}

function contadorVazio() {
  return { tentativas: 0, entradas: 0, falhas: 0, semResultado: 0 };
}

function somar(contador, situacao) {
  contador.tentativas += 1;
  if (situacao === 'entrou') contador.entradas += 1;
  else if (situacao === 'falhou') contador.falhas += 1;
  else contador.semResultado += 1;
}

function erroCancelado(erro) {
  return /(^|[/_.-])cancel(ed|led)?$/.test(String(erro || ''));
}

// Uma tentativa e o conjunto de registros com o mesmo id. Situacao final: entrou, se algum
// registro diz "entrou"; falhou, se nenhum entrou e algum falhou; sem resultado, nos
// outros (pediu o codigo e nao voltou). Metodo, plataforma e versao do primeiro registro.
function resumirTentativas({ registros = [], dia }) {
  const tentativas = new Map();
  const porEtapa = Object.fromEntries(ETAPAS.map((etapa) => [etapa, 0]));
  const erros = new Map();

  [...registros]
    .sort((a, b) => (paraData(a?.em)?.getTime() || 0) - (paraData(b?.em)?.getTime() || 0))
    .forEach((registro) => {
      if (!registro?.tentativa) return;
      if (Object.hasOwn(porEtapa, registro.etapa)) porEtapa[registro.etapa] += 1;
      if (!tentativas.has(registro.tentativa)) {
        tentativas.set(registro.tentativa, {
          metodo: registro.metodo,
          plataforma: registro.plataforma,
          versao: registro.versao,
          aparelho: registro.aparelho || null,
          entrou: false,
          falhou: false,
        });
      }
      const tentativa = tentativas.get(registro.tentativa);
      if (registro.etapa === 'entrou') tentativa.entrou = true;
      if (registro.etapa === 'falhou') {
        tentativa.falhou = true;
        const chave = `${registro.erro}|${registro.metodo}|${registro.plataforma}`;
        if (!erros.has(chave)) {
          erros.set(chave, {
            erro: registro.erro || 'sem-codigo',
            metodo: registro.metodo,
            plataforma: registro.plataforma,
            vezes: 0,
          });
        }
        erros.get(chave).vezes += 1;
      }
    });

  const total = contadorVazio();
  const porMetodo = Object.fromEntries(METODOS.map((metodo) => [metodo, contadorVazio()]));
  const porPlataforma = Object.fromEntries(PLATAFORMAS.map((plataforma) => [plataforma, contadorVazio()]));
  const porVersao = new Map();
  const aparelhos = new Set();
  const aparelhosQueEntraram = new Set();
  const aparelhosQueFalharam = new Set();

  tentativas.forEach((tentativa) => {
    let situacao = 'semResultado';
    if (tentativa.entrou) situacao = 'entrou';
    else if (tentativa.falhou) situacao = 'falhou';
    somar(total, situacao);
    if (porMetodo[tentativa.metodo]) somar(porMetodo[tentativa.metodo], situacao);
    if (porPlataforma[tentativa.plataforma]) somar(porPlataforma[tentativa.plataforma], situacao);
    if (!porVersao.has(tentativa.versao)) porVersao.set(tentativa.versao, { versao: tentativa.versao, ...contadorVazio() });
    somar(porVersao.get(tentativa.versao), situacao);
    if (tentativa.aparelho) {
      aparelhos.add(tentativa.aparelho);
      if (situacao === 'entrou') aparelhosQueEntraram.add(tentativa.aparelho);
      if (situacao === 'falhou') aparelhosQueFalharam.add(tentativa.aparelho);
    }
  });

  const listaDeErros = [...erros.values()]
    .sort((a, b) => b.vezes - a.vezes || a.erro.localeCompare(b.erro));

  return {
    version: RESUMO_VERSION,
    dia,
    registros: registros.length,
    ...total,
    // Falha do proprio usuario (fechou a janela do Google ou da Apple): fica dentro de
    // "falhas" e aparece tambem a parte.
    canceladas: listaDeErros.filter((item) => erroCancelado(item.erro)).reduce((soma, item) => soma + item.vezes, 0),
    aparelhos: aparelhos.size,
    // Aparelho com tentativa que falhou e nenhuma que entrou no dia: "quem nao conseguiu".
    aparelhosSemEntrar: [...aparelhosQueFalharam].filter((aparelho) => !aparelhosQueEntraram.has(aparelho)).length,
    porMetodo,
    porPlataforma,
    porVersao: [...porVersao.values()].sort((a, b) => b.tentativas - a.tentativas || String(a.versao).localeCompare(String(b.versao))),
    porEtapa,
    erros: listaDeErros,
  };
}

// Registros de cada loja. O de uma loja vai para ela; o que veio so com a marca vai para
// a loja da marca quando a marca tem uma loja so na lista da rotina (com duas ou mais, nao
// da para escolher, e ele fica so no resumo de todas).
function registrosPorLoja({ registros = [], lojas = [] }) {
  const lojasDaMarca = new Map();
  lojas.forEach(({ id, whitelabelId }) => {
    if (!whitelabelId) return;
    if (!lojasDaMarca.has(whitelabelId)) lojasDaMarca.set(whitelabelId, []);
    lojasDaMarca.get(whitelabelId).push(id);
  });
  const porLoja = new Map(lojas.map(({ id }) => [id, []]));
  registros.forEach((registro) => {
    let destino = registro?.loja || null;
    if (!destino) {
      const daMarca = lojasDaMarca.get(registro?.marca) || [];
      destino = daMarca.length === 1 ? daMarca[0] : null;
    }
    if (destino && porLoja.has(destino)) porLoja.get(destino).push(registro);
  });
  return porLoja;
}

// Topo (uma linha de contagem por dia, ate um ano) e o documento do dia (90 dias), no
// molde de Stats/buscasResumo. `referencia` e o documento do topo.
async function escreverResumoDeLogin({
  referencia,
  resumo,
  atualizadoEm,
  diasNoTopo = DIAS_NO_TOPO,
  diasComDocumento = DIAS_COM_DOCUMENTO,
}) {
  const doDia = (dia) => referencia.collection(DIAS_SUBCOLECAO).doc(dia);
  await doDia(resumo.dia).set({ ...resumo, atualizadoEm });

  const atual = await referencia.get();
  const anteriores = (atual.exists ? atual.get('dias') : null) || [];
  const linha = {
    dia: resumo.dia,
    tentativas: resumo.tentativas,
    entradas: resumo.entradas,
    falhas: resumo.falhas,
    semResultado: resumo.semResultado,
    canceladas: resumo.canceladas,
    aparelhosSemEntrar: resumo.aparelhosSemEntrar,
    documento: true,
  };
  const limiteDoTopo = diaMenos(resumo.dia, diasNoTopo);
  const dias = [...anteriores.filter((entrada) => entrada?.dia !== resumo.dia), linha]
    .filter((entrada) => entrada?.dia && String(entrada.dia) >= limiteDoTopo)
    .sort((a, b) => String(a.dia).localeCompare(String(b.dia)))
    .slice(-diasNoTopo);

  const corte = diaMenos(resumo.dia, diasComDocumento);
  for (const entrada of dias) {
    if (entrada.documento === false || String(entrada.dia) >= corte) continue;
    await doDia(entrada.dia).delete();
    entrada.documento = false;
  }

  await referencia.set({
    version: RESUMO_VERSION,
    atualizadoEm,
    primeiroDia: dias[0]?.dia || resumo.dia,
    ultimoDia: dias.at(-1)?.dia || resumo.dia,
    dias,
  });

  const mantidos = new Set(dias.map((entrada) => entrada.dia));
  for (const entrada of anteriores) {
    if (entrada?.dia && !mantidos.has(entrada.dia)) await doDia(entrada.dia).delete();
  }
  return { dias: dias.length };
}

async function carregarRegistrosDoDia({ db, dia }) {
  const { inicio, fim } = limitesDoDia(dia);
  const snapshot = await db.collection(COLECAO)
    .where('em', '>=', inicio)
    .where('em', '<', fim)
    .get();
  return snapshot.docs.map((documento) => documento.data());
}

// Apaga em lotes o que passou de 90 dias, mesmo que a politica de TTL do Firestore ainda
// nao esteja ligada; e as janelas de limite de horas que ja passaram.
async function limparAntigos({
  db, agora = new Date(), lote = 300, maximo = 5000,
}) {
  const antesDe = new Date(agora.getTime() - DIAS_DE_RETENCAO * 24 * 60 * 60 * 1000);
  let removidos = 0;
  const apagar = async (consulta) => {
    let feitos = 0;
    while (feitos < maximo) {
      const snapshot = await consulta.limit(lote).get();
      if (snapshot.empty) break;
      for (const documento of snapshot.docs) {
        await documento.ref.delete();
        feitos += 1;
      }
      if (snapshot.size < lote) break;
    }
    return feitos;
  };
  removidos += await apagar(db.collection(COLECAO).where('em', '<', antesDe));
  const limites = await apagar(db.collection(COLECAO_DO_LIMITE).where('expiraEm', '<', agora));
  return { removidos, limitesRemovidos: limites };
}

// Dia anterior: resumo de todas as lojas (LoginResumo/todas) e de cada loja da lista da
// rotina (estabelecimentos/{loja}/Stats/loginResumo); depois, a limpeza.
async function rodarResumoDeLogin({
  db,
  lojas = [],
  agora = new Date(),
  atualizadoEm,
  limpar = true,
}) {
  const dia = diaAnterior(agora);
  const registros = await carregarRegistrosDoDia({ db, dia });

  const todas = resumirTentativas({ registros, dia });
  await escreverResumoDeLogin({
    referencia: db.collection(RESUMO_DE_TODAS_COLECAO).doc(RESUMO_DE_TODAS),
    resumo: todas,
    atualizadoEm,
  });

  const relatorio = [];
  const porLoja = registrosPorLoja({ registros, lojas });
  for (const { id } of lojas) {
    try {
      const resumo = resumirTentativas({ registros: porLoja.get(id) || [], dia });
      await escreverResumoDeLogin({
        referencia: db.collection('estabelecimentos').doc(id).collection('Stats').doc(RESUMO_DOCUMENT),
        resumo,
        atualizadoEm,
      });
      relatorio.push({ establishmentId: id, tentativas: resumo.tentativas, falhas: resumo.falhas });
    } catch (error) {
      relatorio.push({ establishmentId: id, status: 'falhou', motivo: error?.message || String(error) });
    }
  }

  let limpeza = null;
  if (limpar) {
    try {
      limpeza = await limparAntigos({ db, agora });
    } catch (error) {
      limpeza = { falha: error?.message || String(error) };
    }
  }

  return {
    dia,
    registros: registros.length,
    tentativas: todas.tentativas,
    entradas: todas.entradas,
    falhas: todas.falhas,
    lojas: relatorio,
    limpeza,
  };
}

module.exports = {
  COLECAO,
  COLECAO_DO_LIMITE,
  DIAS_DE_RETENCAO,
  ETAPAS,
  MARCA_DO_APP_GERAL,
  MAX_REGISTROS_POR_APARELHO_POR_HORA,
  MAX_REGISTROS_POR_CHAMADA,
  METODOS,
  PLATAFORMAS,
  RESUMO_DE_TODAS,
  RESUMO_DE_TODAS_COLECAO,
  RESUMO_DOCUMENT,
  RegistroInvalido,
  cabemNoLimite,
  carregarRegistrosDoDia,
  chaveDoLimite,
  codigoDeErro,
  diaDe,
  escreverResumoDeLogin,
  gravarTentativas,
  horaDoLimite,
  limparAntigos,
  listasFechadas,
  registrosPorLoja,
  resumirTentativas,
  resumoDoAparelho,
  rodarResumoDeLogin,
  validarChamada,
  validarRegistro,
};
