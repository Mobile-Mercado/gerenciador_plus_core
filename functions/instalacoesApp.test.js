const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {
  APPS_POR_WHITELABEL, appsDaLoja, arquivoDaPlay, atualizarInstalacoes, decodificarTexto, doisUltimosMeses,
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

test('CSV da Play em UTF-16: soma os paises do dia; no ultimo dia, instalados agora e total', () => {
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
  assert.equal(soma.totalInstalacoes, 107);
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
  assert.equal(lido.totalInstalacoes, 92);
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
  assert.deepEqual(documento.totalInstalacoes, { android: 107, ios: 3 });
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

test('index.js: instalacoesAppNightly as 04:15 com a conta relatorios-lojas, o segredo e os parametros', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  assert.match(index, /exports\.instalacoesAppNightly = onSchedule\(\s+\{\s+schedule: '15 4 \* \* \*',\s+timeZone: 'America\/Sao_Paulo'/);
  assert.ok(index.includes("serviceAccount: 'relatorios-lojas@appmobileprod-19505.iam.gserviceaccount.com',"));
  assert.ok(index.includes("const APPLE_RELATORIOS_LEITURA_P8 = defineSecret('APPLE_RELATORIOS_LEITURA_P8');"));
  ['APPLE_ISSUER_ID', 'APPLE_KEY_ID', 'PLAY_REPORTS_BUCKET'].forEach((nome) => assert.ok(index.includes(`const ${nome} = defineString('${nome}');`)));
  assert.ok(index.includes('secrets: [APPLE_RELATORIOS_LEITURA_P8],'));
  assert.ok(index.includes("await registrarNoite(snapshot.ref, 'instalacoesAppNightly', {"));
});
