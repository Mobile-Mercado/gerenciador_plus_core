const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  atualizarVisitasPorMes, diaDoId, idsDosDias, mesesDaNoite, somarVisitasPorMes,
} = require('./visitasPorMes');

const FieldValue = { serverTimestamp: () => ({ serverTimestamp: true }) };

test('soma por mes: app = appViewsCount, agente = agentAppViewsCount; viewsCount fica fora', () => {
  const soma = somarVisitasPorMes([
    { id: '01-10-2026', dados: { appViewsCount: 3, agentAppViewsCount: 1, viewsCount: 50, createdAt: {} } },
    { id: '15-10-2026', dados: { appViewsCount: 2, createdAt: {} } },
    { id: '30-09-2026', dados: { appViewsCount: 4, agentAppViewsCount: 2 } },
    { id: 'resumo', dados: { appViewsCount: 9 } },
  ]);
  assert.deepEqual(soma.meses, { '2026-10': { app: 5, agente: 1 }, '2026-09': { app: 4, agente: 2 } });
  assert.equal(soma.ultimoDia, '2026-10-15');
  assert.equal(soma.lidos, 4);
  assert.equal(soma.foraDoFormato, 1);
  assert.equal(soma.semCreatedAt, 2);
  assert.equal(diaDoId('31-12-2025'), '2025-12-31');
  assert.equal(diaDoId('2025-12-31'), null);
  assert.equal(diaDoId('01-13-2025'), null);
});

test('mes atual e anterior no fuso de Sao Paulo, e os dias pelo id (no maximo 62)', () => {
  assert.deepEqual(mesesDaNoite(new Date('2026-10-16T05:45:00Z')), ['2026-09', '2026-10']);
  // 01/01 02:45 em Sao Paulo: o anterior e dezembro do ano passado.
  assert.deepEqual(mesesDaNoite(new Date('2027-01-01T05:45:00Z')), ['2026-12', '2027-01']);
  // 00:30 UTC de 1/11 ainda e 31/10 em Sao Paulo.
  assert.deepEqual(mesesDaNoite(new Date('2026-11-01T00:30:00Z')), ['2026-09', '2026-10']);
  const ids = idsDosDias(['2026-09', '2026-10']);
  assert.equal(ids.length, 61);
  assert.equal(ids[0], '01-09-2026');
  assert.equal(ids.at(-1), '31-10-2026');
  assert.equal(idsDosDias(['2026-07', '2026-08']).length, 62);
  assert.equal(idsDosDias(['2028-02']).length, 29);
});

// Firestore de mentira: DailyStats por id e o documento de Stats gravado com merge profundo.
function bancoFalso(diarios, statsInicial = null) {
  const registro = { getAll: 0, lidos: 0, gravacoes: [] };
  let stats = statsInicial;
  const mesclar = (atual, novo) => {
    const saida = { ...(atual || {}) };
    Object.entries(novo).forEach(([chave, valor]) => {
      saida[chave] = valor && typeof valor === 'object' && !Array.isArray(valor) && !valor.serverTimestamp ? mesclar(saida[chave], valor) : valor;
    });
    return saida;
  };
  const loja = {
    collection: (nome) => ({
      doc: (id) => (nome === 'DailyStats'
        ? { id, existe: Object.hasOwn(diarios, id) }
        : { set: async (dados, opcoes) => { registro.gravacoes.push({ id, dados, opcoes }); stats = opcoes?.merge ? mesclar(stats, dados) : dados; } }),
    }),
  };
  const db = {
    collection: () => ({ doc: () => loja }),
    getAll: async (...referencias) => {
      registro.getAll += 1;
      registro.lidos += referencias.length;
      return referencias.map((referencia) => ({ id: referencia.id, exists: referencia.existe, data: () => diarios[referencia.id] }));
    },
  };
  return { db, registro, stats: () => stats };
}

test('rotina: recalcula do zero o mes atual e o anterior e grava por cima; rodar duas vezes nao soma duas vezes', async () => {
  const diarios = {
    '02-09-2026': { appViewsCount: 4, agentAppViewsCount: 1 },
    '10-10-2026': { appViewsCount: 3 },
    '15-10-2026': { appViewsCount: 1, agentAppViewsCount: 2 },
  };
  const { db, registro, stats } = bancoFalso(diarios, { meses: { '2025-12': { app: 7, agente: 0 }, '2026-10': { app: 999, agente: 999 } } });
  const agora = new Date('2026-10-16T05:45:00Z');
  const primeira = await atualizarVisitasPorMes({ db, FieldValue, lojaId: 'loja-1', agora });
  await atualizarVisitasPorMes({ db, FieldValue, lojaId: 'loja-1', agora });
  assert.equal(registro.getAll, 2);
  assert.equal(registro.lidos, 122);
  assert.equal(primeira.diasLidos, 61);
  assert.equal(primeira.encontrados, 3);
  assert.deepEqual(stats().meses, {
    '2025-12': { app: 7, agente: 0 },
    '2026-09': { app: 4, agente: 1 },
    '2026-10': { app: 4, agente: 2 },
  });
  assert.equal(stats().atualizadoAte, '2026-10-15');
  assert.deepEqual(registro.gravacoes[0].opcoes, { merge: true });
  assert.equal(registro.gravacoes[0].id, 'visitasPorMes');
  // Sem gravar (simulacao): so le.
  const simulacao = bancoFalso(diarios);
  await atualizarVisitasPorMes({ db: simulacao.db, FieldValue, lojaId: 'loja-1', agora, gravar: false });
  assert.equal(simulacao.registro.gravacoes.length, 0);
  // Mes sem documento grava zero.
  const vazio = bancoFalso({});
  const resultado = await atualizarVisitasPorMes({ db: vazio.db, FieldValue, lojaId: 'loja-1', agora });
  assert.deepEqual(resultado.meses, { '2026-09': { app: 0, agente: 0 }, '2026-10': { app: 0, agente: 0 } });
  assert.equal('atualizadoAte' in vazio.stats(), false);
});

test('index.js: visitasPorMesNightly semanal, segunda as 02:45 (28.3), sem colidir com as outras rotinas', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  assert.match(index, /exports\.visitasPorMesNightly = onSchedule\(\s+\{\s+schedule: '45 2 \* \* 1',\s+timeZone: 'America\/Sao_Paulo'/);
  const horarios = [...index.matchAll(/schedule: '([^']+)'/g)].map((achado) => achado[1]);
  assert.equal(horarios.filter((horario) => horario.startsWith('45 2 ')).length, 1);
  assert.ok(index.includes("await registrarNoite(snapshot.ref, 'visitasPorMesNightly', {"));
});
