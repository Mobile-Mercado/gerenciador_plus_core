const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  CHAVE_DO_ALERTA,
  COLECAO_DE_ALERTAS,
  TITULO_DO_ALERTA,
  avisarComputadorRecusadoUmaVez,
  dataEHora,
  idDoAlerta,
  tentativaNova,
} = require('./integradorRecusado');

// Firestore de mentira: documentos por caminho; create() falha com ALREADY_EXISTS (codigo 6)
// quando o caminho ja existe, como no Admin SDK.
function firestoreFalso(documentos = {}) {
  const banco = new Map(Object.entries(documentos));
  const criados = [];
  const doc = (caminho) => ({
    id: caminho.split('/').at(-1),
    async get() {
      const dados = banco.get(caminho);
      return { exists: dados !== undefined, data: () => dados };
    },
    async create(dados) {
      if (banco.has(caminho)) {
        const falha = new Error('6 ALREADY_EXISTS: Document already exists');
        falha.code = 6;
        throw falha;
      }
      banco.set(caminho, dados);
      criados.push({ caminho, dados });
    },
  });
  return { db: { collection: (nome) => ({ doc: (id) => doc(`${nome}/${id}`) }) }, banco, criados };
}

const LOJA = 'jQQjHTCc2zW1tuZMQzGF';
const REGISTRADA = 'a'.repeat(64);
const OUTRA = 'b'.repeat(64);
const MAIS_UMA = 'c'.repeat(64);
const NOME = 'CAIXA-02';
// 14:34:48Z = 11:34 em Sao Paulo.
const EM = new Date('2026-11-21T14:34:48Z');
const ts = (data) => ({ toDate: () => new Date(data) });

function cenario({ recusar = true, loja = { name: 'Zero Grau' }, documentos = {} } = {}) {
  const base = { [`estabelecimentos/${LOJA}`]: loja };
  if (recusar !== 'ausente') base['configuracoes/integradorUmPorLoja'] = { recusar };
  return firestoreFalso({ ...base, ...documentos });
}

function porta(tentativa) {
  return { maquina: REGISTRADA, registradoEm: ts('2026-11-21T02:46:42Z'), ...(tentativa ? { tentativaRecusada: tentativa } : {}) };
}

test('Cola 76 item 3: tentativa nova com a recusa ligada abre um alerta no Admin com loja, data e hora', async () => {
  const { db, criados } = cenario();
  const resultado = await avisarComputadorRecusadoUmaVez({
    db, lojaId: LOJA, antes: porta(), depois: porta({ maquina: OUTRA, nome: NOME, em: ts(EM) }), agora: EM,
  });
  assert.equal(resultado.avisado, true);
  assert.equal(criados.length, 1);
  const { caminho, dados } = criados[0];
  assert.equal(caminho, `${COLECAO_DE_ALERTAS}/${CHAVE_DO_ALERTA}_${LOJA}_${OUTRA.slice(0, 16)}_2026-11-21`);
  assert.equal(dados.titulo, TITULO_DO_ALERTA);
  assert.equal(dados.texto, 'Zero Grau: um computador diferente do registrado tentou usar o integrador em 21/11/2026 às 11:34 e foi recusado.');
  assert.deepEqual(dados.alcance, { tipo: 'loja', lojaId: LOJA, nome: 'Zero Grau' });
  assert.equal(dados.situacao, 'aberto');
  assert.equal(dados.chave, CHAVE_DO_ALERTA);
  assert.equal(dados.gravidade, 'atencao');
  assert.deepEqual(dados.abertoEm, EM);
  // O nome do computador so nos detalhes (que so o Admin ve); o hash em lugar nenhum do texto.
  assert.ok(!dados.texto.includes(NOME));
  assert.ok(!dados.titulo.includes(NOME));
  assert.deepEqual(dados.detalhes, [`Computador recusado: ${NOME}`, 'Recusado em: 21/11/2026 às 11:34']);
  assert.ok(!JSON.stringify(dados).includes(OUTRA));
});

test('Cola 76 item 3: um alerta por computador recusado e por dia (fuso de Sao Paulo)', async () => {
  const { db, criados } = cenario();
  const avisar = (maquina, em) => avisarComputadorRecusadoUmaVez({
    db, lojaId: LOJA, antes: porta(), depois: porta({ maquina, nome: NOME, em: ts(em) }), agora: new Date(em),
  });
  assert.equal((await avisar(OUTRA, '2026-11-21T14:34:48Z')).avisado, true);
  // Mesmo computador, 10 min depois e no fim do dia de Sao Paulo (02:59Z do dia 22 = 23:59 do 21).
  assert.deepEqual(await avisar(OUTRA, '2026-11-21T14:44:48Z'), { avisado: false, motivo: 'ja_avisado_no_dia' });
  assert.deepEqual(await avisar(OUTRA, '2026-11-22T02:59:00Z'), { avisado: false, motivo: 'ja_avisado_no_dia' });
  // Outro computador no mesmo dia: alerta proprio.
  assert.equal((await avisar(MAIS_UMA, '2026-11-21T15:00:00Z')).avisado, true);
  // Mesmo computador no dia seguinte de Sao Paulo (03:00Z do dia 22 = 00:00 do 22).
  assert.equal((await avisar(OUTRA, '2026-11-22T03:00:00Z')).avisado, true);
  assert.deepEqual(criados.map((c) => c.caminho.split('_').slice(-2).join('_')), [
    `${OUTRA.slice(0, 16)}_2026-11-21`,
    `${MAIS_UMA.slice(0, 16)}_2026-11-21`,
    `${OUTRA.slice(0, 16)}_2026-11-22`,
  ]);
});

test('Cola 76 item 3: duas entregas da mesma tentativa ao mesmo tempo abrem um alerta so', async () => {
  const { db, criados } = cenario();
  const evento = { db, lojaId: LOJA, antes: porta(), depois: porta({ maquina: OUTRA, nome: NOME, em: ts(EM) }), agora: EM };
  const resultados = await Promise.all([avisarComputadorRecusadoUmaVez(evento), avisarComputadorRecusadoUmaVez(evento)]);
  assert.equal(resultados.filter((r) => r.avisado).length, 1);
  assert.equal(criados.length, 1);
});

test('Cola 76 item 3: sem a recusa ligada (chave ausente, false ou outro valor) nao abre alerta', async () => {
  for (const recusar of ['ausente', false, 'true', 1, null]) {
    const { db, criados } = cenario({ recusar });
    const resultado = await avisarComputadorRecusadoUmaVez({
      db, lojaId: LOJA, antes: porta(), depois: porta({ maquina: OUTRA, nome: NOME, em: ts(EM) }), agora: EM,
    });
    assert.deepEqual(resultado, { avisado: false, motivo: 'so_registrar' }, String(recusar));
    assert.equal(criados.length, 0);
  }
});

test('Cola 76 item 3: escrita sem tentativa nova (uso, registro, so o nome) nao abre alerta nem le a chave', async () => {
  const { db, criados } = cenario();
  const mesma = { maquina: OUTRA, nome: null, em: ts(EM) };
  const casos = [
    [porta(), porta()],
    [undefined, porta()],
    [porta(mesma), { ...porta(mesma), ultimoUsoEm: ts('2026-11-21T14:40:00Z') }],
    [porta(mesma), porta({ ...mesma, nome: NOME })],
    [porta(mesma), undefined],
    [porta(), porta({ maquina: 'curto', nome: NOME, em: ts(EM) })],
    [porta(), porta({ maquina: OUTRA, nome: NOME, em: null })],
  ];
  for (const [antes, depois] of casos) {
    assert.deepEqual(await avisarComputadorRecusadoUmaVez({ db, lojaId: LOJA, antes, depois, agora: EM }), { avisado: false, motivo: 'sem_tentativa_nova' });
  }
  assert.equal(criados.length, 0);
});

test('Cola 76 item 3: nova tentativa depois de outra (em diferente) e reconhecida', () => {
  const primeira = { maquina: OUTRA, nome: NOME, em: ts('2026-11-21T14:34:48Z') };
  const segunda = { maquina: OUTRA, nome: NOME, em: ts('2026-11-21T14:44:48Z') };
  assert.equal(tentativaNova(porta(primeira), porta(segunda)).em.toISOString(), '2026-11-21T14:44:48.000Z');
  assert.equal(tentativaNova(porta(primeira), porta({ ...primeira, maquina: MAIS_UMA })).maquina, MAIS_UMA);
});

test('Cola 76 item 3: loja sem nome usa o id; nome do computador ausente vira "nome não informado"', async () => {
  const { db, criados } = cenario({ loja: {} });
  await avisarComputadorRecusadoUmaVez({ db, lojaId: LOJA, antes: porta(), depois: porta({ maquina: OUTRA, nome: null, em: ts(EM) }), agora: EM });
  assert.ok(criados[0].dados.texto.startsWith(`${LOJA}: `));
  assert.equal(criados[0].dados.detalhes[0], 'Computador recusado: nome não informado');
});

test('Cola 76 item 3: loja com id fora do formato nao vira caminho de documento', async () => {
  const { db, criados } = cenario();
  const resultado = await avisarComputadorRecusadoUmaVez({ db, lojaId: '../x', antes: porta(), depois: porta({ maquina: OUTRA, nome: NOME, em: ts(EM) }) });
  assert.deepEqual(resultado, { avisado: false, motivo: 'loja_invalida' });
  assert.equal(criados.length, 0);
});

test('Cola 76 item 3: data e hora no fuso de Sao Paulo e id com loja, 16 caracteres do hash e dia', () => {
  assert.equal(dataEHora(new Date('2026-11-21T02:46:42Z')), '20/11/2026 às 23:46');
  assert.equal(idDoAlerta({ lojaId: LOJA, maquina: OUTRA, dia: '2026-11-21' }), `integrador-recusado_${LOJA}_${'b'.repeat(16)}_2026-11-21`);
});

test('Cola 76 item 3 index.js: gatilho na escrita de IntegradorDaLoja/atual, sem nome nem hash no log', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const inicio = index.indexOf('exports.avisarComputadorRecusado');
  assert.ok(inicio > 0);
  const gatilho = index.slice(inicio, index.indexOf('\n);\n', inicio));
  assert.ok(gatilho.includes("onDocumentWritten(\n  'estabelecimentos/{lojaId}/IntegradorDaLoja/atual'"));
  assert.ok(gatilho.includes('avisarComputadorRecusadoUmaVez({'));
  const log = gatilho.slice(gatilho.indexOf('console.error'));
  assert.ok(!/maquina|nome|tentativa|depois|antes/.test(log));
  const modulo = fs.readFileSync(path.join(__dirname, 'integradorRecusado.js'), 'utf8');
  assert.ok(!/console\./.test(modulo));
});
