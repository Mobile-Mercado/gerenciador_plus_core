// Instalacoes do app de cada loja, em estabelecimentos/{loja}/Stats/instalacoesApp (rodada Financas,
// 16/10/2026), para o card "Instalacoes do app" da tela Financas.
//
// Documento:
//   dias { "AAAA-MM-DD": { android: { baixaram, desinstalaram }, ios: { baixaram, desinstalaram, instalaram } } }
//   instaladosAgora { android, ios }   android: "Installs on active devices" do ultimo dia com dado;
//                                      ios: soma das instalacoes menos soma das remocoes desde o inicio
//   totalInstalacoes { android, ios }  android: "Total User Installs" do ultimo dia com dado;
//                                      ios: soma dos primeiros downloads desde o inicio
//   dadosAte { android, ios }          ultimo dia com dado de cada loja de apps
//   atualizadoEm
// `ios.instalaram` (instalacoes do dia) existe so para refazer o instaladosAgora do iPhone quando a
// rotina recalcula os dois ultimos meses; a tela nao le.
//
// Android: CSVs mensais da Google Play no bucket de relatorios da conta
// (gs://{bucket}/stats/installs/installs_{pacote}_{AAAAMM}_{dimensao}.csv), em UTF-16. Usa um arquivo
// de dimensao so: overview se existir; se nao, country, somando todos os paises do dia.
// iPhone: relatorios de analise do App Store Connect (Analytics Reports API): "App Downloads Standard"
// (primeiros downloads) e "App Store Installation and Deletion Standard" (instalacoes e remocoes).
//
// Funcoes puras e leitores com as dependencias por parametro (bucket, fetch, gunzip): sem
// firebase-admin nem firebase-functions aqui.
const crypto = require('node:crypto');

const INSTALACOES_DOCUMENT = 'instalacoesApp';

// Pacote Android e bundle iOS de cada app, pelo whitelabelId da loja (estabelecimentos/{loja}.whitelabelId).
// Fonte: mobile_whitelabels/flavorizr.yaml (applicationId e bundleId de cada flavor ativo) e
// ios/Runner.xcodeproj/project.pbxproj (PRODUCT_BUNDLE_IDENTIFIER). Um lugar so no Core.
const APPS_POR_WHITELABEL = Object.freeze({
  'br.com.zero.grau': Object.freeze({ nome: 'Zero Grau', android: 'br.com.zero.grau', ios: 'br.com.zero.grau' }),
  'br.com.uaumart': Object.freeze({ nome: 'UAU MART', android: 'br.com.uaumart', ios: 'br.com.uaumart' }),
  'br.com.gsatacarejo': Object.freeze({ nome: 'G&S Atacarejo', android: 'br.com.gsatacarejo', ios: 'br.com.gsatacarejo' }),
});

function appsDaLoja(whitelabelId) {
  return APPS_POR_WHITELABEL[String(whitelabelId || '').trim().toLowerCase()] || null;
}

// ---- Google Play ----

const DIMENSOES_DA_PLAY = ['overview', 'country'];
const COLUNAS_DA_PLAY = Object.freeze({
  data: 'Date',
  baixaram: 'Daily User Installs',
  desinstalaram: 'Daily User Uninstalls',
  // Nos arquivos de 2026 a coluna se chama "Active Device Installs" (conferido em 16/10/2026 no overview
  // de outubro da Zero Grau); "Installs on active devices" fica como nome alternativo.
  instaladosAgora: 'Active Device Installs',
  instaladosAgoraAlternativo: 'Installs on active devices',
  total: 'Total User Installs',
});

function arquivoDaPlay(pacote, mes, dimensao) {
  return `stats/installs/installs_${pacote}_${String(mes).replace('-', '')}_${dimensao}.csv`;
}

// Texto do arquivo: UTF-16 (com BOM FF FE ou FE FF, ou sem BOM com bytes nulos alternados) ou UTF-8.
function decodificarTexto(buffer) {
  const bytes = Buffer.from(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { codificacao: 'utf-16le', texto: bytes.subarray(2).toString('utf16le') };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const trocado = Buffer.from(bytes.subarray(2));
    trocado.swap16();
    return { codificacao: 'utf-16be', texto: trocado.toString('utf16le') };
  }
  if (bytes.length > 3 && bytes[1] === 0 && bytes[3] === 0) return { codificacao: 'utf-16le', texto: bytes.toString('utf16le') };
  const texto = bytes.toString('utf8');
  return { codificacao: 'utf-8', texto: texto.charCodeAt(0) === 0xfeff ? texto.slice(1) : texto };
}

// Linhas de um CSV (virgula ou tab), com aspas. Devolve objetos pela primeira linha (cabecalho).
function lerTabela(texto, separador = ',') {
  const linhas = [];
  let campo = '';
  let linha = [];
  let aspas = false;
  for (let i = 0; i < texto.length; i += 1) {
    const c = texto[i];
    if (aspas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i += 1; } else if (c === '"') aspas = false; else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === separador) { linha.push(campo); campo = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i += 1;
      linha.push(campo);
      if (linha.some((valor) => valor !== '')) linhas.push(linha);
      linha = [];
      campo = '';
    } else campo += c;
  }
  linha.push(campo);
  if (linha.some((valor) => valor !== '')) linhas.push(linha);
  const [cabecalho = [], ...corpo] = linhas;
  const nomes = cabecalho.map((nome) => nome.trim());
  return corpo.map((valores) => Object.fromEntries(nomes.map((nome, i) => [nome, (valores[i] ?? '').trim()])));
}

const numero = (valor) => {
  const convertido = Number(String(valor ?? '').replace(/,/g, ''));
  return Number.isFinite(convertido) ? convertido : 0;
};

// Data "AAAA-MM-DD" a partir de "AAAA-MM-DD" ou "MM/DD/AAAA"; outra coisa -> null.
function dataDaLinha(valor) {
  const texto = String(valor || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(texto)) return texto;
  const americana = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(texto);
  if (americana) return `${americana[3]}-${americana[1].padStart(2, '0')}-${americana[2].padStart(2, '0')}`;
  return null;
}

// Soma por dia as linhas de um ou mais CSVs da Play (country: todos os paises do dia). No ultimo dia
// com dado, "Installs on active devices" = instalados agora e "Total User Installs" = total.
function somarCsvsDaPlay(tabelas) {
  const dias = {};
  const ultimos = {};
  tabelas.flat().forEach((linha) => {
    const dia = dataDaLinha(linha[COLUNAS_DA_PLAY.data]);
    if (!dia) return;
    const atual = dias[dia] || { baixaram: 0, desinstalaram: 0 };
    atual.baixaram += numero(linha[COLUNAS_DA_PLAY.baixaram]);
    atual.desinstalaram += numero(linha[COLUNAS_DA_PLAY.desinstalaram]);
    dias[dia] = atual;
    const fechamento = ultimos[dia] || { instaladosAgora: 0, total: 0 };
    fechamento.instaladosAgora += numero(linha[COLUNAS_DA_PLAY.instaladosAgora] ?? linha[COLUNAS_DA_PLAY.instaladosAgoraAlternativo]);
    fechamento.total += numero(linha[COLUNAS_DA_PLAY.total]);
    ultimos[dia] = fechamento;
  });
  const dadosAte = Object.keys(dias).sort().pop() || null;
  return {
    dias,
    dadosAte,
    instaladosAgora: dadosAte ? ultimos[dadosAte].instaladosAgora : null,
    totalInstalacoes: dadosAte ? ultimos[dadosAte].total : null,
  };
}

// Le os CSVs de um pacote nos meses dados ("AAAA-MM"): overview se existir; se nao, country.
async function lerMesesDaPlay({ bucket, pacote, meses }) {
  const tabelas = [];
  const usados = [];
  const codificacoes = new Set();
  for (const mes of meses) {
    for (const dimensao of DIMENSOES_DA_PLAY) {
      const arquivo = bucket.file(arquivoDaPlay(pacote, mes, dimensao));
      // eslint-disable-next-line no-await-in-loop
      const [existe] = await arquivo.exists();
      if (!existe) continue;
      // eslint-disable-next-line no-await-in-loop
      const [conteudo] = await arquivo.download();
      const { codificacao, texto } = decodificarTexto(conteudo);
      codificacoes.add(codificacao);
      tabelas.push(lerTabela(texto, ','));
      usados.push({ mes, dimensao });
      break;
    }
  }
  return { ...somarCsvsDaPlay(tabelas), arquivos: usados, codificacoes: [...codificacoes] };
}

// Meses ("AAAA-MM") com arquivo de instalacoes de um pacote no bucket.
async function mesesNoBucket({ bucket, pacote }) {
  const [arquivos] = await bucket.getFiles({ prefix: `stats/installs/installs_${pacote}_` });
  const meses = new Set();
  arquivos.forEach((arquivo) => {
    const achado = /_(\d{4})(\d{2})_[a-z_]+\.csv$/.exec(arquivo.name);
    if (achado) meses.add(`${achado[1]}-${achado[2]}`);
  });
  return [...meses].sort();
}

// ---- App Store Connect ----

const API_DA_APPLE = 'https://api.appstoreconnect.apple.com';
const RELATORIOS_DA_APPLE = Object.freeze({
  downloads: 'App Downloads Standard',
  instalacoes: 'App Store Installation and Deletion Standard',
});
// Colunas e valores dos relatorios (TSV). Conferir nos primeiros arquivos baixados.
const COLUNAS_DA_APPLE = Object.freeze({
  data: 'Date',
  tipoDeDownload: 'Download Type',
  evento: 'Event',
  contagem: 'Counts',
});
const VALORES_DA_APPLE = Object.freeze({
  primeiroDownload: 'First-time download',
  instalacao: 'Install',
  remocao: 'Delete',
});

const base64url = (valor) => Buffer.from(valor).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

// Token da API (ES256, 20 minutos). A chave .p8 vem por parametro; nunca vai para log.
function tokenDaApple({ chaveP8, issuerId, keyId, agora = Date.now() }) {
  const cabecalho = base64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const segundos = Math.floor(agora / 1000);
  const corpo = base64url(JSON.stringify({ iss: issuerId, iat: segundos, exp: segundos + 19 * 60, aud: 'appstoreconnect-v1' }));
  const assinatura = crypto.sign('sha256', Buffer.from(`${cabecalho}.${corpo}`), { key: chaveP8, dsaEncoding: 'ieee-p1363' });
  return `${cabecalho}.${corpo}.${base64url(assinatura)}`;
}

function clienteDaApple({ chaveP8, issuerId, keyId, fetch: buscar = fetch }) {
  let token = null;
  let validoAte = 0;
  const cabecalhos = () => {
    if (!token || Date.now() > validoAte) {
      token = tokenDaApple({ chaveP8, issuerId, keyId });
      validoAte = Date.now() + 15 * 60 * 1000;
    }
    return { Authorization: `Bearer ${token}` };
  };
  const pedir = async (caminho, { method = 'GET', corpo } = {}) => {
    const resposta = await buscar(caminho.startsWith('http') ? caminho : `${API_DA_APPLE}${caminho}`, {
      method,
      headers: { ...cabecalhos(), ...(corpo ? { 'Content-Type': 'application/json' } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    if (!resposta.ok) {
      const erro = new Error(`App Store Connect respondeu ${resposta.status} em ${caminho.split('?')[0]}`);
      erro.status = resposta.status;
      throw erro;
    }
    return resposta.json();
  };
  // Todas as paginas de uma lista (links.next).
  const todos = async (caminho) => {
    const itens = [];
    let proximo = caminho;
    while (proximo) {
      // eslint-disable-next-line no-await-in-loop
      const pagina = await pedir(proximo);
      itens.push(...(pagina.data || []));
      proximo = pagina.links?.next || null;
    }
    return itens;
  };
  return { pedir, todos };
}

// Linhas do relatorio de um app ("App Downloads Standard" ou o de instalacoes), de todos os pedidos
// (ONGOING e ONE_TIME_SNAPSHOT), por instancia diaria. desde: "AAAA-MM-DD" (processingDate), opcional.
// O mesmo dia em mais de uma instancia conta uma vez: fica a instancia processada por ultimo.
async function linhasDaApple({ cliente, appId, relatorio, desde = null, baixar, gunzip }) {
  const pedidos = await cliente.todos(`/v1/apps/${appId}/analyticsReportRequests`);
  const instancias = [];
  for (const pedido of pedidos) {
    // eslint-disable-next-line no-await-in-loop
    const relatorios = await cliente.todos(`/v1/analyticsReportRequests/${pedido.id}/reports?filter[name]=${encodeURIComponent(relatorio)}`);
    for (const item of relatorios) {
      // eslint-disable-next-line no-await-in-loop
      const daqui = await cliente.todos(`/v1/analyticsReports/${item.id}/instances?filter[granularity]=DAILY`);
      instancias.push(...daqui.filter((instancia) => !desde || String(instancia.attributes?.processingDate || '') >= desde));
    }
  }
  instancias.sort((a, b) => String(b.attributes?.processingDate || '').localeCompare(String(a.attributes?.processingDate || '')));
  const donoDoDia = new Map();
  const linhas = [];
  for (const instancia of instancias) {
    // eslint-disable-next-line no-await-in-loop
    const segmentos = await cliente.todos(`/v1/analyticsReportInstances/${instancia.id}/segments`);
    const daInstancia = [];
    for (const segmento of segmentos) {
      // eslint-disable-next-line no-await-in-loop
      const conteudo = await baixar(segmento.attributes.url);
      daInstancia.push(...lerTabela(gunzip(conteudo).toString('utf8'), '\t'));
    }
    daInstancia.forEach((linha) => {
      const dia = dataDaLinha(linha[COLUNAS_DA_APPLE.data]);
      if (!dia) return;
      if (!donoDoDia.has(dia)) donoDoDia.set(dia, instancia.id);
      if (donoDoDia.get(dia) === instancia.id) linhas.push(linha);
    });
  }
  return { linhas, instancias: instancias.length };
}

// Soma por dia: baixaram = primeiros downloads; desinstalaram = remocoes; instalaram = instalacoes.
function somarRelatoriosDaApple({ downloads = [], instalacoes = [] }) {
  const dias = {};
  const doDia = (dia) => {
    dias[dia] = dias[dia] || { baixaram: 0, desinstalaram: 0, instalaram: 0 };
    return dias[dia];
  };
  downloads.forEach((linha) => {
    const dia = dataDaLinha(linha[COLUNAS_DA_APPLE.data]);
    if (!dia || linha[COLUNAS_DA_APPLE.tipoDeDownload] !== VALORES_DA_APPLE.primeiroDownload) return;
    doDia(dia).baixaram += numero(linha[COLUNAS_DA_APPLE.contagem]);
  });
  instalacoes.forEach((linha) => {
    const dia = dataDaLinha(linha[COLUNAS_DA_APPLE.data]);
    if (!dia) return;
    const evento = linha[COLUNAS_DA_APPLE.evento];
    if (evento === VALORES_DA_APPLE.remocao) doDia(dia).desinstalaram += numero(linha[COLUNAS_DA_APPLE.contagem]);
    else if (evento === VALORES_DA_APPLE.instalacao) doDia(dia).instalaram += numero(linha[COLUNAS_DA_APPLE.contagem]);
  });
  return { dias, dadosAte: Object.keys(dias).sort().pop() || null };
}

// ---- Documento ----

// Junta o documento atual com o que foi lido, trocando inteiros os meses recalculados de cada loja de
// apps (os outros dias ficam). android: resultado de somarCsvsDaPlay (ou null); ios: de
// somarRelatoriosDaApple (ou null). mesesRecalculados: "AAAA-MM" lidos agora (vazio = historico todo).
function montarDocumento({ atual = null, android = null, ios = null, mesesRecalculados = [] }) {
  const dias = {};
  const recalculado = (dia) => !mesesRecalculados.length || mesesRecalculados.includes(dia.slice(0, 7));
  Object.entries(atual?.dias || {}).forEach(([dia, entrada]) => {
    const mantido = {};
    if (entrada?.android && !(android && recalculado(dia))) mantido.android = entrada.android;
    if (entrada?.ios && !(ios && recalculado(dia))) mantido.ios = entrada.ios;
    if (Object.keys(mantido).length) dias[dia] = mantido;
  });
  Object.entries(android?.dias || {}).forEach(([dia, valores]) => {
    dias[dia] = { ...(dias[dia] || {}), android: { baixaram: valores.baixaram, desinstalaram: valores.desinstalaram } };
  });
  Object.entries(ios?.dias || {}).forEach(([dia, valores]) => {
    dias[dia] = { ...(dias[dia] || {}), ios: { baixaram: valores.baixaram, desinstalaram: valores.desinstalaram, instalaram: valores.instalaram } };
  });
  const diasDoIos = Object.values(dias).map((entrada) => entrada.ios).filter(Boolean);
  const somaIos = (campo) => diasDoIos.reduce((soma, valores) => soma + numero(valores[campo]), 0);
  const ultimoDia = (plataforma) => Object.keys(dias).filter((dia) => dias[dia][plataforma]).sort().pop() || null;
  const temIos = diasDoIos.length > 0;
  return {
    dias,
    instaladosAgora: {
      android: android?.dadosAte ? android.instaladosAgora : numero(atual?.instaladosAgora?.android),
      ios: temIos ? somaIos('instalaram') - somaIos('desinstalaram') : 0,
    },
    totalInstalacoes: {
      android: android?.dadosAte ? android.totalInstalacoes : numero(atual?.totalInstalacoes?.android),
      ios: temIos ? somaIos('baixaram') : 0,
    },
    dadosAte: { android: ultimoDia('android'), ios: ultimoDia('ios') },
  };
}

// Os dois ultimos meses ("AAAA-MM") no fuso de Sao Paulo.
function doisUltimosMeses(agora = new Date()) {
  const partes = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' })
    .formatToParts(agora)
    .forEach(({ type, value }) => { partes[type] = value; });
  const ano = Number(partes.year);
  const mes = Number(partes.month);
  return [mes === 1 ? `${ano - 1}-12` : `${ano}-${String(mes - 1).padStart(2, '0')}`, `${ano}-${partes.month}`];
}

// Id do app no App Store Connect pelo bundle.
async function appDaApple(cliente, bundle) {
  const resposta = await cliente.pedir(`/v1/apps?filter[bundleId]=${encodeURIComponent(bundle)}`);
  return resposta.data?.[0]?.id || null;
}

// Uma loja: le Android (bucket) e iPhone (App Store Connect) nos meses dados (null = historico todo),
// junta com o documento atual e grava (se `gravar`). apple: { cliente, baixar, gunzip } ou null.
async function atualizarInstalacoes({
  db, FieldValue, lojaId, apps, bucket = null, apple = null, meses = null, gravar = true,
}) {
  const referencia = db.collection('estabelecimentos').doc(String(lojaId)).collection('Stats').doc(INSTALACOES_DOCUMENT);
  const relatorio = { lojaId, android: null, ios: null };
  let android = null;
  if (bucket && apps.android) {
    const mesesDaPlay = meses || await mesesNoBucket({ bucket, pacote: apps.android });
    android = await lerMesesDaPlay({ bucket, pacote: apps.android, meses: mesesDaPlay });
    relatorio.android = { meses: mesesDaPlay, arquivos: android.arquivos, codificacoes: android.codificacoes, dadosAte: android.dadosAte };
    if (!android.dadosAte) android = null;
  }
  let ios = null;
  if (apple && apps.ios) {
    const appId = await appDaApple(apple.cliente, apps.ios);
    if (appId) {
      const desde = meses ? `${[...meses].sort()[0]}-01` : null;
      const ler = (nome) => linhasDaApple({ cliente: apple.cliente, appId, relatorio: nome, desde, baixar: apple.baixar, gunzip: apple.gunzip });
      const downloads = await ler(RELATORIOS_DA_APPLE.downloads);
      const instalacoes = await ler(RELATORIOS_DA_APPLE.instalacoes);
      ios = somarRelatoriosDaApple({ downloads: downloads.linhas, instalacoes: instalacoes.linhas });
      relatorio.ios = { appId, instancias: downloads.instancias + instalacoes.instancias, dadosAte: ios.dadosAte };
      if (!ios.dadosAte) ios = null;
    } else {
      relatorio.ios = { appId: null };
    }
  }
  const atual = await referencia.get();
  const documento = montarDocumento({
    atual: atual.exists ? atual.data() : null,
    android,
    ios,
    mesesRecalculados: meses || [],
  });
  if (gravar && (android || ios)) await referencia.set({ ...documento, atualizadoEm: FieldValue.serverTimestamp() });
  return { ...relatorio, documento };
}

module.exports = {
  APPS_POR_WHITELABEL,
  COLUNAS_DA_APPLE,
  COLUNAS_DA_PLAY,
  INSTALACOES_DOCUMENT,
  RELATORIOS_DA_APPLE,
  VALORES_DA_APPLE,
  appDaApple,
  appsDaLoja,
  arquivoDaPlay,
  atualizarInstalacoes,
  clienteDaApple,
  dataDaLinha,
  decodificarTexto,
  doisUltimosMeses,
  lerMesesDaPlay,
  lerTabela,
  linhasDaApple,
  mesesNoBucket,
  montarDocumento,
  somarCsvsDaPlay,
  somarRelatoriosDaApple,
  tokenDaApple,
};
