const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {
  APPS_POR_WHITELABEL, appsDaLoja, arquivoDaPlay, atualizarInstalacoes, atualizarTodasAsLojas, decodificarTexto, doisUltimosMeses, lojasComApp,
  lerMesesDaPlay, lerTabela, linhasDaApple, montarDocumento, somarCsvsDaPlay, somarRelatoriosDaApple, tokenDaApple,
} = require('./instalacoesApp');

const utf16 = (texto) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(texto, 'utf16le')]);
// Cabecalho real (overview de 2026-10 da Zero Grau, conferido em 16/10/2026), com Country como no arquivo country.
const CABECALHO = 'Date,Package name,Country,Daily Device Installs,Daily Device Uninstalls,Daily Device Upgrades,Total User Installs,Daily User Installs,Daily User Uninstalls,Active Device Installs,Install events,Update events,Uninstall events';
const linhaDaPlay = (data, pais, { total, baixaram, desinstalaram, ativos }) => `${data},br.com.zero.grau,${pais},0,0,0,${total},${baixaram},${desinstalaram},${ativos},0,0,0`;

test('mapa de apps num lugar so: pacote Android e bundle iOS pelo whitelabelId da loja', () => {
  assert.deepEqual(Object.keys(APPS_POR_WHITELABEL), ['br.com.zero.grau', 'br.com.uaumart', 'br.com.gsatacarejo']);
  assert.deepEqual(appsDaLoja('br.com.zero.grau'), { nome: 'Zero Grau', android: 'br.com.zero.grau', ios: 'br.com.zero.grau' });
  assert.equal(appsDaLoja('br.com.zero.grau-teste'), null);
  assert.equal(appsDaLoja(undefined), null);
  assert.equal(arquivoDaPlay('br.com.zero.grau', '2026-10', 'country'), 'stats/installs/installs_br.com.zero.grau_202610_country.csv');
});

test('CSV da Play em UTF-16: soma os paises do dia; no ultimo dia, instalados agora (Total User Installs fica fora)', () => {
  const csv = [
    CABECALHO,
    linhaDaPlay('2026-10-01', 'BR', { total: 100, baixaram: 3, desinstalaram: 1, ativos: 60 }),
    linhaDaPlay('2026-10-01', 'PT', { total: 5, baixaram: 1, desinstalaram: 0, ativos: 2 }),
    linhaDaPlay('2026-10-02', 'BR', { total: 102, baixaram: 2, desinstalaram: 1, ativos: 61 }),
    linhaDaPlay('2026-10-02', 'PT', { total: 5, baixaram: 0, desinstalaram: 0, ativos: 2 }),
  ].join('\r\n');
  const { codificacao, texto } = decodificarTexto(utf16(csv));
  assert.equal(codificacao, 'utf-16le');
  const soma = somarCsvsDaPlay([lerTabela(texto)]);
  assert.deepEqual(soma.dias, { '2026-10-01': { baixaram: 4, desinstalaram: 1 }, '2026-10-02': { baixaram: 2, desinstalaram: 1 } });
  assert.equal(soma.dadosAte, '2026-10-02');
  assert.equal(soma.instaladosAgora, 63);
  assert.equal('totalInstalacoes' in soma, false);
  assert.equal(decodificarTexto(Buffer.from('a,b\n1,2')).codificacao, 'utf-8');
  assert.deepEqual(lerTabela('"a, b",c\n"x ""y""",2\n'), [{ 'a, b': 'x "y"', c: '2' }]);
  // Nome antigo da coluna de instalados agora, se aparecer.
  assert.equal(somarCsvsDaPlay([[{ Date: '2026-01-02', 'Installs on active devices': '7', 'Total User Installs': '9' }]]).instaladosAgora, 7);
});

function bucketFalso(arquivos) {
  return {
    lidos: [],
    file(nome) {
      const dono = this;
      return {
        exists: async () => [Object.hasOwn(arquivos, nome)],
        download: async () => { dono.lidos.push(nome); return [arquivos[nome]]; },
      };
    },
    getFiles: async ({ prefix }) => [Object.keys(arquivos).filter((nome) => nome.startsWith(prefix)).map((name) => ({ name }))],
  };
}

test('Play: overview quando existe; se nao, country; um arquivo de dimensao so por mes', async () => {
  const pacote = 'br.com.zero.grau';
  const bucket = bucketFalso({
    [arquivoDaPlay(pacote, '2026-09', 'overview')]: utf16(`${CABECALHO.replace(',Country', '')}\n2026-09-30,${pacote},0,0,0,90,5,1,55,0,0,0`),
    [arquivoDaPlay(pacote, '2026-09', 'country')]: utf16(`${CABECALHO}\n${linhaDaPlay('2026-09-30', 'BR', { total: 1, baixaram: 99, desinstalaram: 0, ativos: 1 })}`),
    [arquivoDaPlay(pacote, '2026-10', 'country')]: utf16(`${CABECALHO}\n${linhaDaPlay('2026-10-02', 'BR', { total: 92, baixaram: 2, desinstalaram: 0, ativos: 56 })}`),
  });
  const lido = await lerMesesDaPlay({ bucket, pacote, meses: ['2026-09', '2026-10'] });
  assert.deepEqual(lido.arquivos, [{ mes: '2026-09', dimensao: 'overview' }, { mes: '2026-10', dimensao: 'country' }]);
  assert.deepEqual(lido.dias, { '2026-09-30': { baixaram: 5, desinstalaram: 1 }, '2026-10-02': { baixaram: 2, desinstalaram: 0 } });
  assert.equal(lido.instaladosAgora, 56);
  assert.deepEqual(lido.codificacoes, ['utf-16le']);
  assert.equal(bucket.lidos.length, 2);
});

test('Apple: primeiros downloads, remocoes e instalacoes por dia', () => {
  const downloads = lerTabela([
    'Date\tApp Name\tApp Apple Identifier\tDownload Type\tCounts',
    '2026-10-01\tZero Grau\t1\tFirst-time download\t3',
    '2026-10-01\tZero Grau\t1\tRedownload\t7',
    '2026-10-02\tZero Grau\t1\tFirst-time download\t1',
  ].join('\n'), '\t');
  const instalacoes = lerTabela([
    'Date\tApp Name\tApp Apple Identifier\tEvent\tCounts',
    '2026-10-01\tZero Grau\t1\tInstall\t9',
    '2026-10-01\tZero Grau\t1\tDelete\t2',
    '2026-10-03\tZero Grau\t1\tDelete\t1',
  ].join('\n'), '\t');
  const soma = somarRelatoriosDaApple({ downloads, instalacoes });
  assert.deepEqual(soma.dias, {
    '2026-10-01': { baixaram: 3, desinstalaram: 2, instalaram: 9 },
    '2026-10-02': { baixaram: 1, desinstalaram: 0, instalaram: 0 },
    '2026-10-03': { baixaram: 0, desinstalaram: 1, instalaram: 0 },
  });
  assert.equal(soma.dadosAte, '2026-10-03');
});

test('Apple: o mesmo dia em duas instancias (historico e diario) conta uma vez', async () => {
  const tsv = (linhas) => zlib.gzipSync(Buffer.from(['Date\tDownload Type\tCounts', ...linhas].join('\n')));
  const segmentos = {
    'inst-historico': tsv(['2026-09-30\tFirst-time download\t5', '2026-10-01\tFirst-time download\t4']),
    'inst-diario': tsv(['2026-10-01\tFirst-time download\t4']),
  };
  const respostas = {
    '/v1/apps/APP/analyticsReportRequests': [{ id: 'req-1' }, { id: 'req-2' }],
    '/v1/analyticsReportRequests/req-1/reports?filter[name]=App%20Downloads%20Standard': [{ id: 'rep-1' }],
    '/v1/analyticsReportRequests/req-2/reports?filter[name]=App%20Downloads%20Standard': [{ id: 'rep-2' }],
    '/v1/analyticsReports/rep-1/instances?filter[granularity]=DAILY': [{ id: 'inst-historico', attributes: { processingDate: '2026-10-02' } }],
    '/v1/analyticsReports/rep-2/instances?filter[granularity]=DAILY': [{ id: 'inst-diario', attributes: { processingDate: '2026-10-03' } }],
    '/v1/analyticsReportInstances/inst-historico/segments': [{ attributes: { url: 'inst-historico' } }],
    '/v1/analyticsReportInstances/inst-diario/segments': [{ attributes: { url: 'inst-diario' } }],
  };
  const cliente = { todos: async (caminho) => { if (!respostas[caminho]) throw new Error(caminho); return respostas[caminho]; } };
  const lido = await linhasDaApple({
    cliente, appId: 'APP', relatorio: 'App Downloads Standard', baixar: async (url) => segmentos[url], gunzip: zlib.gunzipSync,
  });
  assert.equal(lido.instancias, 2);
  assert.deepEqual(somarRelatoriosDaApple({ downloads: lido.linhas }).dias, {
    '2026-09-30': { baixaram: 5, desinstalaram: 0, instalaram: 0 },
    '2026-10-01': { baixaram: 4, desinstalaram: 0, instalaram: 0 },
  });
});

test('token da Apple: ES256 valido para a chave, sem a chave no token', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const chaveP8 = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const token = tokenDaApple({ chaveP8, issuerId: 'issuer', keyId: 'KEY1', agora: 1_000_000_000 });
  const [cabecalho, corpo, assinatura] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(cabecalho, 'base64url')), { alg: 'ES256', kid: 'KEY1', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(corpo, 'base64url')), { iss: 'issuer', iat: 1_000_000, exp: 1_000_000 + 19 * 60, aud: 'appstoreconnect-v1' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${cabecalho}.${corpo}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(assinatura, 'base64url')));
  assert.ok(!token.includes('PRIVATE'));
});

test('documento: troca so os meses recalculados; iPhone soma desde o inicio; dadosAte por loja de apps', () => {
  const atual = {
    dias: {
      '2026-08-10': { android: { baixaram: 1, desinstalaram: 0 }, ios: { baixaram: 2, desinstalaram: 1, instalaram: 3 } },
      '2026-09-05': { android: { baixaram: 50, desinstalaram: 50 }, ios: { baixaram: 50, desinstalaram: 50, instalaram: 50 } },
    },
    instaladosAgora: { android: 10, ios: 0 },
    totalInstalacoes: { android: 20, ios: 0 },
  };
  const documento = montarDocumento({
    atual,
    android: { dias: { '2026-10-01': { baixaram: 4, desinstalaram: 1 } }, dadosAte: '2026-10-01', instaladosAgora: 63, totalInstalacoes: 107 },
    ios: { dias: { '2026-10-02': { baixaram: 1, desinstalaram: 0, instalaram: 2 } }, dadosAte: '2026-10-02' },
    mesesRecalculados: ['2026-09', '2026-10'],
  });
  assert.deepEqual(documento.dias, {
    '2026-08-10': atual.dias['2026-08-10'],
    '2026-10-01': { android: { baixaram: 4, desinstalaram: 1 } },
    '2026-10-02': { ios: { baixaram: 1, desinstalaram: 0, instalaram: 2 } },
  });
  assert.deepEqual(documento.instaladosAgora, { android: 63, ios: (3 + 2) - (1 + 0) });
  // Totais desde o inicio (19.1 e 19.2): soma dos dias guardados, Android e iPhone.
  assert.deepEqual(documento.totalInstalacoes, { android: 1 + 4, ios: 2 + 1 });
  assert.deepEqual(documento.totalDesinstalacoes, { android: 0 + 1, ios: 1 + 0 });
  assert.deepEqual(documento.dadosAte, { android: '2026-10-01', ios: '2026-10-02' });
  // Sem leitura nova do iPhone (falhou ou sem chave): os dias do iPhone ficam como estavam.
  const soAndroid = montarDocumento({ atual, android: null, ios: null, mesesRecalculados: ['2026-09', '2026-10'] });
  assert.deepEqual(soAndroid.dias, atual.dias);
  assert.equal(soAndroid.instaladosAgora.android, 10);
  assert.deepEqual(doisUltimosMeses(new Date('2026-10-17T07:15:00Z')), ['2026-09', '2026-10']);
  assert.deepEqual(doisUltimosMeses(new Date('2027-01-01T07:15:00Z')), ['2026-12', '2027-01']);
});

test('atualizar uma loja: le, junta com o documento atual e grava; sem gravar, so le', async () => {
  const pacote = 'br.com.zero.grau';
  const bucket = bucketFalso({
    [arquivoDaPlay(pacote, '2026-10', 'country')]: utf16(`${CABECALHO}\n${linhaDaPlay('2026-10-02', 'BR', { total: 92, baixaram: 2, desinstalaram: 0, ativos: 56 })}`),
  });
  const gravados = [];
  const referencia = { get: async () => ({ exists: false }), set: async (dados) => { gravados.push(dados); } };
  const db = { collection: () => ({ doc: () => ({ collection: () => ({ doc: () => referencia }) }) }) };
  const FieldValue = { serverTimestamp: () => 'agora' };
  const apps = appsDaLoja('br.com.zero.grau');
  const simulacao = await atualizarInstalacoes({ db, FieldValue, lojaId: 'l', apps, bucket, meses: ['2026-09', '2026-10'], gravar: false });
  assert.equal(gravados.length, 0);
  assert.equal(simulacao.documento.dadosAte.android, '2026-10-02');
  await atualizarInstalacoes({ db, FieldValue, lojaId: 'l', apps, bucket, meses: ['2026-09', '2026-10'] });
  assert.equal(gravados.length, 1);
  assert.equal(gravados[0].atualizadoEm, 'agora');
  assert.deepEqual(gravados[0].instaladosAgora, { android: 56, ios: 0 });
});

test('montagem compartilhada (rotina e Admin): so lojas com app; inexistente, sem app e falha no relatorio', async () => {
  const pacote = 'br.com.zero.grau';
  const bucket = bucketFalso({
    [arquivoDaPlay(pacote, '2026-10', 'overview')]: utf16(`${CABECALHO.replace(',Country', '')}\n2026-10-02,${pacote},0,0,0,0,2,0,56,0,0,0`),
    [arquivoDaPlay('br.com.gsatacarejo', '2026-10', 'overview')]: utf16(`${CABECALHO.replace(',Country', '')}\n2026-10-02,br.com.gsatacarejo,0,0,0,0,1,0,6,0,0,0`),
  });
  const lojas = {
    zg: { exists: true, whitelabelId: 'br.com.zero.grau', name: 'Zero Grau' },
    teste: { exists: true, whitelabelId: 'br.com.zero.grau-teste', name: 'Teste' },
    gs: { exists: true, whitelabelId: 'br.com.gsatacarejo', name: 'G&S' },
  };
  const gravados = {};
  const db = {
    getAll: async (...referencias) => referencias.map((referencia) => {
      const loja = lojas[referencia.id];
      return { id: referencia.id, exists: Boolean(loja?.exists), get: (campo) => loja?.[campo] };
    }),
    collection: () => ({
      doc: (id) => ({
        id,
        collection: () => ({
          doc: () => ({
            get: async () => ({ exists: false }),
            set: async (dados) => { if (id === 'gs') throw new Error('sem permissao'); gravados[id] = dados; },
          }),
        }),
      }),
    }),
  };
  const terminadas = [];
  const falhas = [];
  const relatorio = await atualizarTodasAsLojas({
    db,
    FieldValue: { serverTimestamp: () => 'agora' },
    lojaIds: ['zg', 'teste', 'sumida', 'gs'],
    bucket,
    apple: null,
    meses: ['2026-09', '2026-10'],
    aoTerminarLoja: async (snapshot, resultado) => { terminadas.push([snapshot.id, resultado.documento.dadosAte.android]); },
    aoFalhar: (lojaId, error) => { falhas.push([lojaId, error.message]); },
  });
  assert.deepEqual(Object.keys(gravados), ['zg']);
  assert.deepEqual(terminadas, [['zg', '2026-10-02']]);
  assert.deepEqual(falhas, [['gs', 'sem permissao']]);
  assert.deepEqual(relatorio.map((linha) => [linha.establishmentId, linha.status || 'ok']), [['sumida', 'inexistente'], ['teste', 'sem-app'], ['zg', 'ok'], ['gs', 'falhou']]);
  const { comApp } = await lojasComApp({ db, lojaIds: ['zg', 'teste', 'gs'] });
  assert.deepEqual(comApp.map((loja) => [loja.id, loja.nome, loja.apps.android]), [['zg', 'Zero Grau', 'br.com.zero.grau'], ['gs', 'G&S', 'br.com.gsatacarejo']]);
});

test('index.js: instalacoesAppNightly semanal, segunda as 04:15 (28.2), com a conta relatorios-lojas, o segredo e os parametros', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  assert.match(index, /exports\.instalacoesAppNightly = onSchedule\(\s+\{\s+schedule: '15 4 \* \* 1',\s+timeZone: 'America\/Sao_Paulo'/);
  assert.ok(index.includes('const report = await atualizarTodasAsLojas({'));
  assert.ok(index.includes("serviceAccount: 'relatorios-lojas@appmobileprod-19505.iam.gserviceaccount.com',"));
  assert.ok(index.includes("const APPLE_RELATORIOS_LEITURA_P8 = defineSecret('APPLE_RELATORIOS_LEITURA_P8');"));
  ['APPLE_ISSUER_ID', 'APPLE_KEY_ID', 'PLAY_REPORTS_BUCKET'].forEach((nome) => assert.ok(index.includes(`const ${nome} = defineString('${nome}');`)));
  assert.ok(index.includes('secrets: [APPLE_RELATORIOS_LEITURA_P8],'));
  assert.ok(index.includes('aoTerminarLoja: async (snapshot, resultado) => {'));
  assert.ok(index.includes("await registrarNoite(snapshot.ref, 'instalacoesAppNightly', {"));
});

// Partes 32.3 e 36.2: pedido automatico dos relatorios da Apple, com a API simulada.
const {
  chamadaDePedidoPermitida, clienteDePedidos, lerSegredoOpcional, pedidoAppleDaLoja, pedirRelatoriosQueFaltam,
} = require('./instalacoesApp');

const chaveDeTeste = () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });

// API da Apple simulada: apps, pedidos por app e criacao de pedido; registra cada chamada.
function appleSimulada({ apps, pedidos, falharAoCriar = [] }) {
  const chamadas = [];
  const criados = [];
  let proximoId = 0;
  const responder = (status, corpo) => ({ ok: status < 400, status, json: async () => corpo });
  const buscar = async (url, opcoes = {}) => {
    const { pathname, searchParams } = new URL(url);
    const metodo = opcoes.method || 'GET';
    chamadas.push(`${metodo} ${pathname}`);
    if (metodo === 'GET' && pathname === '/v1/apps') {
      // Duas paginas, para conferir links.next.
      if (!searchParams.get('cursor')) return responder(200, { data: apps.slice(0, 2), links: { next: 'https://api.appstoreconnect.apple.com/v1/apps?cursor=2' } });
      return responder(200, { data: apps.slice(2), links: {} });
    }
    const doApp = /^\/v1\/apps\/(\d+)\/analyticsReportRequests$/.exec(pathname);
    if (metodo === 'GET' && doApp) return responder(200, { data: pedidos[doApp[1]] || [] });
    if (metodo === 'POST' && pathname === '/v1/analyticsReportRequests') {
      const corpo = JSON.parse(opcoes.body);
      const appId = corpo.data.relationships.app.data.id;
      if (falharAoCriar.includes(appId)) return responder(403, { errors: [{ code: 'FORBIDDEN_ERROR' }] });
      proximoId += 1;
      criados.push([appId, corpo.data.attributes.accessType]);
      return responder(201, { data: { type: 'analyticsReportRequests', id: `pedido-${proximoId}`, attributes: corpo.data.attributes } });
    }
    return responder(404, {});
  };
  return { buscar, chamadas, criados };
}

const APPS = [
  { id: '1', attributes: { name: 'Zero Grau', bundleId: 'br.com.zero.grau' } },
  { id: '2', attributes: { name: 'App Novo', bundleId: 'br.com.novo' } },
  { id: '3', attributes: { name: 'Parado', bundleId: 'br.com.parado' } },
  { id: '4', attributes: { name: 'Recusado', bundleId: 'br.com.recusado' } },
  { id: '5', attributes: { name: 'Depois do erro', bundleId: 'br.com.depois' } },
];
const PEDIDOS = {
  1: [{ id: 'a', attributes: { accessType: 'ONGOING', stoppedDueToInactivity: false } }],
  3: [{ id: 'b', attributes: { accessType: 'ONGOING', stoppedDueToInactivity: true } }],
};

test('32.3: so a lista de apps e os pedidos de relatorio passam pelo cliente de pedido', () => {
  assert.equal(chamadaDePedidoPermitida('https://api.appstoreconnect.apple.com/v1/apps?fields[apps]=name,bundleId&limit=200'), true);
  assert.equal(chamadaDePedidoPermitida('https://api.appstoreconnect.apple.com/v1/apps?cursor=2'), true);
  assert.equal(chamadaDePedidoPermitida('https://api.appstoreconnect.apple.com/v1/apps/6737253032/analyticsReportRequests'), true);
  assert.equal(chamadaDePedidoPermitida('https://api.appstoreconnect.apple.com/v1/analyticsReportRequests', 'POST'), true);
  // Fora da lista: outros enderecos, outros metodos e outro dominio.
  assert.equal(chamadaDePedidoPermitida('https://api.appstoreconnect.apple.com/v1/analyticsReportRequests'), false);
  assert.equal(chamadaDePedidoPermitida('https://api.appstoreconnect.apple.com/v1/analyticsReportRequests/x', 'DELETE'), false);
  assert.equal(chamadaDePedidoPermitida('https://api.appstoreconnect.apple.com/v1/apps', 'POST'), false);
  assert.equal(chamadaDePedidoPermitida('https://api.appstoreconnect.apple.com/v1/users'), false);
  assert.equal(chamadaDePedidoPermitida('https://api.appstoreconnect.apple.com/v1/analyticsReports/r/instances'), false);
  assert.equal(chamadaDePedidoPermitida('https://outro.exemplo.com/v1/apps'), false);
});

test('32.3: link de paginacao para fora da lista e recusado antes de sair', async () => {
  const chamadas = [];
  const buscar = async (url) => {
    chamadas.push(url);
    return { ok: true, status: 200, json: async () => ({ data: [], links: { next: 'https://api.appstoreconnect.apple.com/v1/users?cursor=1' } }) };
  };
  const cliente = clienteDePedidos({ chaveP8: chaveDeTeste(), issuerId: 'i', keyId: 'K', fetch: buscar });
  await assert.rejects(cliente.listarApps(), /fora dos pedidos de relatorio recusada: GET .*\/v1\/users/);
  assert.equal(chamadas.length, 1);
});

test('36.2: app sem ONGOING ativo ganha um ONGOING; app com request existente nao ganha outro; erro de um app nao para os outros', async () => {
  const apple = appleSimulada({ apps: APPS, pedidos: PEDIDOS, falharAoCriar: ['4'] });
  const chaveP8 = chaveDeTeste();
  const resultado = await pedirRelatoriosQueFaltam({
    leitura: clienteDePedidos({ chaveP8, issuerId: 'i', keyId: 'LEITURA', fetch: apple.buscar }),
    pedido: clienteDePedidos({ chaveP8, issuerId: 'i', keyId: 'PEDIDO', fetch: apple.buscar }),
  });
  assert.deepEqual(resultado.map(({ appId, situacao, pedidos }) => [appId, situacao, pedidos.map((item) => item.tipo)]), [
    ['1', 'ja-tinha', []],
    ['2', 'pedido-criado', ['ONGOING']],
    ['3', 'pedido-criado', ['ONGOING']],
    ['4', 'falhou', []],
    ['5', 'pedido-criado', ['ONGOING']],
  ]);
  // O app 1 ja tinha ONGOING: nenhum POST para ele. O erro do app 4 nao parou o app 5.
  assert.deepEqual(apple.criados, [['2', 'ONGOING'], ['3', 'ONGOING'], ['5', 'ONGOING']]);
  assert.match(resultado[3].erro, /403/);
  assert.ok(apple.chamadas.every((chamada) => /^(GET \/v1\/apps(\/\d+\/analyticsReportRequests)?|POST \/v1\/analyticsReportRequests)$/.test(chamada)));
});

test('36.2: registro em Stats/instalacoesApp com o app, a situacao e o motivo, sem conteudo de chave', () => {
  const pedidos = [
    { appId: '1', bundle: 'br.com.zero.grau', situacao: 'ja-tinha', pedidos: [] },
    { appId: '4', bundle: 'br.com.recusado', situacao: 'falhou', pedidos: [], erro: 'App Store Connect respondeu 403 em /v1/analyticsReportRequests' },
    { appId: '2', bundle: 'br.com.novo', situacao: 'pedido-criado', pedidos: [{ tipo: 'ONGOING', id: 'pedido-1' }] },
  ];
  const agora = new Date('2026-10-19T07:15:00Z');
  assert.deepEqual(pedidoAppleDaLoja(pedidos, 'br.com.zero.grau', agora), { appId: '1', bundle: 'br.com.zero.grau', situacao: 'ja-tinha', em: '2026-10-19T07:15:00.000Z' });
  assert.deepEqual(pedidoAppleDaLoja(pedidos, 'br.com.recusado', agora), {
    appId: '4', bundle: 'br.com.recusado', situacao: 'falhou', motivo: 'App Store Connect respondeu 403 em /v1/analyticsReportRequests', em: '2026-10-19T07:15:00.000Z',
  });
  assert.deepEqual(pedidoAppleDaLoja(pedidos, 'br.com.novo', agora).pedidos, [{ tipo: 'ONGOING', id: 'pedido-1' }]);
  assert.equal(pedidoAppleDaLoja(pedidos, 'br.com.sem.app', agora), null);
  assert.equal(pedidoAppleDaLoja(pedidos, undefined, agora), null);
});

test('32.3: sem a chave de pedido, a rotina so aponta o app sem pedido e nao cria nada', async () => {
  const apple = appleSimulada({ apps: APPS, pedidos: PEDIDOS });
  const resultado = await pedirRelatoriosQueFaltam({
    leitura: clienteDePedidos({ chaveP8: chaveDeTeste(), issuerId: 'i', keyId: 'LEITURA', fetch: apple.buscar }),
    pedido: null,
  });
  assert.deepEqual(resultado.map(({ appId, situacao }) => [appId, situacao]), [['1', 'ja-tinha'], ['2', 'sem-pedido'], ['3', 'sem-pedido'], ['4', 'sem-pedido'], ['5', 'sem-pedido']]);
  assert.equal(apple.chamadas.filter((chamada) => chamada.startsWith('POST')).length, 0);
});

test('36.2: segredo lido pelo caminho completo, em outro projeto; sem o segredo ou sem acesso, null', async () => {
  const conteudo = Buffer.from('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n').toString('base64');
  const urls = [];
  const caminho = 'projects/mobile-chaves-apple/secrets/APPLE_RELATORIOS_PEDIDO_P8/versions/latest';
  const lido = await lerSegredoOpcional({
    pedirAoGoogle: async ({ url }) => { urls.push(url); return { data: { payload: { data: conteudo } } }; },
    caminho,
  });
  assert.ok(lido.startsWith('-----BEGIN PRIVATE KEY-----'));
  assert.deepEqual(urls, [`https://secretmanager.googleapis.com/v1/${caminho}:access`]);
  assert.equal(await lerSegredoOpcional({ pedirAoGoogle: async () => { throw new Error('403'); }, caminho }), null);
  assert.equal(await lerSegredoOpcional({ pedirAoGoogle: async () => ({ data: { payload: { data: '' } } }), caminho }), null);
  // Caminho vazio ou fora do formato: nem chama.
  const chamadas = [];
  const contar = async () => { chamadas.push(1); return { data: {} }; };
  assert.equal(await lerSegredoOpcional({ pedirAoGoogle: contar, caminho: '' }), null);
  assert.equal(await lerSegredoOpcional({ pedirAoGoogle: contar, caminho: 'APPLE_RELATORIOS_PEDIDO_P8' }), null);
  assert.equal(chamadas.length, 0);
});

test('36.2 e 36.3: so a rotina semanal usa a chave de pedido; a rota do Admin nunca; Key ID e caminho no .env', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  assert.ok(index.includes("const APPLE_PEDIDO_KEY_ID = defineString('APPLE_PEDIDO_KEY_ID', { default: '' });"));
  assert.ok(index.includes("const APPLE_PEDIDO_SEGREDO = defineString('APPLE_PEDIDO_SEGREDO', { default: '' });"));
  assert.ok(index.includes('lerSegredoOpcional({ pedirAoGoogle, caminho: APPLE_PEDIDO_SEGREDO.value() })'));
  // Nao entra em secrets (o defineSecret so enxerga o proprio projeto).
  assert.ok(/secrets: \[APPLE_RELATORIOS_LEITURA_P8\],\r?\n/.test(index));
  assert.ok(index.includes("await snapshot.ref.collection('Stats').doc('instalacoesApp').set({ pedidoApple }, { merge: true })"));
  assert.ok(index.includes('pedidoApple: situacaoDoPedido(snapshot),'));
  assert.equal(index.split('pedidosDaAppleDaSemana(').length - 1, 2);
  const env = fs.readFileSync(path.join(__dirname, '.env.appmobileprod-19505'), 'utf8').split(/\r?\n/).filter(Boolean);
  assert.deepEqual(env.map((linha) => linha.split('=')[0]), ['APPLE_ISSUER_ID', 'APPLE_KEY_ID', 'PLAY_REPORTS_BUCKET', 'APPLE_PEDIDO_KEY_ID', 'APPLE_PEDIDO_SEGREDO']);
  assert.ok(env.includes('APPLE_PEDIDO_SEGREDO=projects/mobile-chaves-apple/secrets/APPLE_RELATORIOS_PEDIDO_P8/versions/latest'));
  assert.ok(!/BEGIN|PRIVATE/.test(env.join('\n')));
  // Nada no Core (a rota do botao do Admin) nem no apphosting.yaml usa a chave de pedido.
  const arquivos = (pasta) => fs.readdirSync(pasta, { withFileTypes: true }).flatMap((item) => {
    const caminho = path.join(pasta, item.name);
    return item.isDirectory() ? arquivos(caminho) : [caminho];
  });
  const doCore = [...arquivos(path.join(__dirname, '..', 'src')).filter((arquivo) => arquivo.endsWith('.js')), path.join(__dirname, '..', 'apphosting.yaml')];
  doCore.forEach((arquivo) => {
    const texto = fs.readFileSync(arquivo, 'utf8');
    assert.ok(!/APPLE_RELATORIOS_PEDIDO_P8|clienteDePedidos|pedirRelatoriosQueFaltam|APPLE_PEDIDO_/.test(texto), arquivo);
  });
});

test('36.2: a montagem regrava o documento sem perder o registro do pedido da Apple', async () => {
  const gravados = [];
  const atual = { dias: {}, pedidoApple: { appId: '1', situacao: 'ja-tinha', em: 'x' } };
  const referencia = { get: async () => ({ exists: true, data: () => atual }), set: async (dados) => { gravados.push(dados); } };
  const db = { collection: () => ({ doc: () => ({ collection: () => ({ doc: () => referencia }) }) }) };
  const bucket = bucketFalso({
    [arquivoDaPlay('br.com.zero.grau', '2026-10', 'overview')]: utf16(`${CABECALHO.replace(',Country', '')}\n2026-10-02,br.com.zero.grau,0,0,0,0,2,0,56,0,0,0`),
  });
  await atualizarInstalacoes({ db, FieldValue: { serverTimestamp: () => 'agora' }, lojaId: 'zg', apps: appsDaLoja('br.com.zero.grau'), bucket, meses: ['2026-10'] });
  assert.deepEqual(gravados[0].pedidoApple, atual.pedidoApple);
});
