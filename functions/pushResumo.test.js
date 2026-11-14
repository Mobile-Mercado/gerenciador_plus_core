const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  chaveDaLoja,
  contarEnvios,
  contarFalhaGeral,
  gravarResultadoDosEnvios,
  incrementosDoDia,
  resultadoDoErro,
  semToken,
} = require('./pushResumo');

const increment = (n) => ({ inc: n });

test('resultado: aceito, token inexistente, sem APNs (401 do FCM) e outro', () => {
  assert.equal(resultadoDoErro('messaging/registration-token-not-registered'), 'token_inexistente');
  assert.equal(resultadoDoErro('messaging/invalid-registration-token'), 'token_inexistente');
  assert.equal(resultadoDoErro('messaging/third-party-auth-error'), 'sem_apns');
  assert.equal(resultadoDoErro('messaging/internal-error'), 'outro');
});

test('contagem do sendEachForMulticast por plataforma e resultado, com os codigos que falharam', () => {
  const { contagens, codigos } = contarEnvios([
    { success: true },
    { success: true },
    { success: false, error: { code: 'messaging/third-party-auth-error' } },
    { success: false, error: { code: 'messaging/registration-token-not-registered' } },
    { success: false, error: { code: 'messaging/internal-error' } },
  ], ['android', 'ios', 'ios', undefined, 'android']);
  assert.deepEqual(contagens, [
    { plataforma: 'android', resultado: 'aceito', vezes: 1 },
    { plataforma: 'ios', resultado: 'aceito', vezes: 1 },
    { plataforma: 'ios', resultado: 'sem_apns', vezes: 1 },
    { plataforma: 'desconhecida', resultado: 'token_inexistente', vezes: 1 },
    { plataforma: 'android', resultado: 'outro', vezes: 1 },
  ]);
  assert.deepEqual(codigos, {
    messaging_third_party_auth_error: 1,
    messaging_registration_token_not_registered: 1,
    messaging_internal_error: 1,
  });
  assert.deepEqual(contarFalhaGeral('app/network-error', ['web', 'web']).contagens, [{ plataforma: 'web', resultado: 'outro', vezes: 2 }]);
  assert.deepEqual(semToken().contagens, [{ plataforma: 'nenhuma', resultado: 'sem_token', vezes: 1 }]);
});

test('incrementos do dia: total, loja > origem > audiencia > plataforma > resultado, e codigos; sem loja vira sem-loja', () => {
  const objeto = incrementosDoDia({
    dia: '2026-11-14',
    loja: 'zg',
    origem: 'sendOrderNotification',
    audiencia: 'lojista',
    contagens: [
      { plataforma: 'web', resultado: 'aceito', vezes: 2 },
      { plataforma: 'web', resultado: 'token_inexistente', vezes: 1 },
      { plataforma: 'web', resultado: 'aceito', vezes: 1 },
    ],
    codigos: { messaging_registration_token_not_registered: 1 },
    increment,
  });
  assert.deepEqual(objeto, {
    dia: '2026-11-14',
    total: { aceito: { inc: 3 }, token_inexistente: { inc: 1 } },
    lojas: { zg: { sendordernotification: { lojista: { web: { aceito: { inc: 3 }, token_inexistente: { inc: 1 } } } } } },
    codigos: { messaging_registration_token_not_registered: { inc: 1 } },
  });
  assert.equal(chaveDaLoja(null), 'sem-loja');
  assert.equal(chaveDaLoja('a/b'), 'sem-loja');
  assert.equal(chaveDaLoja('q0IPIusmpEq3pHbMyfWY'), 'q0IPIusmpEq3pHbMyfWY');
});

test('gravacao: um documento por dia em PushResumo, com merge; falha no banco nao lanca', async () => {
  const gravados = [];
  const db = {
    collection: (nome) => ({
      doc: (id) => ({ set: async (valor, opcoes) => { gravados.push({ caminho: `${nome}/${id}`, valor, opcoes }); } }),
    }),
  };
  const FieldValue = { increment, serverTimestamp: () => 'carimbo' };
  const ok = await gravarResultadoDosEnvios({
    db, FieldValue, agora: new Date('2026-11-14T02:30:00Z'), loja: 'zg', origem: 'avisarMensagemNova', audiencia: 'lojista', ...semToken(),
  });
  assert.equal(ok, true);
  assert.equal(gravados[0].caminho, 'PushResumo/2026-11-13');
  assert.deepEqual(gravados[0].opcoes, { merge: true });
  assert.equal(gravados[0].valor.atualizadoEm, 'carimbo');
  assert.deepEqual(gravados[0].valor.total, { sem_token: { inc: 1 } });
  // Nada a contar: nao grava.
  assert.equal(await gravarResultadoDosEnvios({ db, FieldValue, origem: 'x', audiencia: 'y' }), false);
  const quebrado = { collection: () => ({ doc: () => ({ set: async () => { throw new Error('sem banco'); } }) }) };
  assert.equal(await gravarResultadoDosEnvios({ db: quebrado, FieldValue, origem: 'x', audiencia: 'y', ...semToken() }), false);
});

test('index.js: o envio a loja conta cada resultado, sem token e sem texto da mensagem', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const envio = index.slice(index.indexOf('async function enviarAvisoParaLoja('), index.indexOf('exports.sendOrderNotification'));
  assert.ok(envio.includes('contarNoDia(semToken());'));
  assert.ok(envio.includes('contarNoDia({ contagens, codigos });'));
  const contarNoDia = envio.slice(envio.indexOf('const contarNoDia'), envio.indexOf('if (tokenDocsSnap.empty)'));
  ['token', 'title', 'body'].forEach((campo) => assert.ok(!new RegExp(`\\b${campo}\\b`).test(contarNoDia), campo));
});

test('RP-173: a contagem vem depois do envio e da desativacao dos tokens do bloco, e erro nela so vai ao log', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const envio = index.slice(index.indexOf('async function enviarAvisoParaLoja('), index.indexOf('exports.sendOrderNotification'));
  const enviar = envio.indexOf('sendEachForMulticast(message)');
  const desativar = envio.indexOf('ref.update({ active: false })');
  const contar = envio.indexOf("juntar(() => contarEnvios(response.responses, chunk.map(() => 'web')));");
  assert.ok(enviar > 0 && desativar > enviar && contar > desativar);
  assert.ok(envio.includes("juntar(() => contarFalhaGeral(chunkError?.code || 'desconhecido', chunk.map(() => 'web')));"));
  assert.match(envio, /const juntar = \(contar\) => \{\s+try \{/);
  // A ultima contagem vem depois do envio e nunca lanca (gravarResultadoDosEnvios tem try/catch).
  assert.ok(envio.indexOf('contarNoDia({ contagens, codigos });') > envio.lastIndexOf('sendEachForMulticast'));
});

test('RP-173: o contar que lanca nao chega ao envio (juntar pega e so registra)', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const inicio = index.indexOf('  const juntar = (contar) => {');
  const fim = index.indexOf('\n  };', inicio) + 4;
  const contagens = [];
  const codigos = {};
  const origem = 'teste';
  const erros = [];
  const consoleOriginal = console.error;
  console.error = (...args) => erros.push(args.join(' '));
  try {
    // eslint-disable-next-line no-new-func
    const juntar = new Function('contagens', 'codigos', 'origem', `${index.slice(inicio, fim)}; return juntar;`)(contagens, codigos, origem);
    assert.doesNotThrow(() => juntar(() => { throw new Error('quebrou'); }));
    juntar(() => ({ contagens: [{ plataforma: 'web', resultado: 'aceito', vezes: 1 }], codigos: { x: 1 } }));
  } finally {
    console.error = consoleOriginal;
  }
  assert.equal(erros.length, 1);
  assert.deepEqual(contagens, [{ plataforma: 'web', resultado: 'aceito', vezes: 1 }]);
  assert.deepEqual(codigos, { x: 1 });
});

test('RP-173: o envio nao espera a gravacao da contagem; os 4 gatilhos esperam as pendentes so no fim', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const envio = index.slice(index.indexOf('async function enviarAvisoParaLoja('), index.indexOf('exports.sendOrderNotification'));
  assert.ok(!/await contarNoDia/.test(envio), 'enviarAvisoParaLoja nao espera a contagem');
  assert.ok(envio.includes('const contarNoDia = (contagem) => contarSemEsperar(gravarResultadoDosEnvios({'));
  ['sendOrderNotification', 'avisarPedidoPagoPeloApp', 'avisarMensagemNova', 'avisarPedidoCancelado'].forEach((nome, i, todos) => {
    const inicio = index.indexOf(`exports.${nome} = `);
    const proximo = todos[i + 1] ? index.indexOf(`exports.${todos[i + 1]} = `) : index.indexOf('async function loadStoreOrders');
    const gatilho = index.slice(inicio, proximo);
    assert.match(gatilho, /\} finally \{\s+await esperarContagens\(\);\s+\}/, nome);
  });
});

test('RP-173: contarSemEsperar guarda a promessa ate terminar; esperarContagens espera e nunca lanca', async () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const inicio = index.indexOf('const contagensPendentes = new Set();');
  const fim = index.indexOf('// Envio de Web Push para todos os navegadores ativos da loja');
  // eslint-disable-next-line no-new-func
  const { contarSemEsperar, esperarContagens, contagensPendentes } = new Function(
    `${index.slice(inicio, fim)}; return { contarSemEsperar, esperarContagens, contagensPendentes };`,
  )();
  let terminar;
  let gravou = false;
  contarSemEsperar(new Promise((resolve) => { terminar = resolve; }).then(() => { gravou = true; }));
  contarSemEsperar(Promise.reject(new Error('falhou')));
  assert.equal(contagensPendentes.size, 2);
  const espera = esperarContagens();
  terminar();
  await espera;
  assert.equal(gravou, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(contagensPendentes.size, 0);
});
