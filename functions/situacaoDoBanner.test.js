const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  CAMPOS_AO_LIGAR,
  camposDaAcao,
  ligarBannersAgendados,
  normalizacaoDoAgendado,
  situacaoDoBanner,
  tratarBannerGravado,
} = require('./situacaoDoBanner');
const { marcarMudanca } = require('./marcador');

const AGORA = Date.parse('2026-10-15T12:00:00Z');
const antes = new Date(AGORA - 60 * 60 * 1000);
const depois = new Date(AGORA + 60 * 60 * 1000);
const muitoDepois = new Date(AGORA + 3 * 24 * 60 * 60 * 1000);
const banner = (campos) => ({ startAt: antes, endAt: muitoDepois, status: true, started: true, ...campos });

test('situacao: os quatro casos', () => {
  assert.equal(situacaoDoBanner(banner(), AGORA), 'noApp');
  assert.equal(situacaoDoBanner(banner({ startAt: depois, status: false, started: false, aguardandoInicio: true }), AGORA), 'agendado');
  // Gravado pelo app gerenciador com inicio no futuro (status true): agendado, nao no app.
  assert.equal(situacaoDoBanner(banner({ startAt: depois }), AGORA), 'agendado');
  assert.equal(situacaoDoBanner(banner({ status: false, started: false }), AGORA), 'pausado');
  assert.equal(situacaoDoBanner(banner({ startAt: depois, status: false, aguardandoInicio: false }), AGORA), 'pausado');
  assert.equal(situacaoDoBanner(banner({ endAt: antes, startAt: new Date(AGORA - 9e6) }), AGORA), 'encerrado');
  assert.equal(situacaoDoBanner(banner({ endAt: antes, status: false, aguardandoInicio: true }), AGORA), 'encerrado');
});

test('situacao: bordas (inicio igual a agora, fim igual a agora) e datas do Firestore', () => {
  assert.equal(situacaoDoBanner(banner({ startAt: new Date(AGORA) }), AGORA), 'noApp');
  assert.equal(situacaoDoBanner(banner({ startAt: new Date(AGORA + 1) }), AGORA), 'agendado');
  assert.equal(situacaoDoBanner(banner({ endAt: new Date(AGORA) }), AGORA), 'encerrado');
  assert.equal(situacaoDoBanner(banner({ endAt: new Date(AGORA + 1) }), AGORA), 'noApp');
  // Timestamp do Admin SDK, { seconds } e { _seconds }.
  const timestamp = { toMillis: () => AGORA - 1000 };
  assert.equal(situacaoDoBanner(banner({ startAt: timestamp }), AGORA), 'noApp');
  assert.equal(situacaoDoBanner(banner({ endAt: { seconds: AGORA / 1000 } }), AGORA), 'encerrado');
  assert.equal(situacaoDoBanner(banner({ startAt: { _seconds: AGORA / 1000 + 60 } }), AGORA), 'agendado');
  assert.equal(situacaoDoBanner(banner({ startAt: '2026-10-15T12:00:00Z' }), new Date(AGORA)), 'noApp');
});

test('gatilho: status true com inicio no futuro passa a aguardar; a passada seguinte nao grava (sem laco)', async () => {
  assert.deepEqual(normalizacaoDoAgendado(banner({ startAt: depois }), AGORA), { status: false, started: false, aguardandoInicio: true });
  assert.equal(normalizacaoDoAgendado(banner({ startAt: new Date(AGORA) }), AGORA), null);
  assert.equal(normalizacaoDoAgendado(banner({ startAt: depois, status: false, aguardandoInicio: true }), AGORA), null);
  assert.equal(normalizacaoDoAgendado(banner({ startAt: depois, status: false, aguardandoInicio: false }), AGORA), null);

  // Simula o Firestore: cada update dispara o gatilho de novo, como o onDocumentWritten.
  let documento = banner({ startAt: depois });
  const gravacoes = [];
  const marcas = [];
  const referencia = {
    async update(campos) {
      gravacoes.push(campos);
      documento = { ...documento, ...campos };
      await disparar();
    },
  };
  const disparar = () => tratarBannerGravado({
    lojaId: 'loja-1', referencia, depois: documento, agora: AGORA, marcar: async (loja) => { marcas.push(loja); },
  });
  await disparar();
  assert.deepEqual(gravacoes, [{ status: false, started: false, aguardandoInicio: true }]);
  assert.equal(documento.status, false);
  assert.deepEqual(marcas, ['loja-1', 'loja-1']);
});

test('gatilho: criacao, atualizacao e remocao marcam banners; falha ao normalizar nao impede a marca', async () => {
  const marcas = [];
  const marcar = async (loja) => { marcas.push(loja); };
  const semGravar = { update: async () => { throw new Error('nao deveria gravar'); } };
  assert.deepEqual(await tratarBannerGravado({ lojaId: 'l', referencia: semGravar, depois: banner(), agora: AGORA, marcar }), { normalizou: false });
  assert.deepEqual(await tratarBannerGravado({ lojaId: 'l', referencia: semGravar, depois: null, agora: AGORA, marcar }), { normalizou: false });
  const falhas = [];
  const falhando = { update: async () => { throw new Error('sem rede'); } };
  await tratarBannerGravado({
    lojaId: 'l', referencia: falhando, depois: banner({ startAt: depois }), agora: AGORA, marcar, aoFalhar: (etapa) => falhas.push(etapa),
  });
  assert.deepEqual(marcas, ['l', 'l', 'l']);
  assert.deepEqual(falhas, ['normalizar']);
});

test('marcador: aceita o tipo banners', async () => {
  const gravados = [];
  const db = { collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ set: async (dados) => { gravados.push(dados); } }) }) }) }) };
  const FieldValue = { increment: (n) => ({ increment: n }), serverTimestamp: () => ({ serverTimestamp: true }) };
  await marcarMudanca({ db, FieldValue, lojaId: 'loja-1', tipo: 'banners' });
  assert.deepEqual(Object.keys(gravados[0]).sort(), ['banners', 'bannersEm', 'versaoMarcador']);
});

// Firestore de mentira para a rotina: guarda a consulta feita e os updates.
function bancoDaRotina(documentos) {
  const registro = { consulta: [], atualizados: [] };
  const referencia = (caminho) => {
    const partes = caminho.split('/');
    return {
      path: caminho,
      id: partes.at(-1),
      parent: { id: partes.at(-2), parent: { id: partes.at(-3), path: partes.slice(0, -2).join('/'), parent: { id: partes.at(-4) } } },
      async update(campos) {
        if (caminho.includes('falha')) throw new Error('sem permissao');
        registro.atualizados.push({ caminho, campos });
      },
    };
  };
  const consulta = {
    where(campo, operador, valor) { registro.consulta.push([campo, operador, valor]); return consulta; },
    limit(n) { registro.consulta.push(['limit', n]); return consulta; },
    async get() { return { docs: documentos.map((caminho) => ({ ref: referencia(caminho) })) }; },
  };
  return { db: { collectionGroup: (nome) => { registro.grupo = nome; return consulta; } }, registro };
}

test('rotina: liga os que aguardavam com inicio ja passado, por loja; so estabelecimentos/{loja}/Banners', async () => {
  const agora = new Date(AGORA);
  const { db, registro } = bancoDaRotina([
    'estabelecimentos/loja-1/Banners/b1',
    'estabelecimentos/loja-1/Banners/b2',
    'estabelecimentos/loja-2/Banners/b3',
    'outraColecao/x/Banners/b4',
    'estabelecimentos/loja-3/Banners/falha',
  ]);
  const falhas = [];
  const resultado = await ligarBannersAgendados({ db, agora, aoFalhar: (caminho) => falhas.push(caminho) });
  assert.equal(registro.grupo, 'Banners');
  assert.deepEqual(registro.consulta, [['aguardandoInicio', '==', true], ['startAt', '<=', agora], ['limit', 500]]);
  assert.deepEqual(registro.atualizados.map((item) => item.caminho), [
    'estabelecimentos/loja-1/Banners/b1', 'estabelecimentos/loja-1/Banners/b2', 'estabelecimentos/loja-2/Banners/b3',
  ]);
  registro.atualizados.forEach((item) => assert.deepEqual(item.campos, { status: true, started: true, aguardandoInicio: false }));
  assert.deepEqual([...resultado.porLoja].map(([loja, { ligados }]) => [loja, ligados]), [['loja-1', 2], ['loja-2', 1]]);
  assert.deepEqual(falhas, ['estabelecimentos/loja-3/Banners/falha']);
  assert.equal(resultado.lidos, 5);
  // Ligado pela rotina, o gatilho ve status true com inicio passado e nao grava de novo.
  assert.equal(normalizacaoDoAgendado(banner({ ...CAMPOS_AO_LIGAR, startAt: antes }), AGORA), null);
});

test('pausar e retomar: os tres casos e o encerrado sem acao', () => {
  // Pausar: status false, aguardandoInicio false; started fica como esta.
  assert.deepEqual(camposDaAcao(banner(), 'pausar', AGORA), { status: false, aguardandoInicio: false });
  assert.deepEqual(camposDaAcao(banner({ startAt: depois, status: false, started: false, aguardandoInicio: true }), 'pausar', AGORA), { status: false, aguardandoInicio: false });
  // Retomar com inicio no futuro: volta a Agendado.
  assert.deepEqual(camposDaAcao(banner({ startAt: depois, status: false, aguardandoInicio: false }), 'retomar', AGORA), { status: false, started: false, aguardandoInicio: true });
  // Retomar ja comecado e nao terminado: liga.
  assert.deepEqual(camposDaAcao(banner({ status: false, aguardandoInicio: false }), 'retomar', AGORA), { status: true, started: true, aguardandoInicio: false });
  // Encerrado: sem Pausar nem Retomar.
  assert.equal(camposDaAcao(banner({ endAt: new Date(AGORA) }), 'pausar', AGORA), null);
  assert.equal(camposDaAcao(banner({ endAt: antes, status: false }), 'retomar', AGORA), null);
  assert.throws(() => camposDaAcao(banner(), 'apagar', AGORA), /invalida/);
});

test('index.js: gatilho em estabelecimentos/{loja}/Banners/{id} e rotina a cada 5 minutos; indice escrito', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  assert.match(index, /exports\.ajustarBannerGravado = onDocumentWritten\(\s+'estabelecimentos\/\{lojaId\}\/Banners\/\{bannerId\}'/);
  assert.match(index, /exports\.ligarBannersAgendados = onSchedule\(\s+\{\s+schedule: 'every 5 minutes'/);
  assert.ok(index.includes("tipo: 'banners',"));
  assert.ok(index.includes("await registrarNoite(storeRef, 'ligarBannersAgendados', { dados: { bannersLigados: ligados } });"));
  const indices = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'firestore.indexes.json'), 'utf8')).indexes;
  assert.deepEqual(indices.filter((indice) => indice.collectionGroup === 'Banners' && indice.queryScope === 'COLLECTION_GROUP'), [{
    collectionGroup: 'Banners',
    queryScope: 'COLLECTION_GROUP',
    fields: [{ fieldPath: 'aguardandoInicio', order: 'ASCENDING' }, { fieldPath: 'startAt', order: 'ASCENDING' }],
  }]);
});
