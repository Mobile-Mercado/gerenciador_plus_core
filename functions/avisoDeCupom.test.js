const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  COLECAO_DE_AVISOS,
  avisarPedidoDeCupomUmaVez,
  avisoDePedidoDeCupom,
  chaveDoAviso,
  mensagemDoAppDoLojista,
  nomeDoCadastro,
} = require('./avisoDeCupom');

const FieldValue = { serverTimestamp: () => ({ serverTimestamp: true }) };

// Firestore de mentira: documentos por caminho; create() falha com ALREADY_EXISTS (codigo 6)
// quando o caminho ja existe, como no Admin SDK; where('clientID', '==', x) em FcmTokens.
function firestoreFalso(documentos = {}) {
  const banco = new Map(Object.entries(documentos));
  const criados = [];
  const consultas = [];
  const doc = (caminho) => ({
    id: caminho.split('/').at(-1),
    path: caminho,
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
  const collection = (nome) => ({
    doc: (id) => doc(`${nome}/${id}`),
    where: (campo, op, valor) => ({
      async get() {
        consultas.push({ nome, campo, op, valor });
        const docs = [...banco.entries()]
          .filter(([caminho, dados]) => caminho.startsWith(`${nome}/`) && caminho.split('/').length === 2 && dados?.[campo] === valor)
          .map(([caminho, dados]) => ({ id: caminho.split('/')[1], data: () => dados }));
        return { docs, empty: docs.length === 0 };
      },
    }),
  });
  return { db: { collection }, banco, criados, consultas };
}

const DIA = new Date('2026-11-14T15:00:00Z'); // 12h em Sao Paulo

function cenario({ documentos = {}, falhaNoMessaging = null, respostas = null } = {}) {
  const base = {
    'Users/cli-1': { id: 'cli-1', name: 'Ana Paula' },
    'Users/dono-1': { id: 'dono-1', name: 'Dono' },
    'estabelecimentos/loja-1': { name: 'Loja', userReference: { id: 'dono-1', path: 'Users/dono-1' } },
    'FcmTokens/t1': { clientID: 'dono-1', token: 'tok-ios', platform: 'ios' },
    'FcmTokens/t2': { clientID: 'dono-1', token: 'tok-android', platform: 'android' },
    'FcmTokens/t3': { clientID: 'dono-1', token: 'tok-ios', platform: 'ios' }, // repetido
    'FcmTokens/t4': { clientID: 'outro', token: 'tok-outro' },
    'FcmTokens/web': { clientId: 'loja-1', active: true, token: 'tok-web' },
  };
  const falso = firestoreFalso({ ...base, ...documentos });
  const mensagens = [];
  const messaging = {
    async sendEachForMulticast(mensagem) {
      mensagens.push(mensagem);
      if (falhaNoMessaging) throw falhaNoMessaging;
      const responses = respostas || mensagem.tokens.map(() => ({ success: true }));
      return {
        successCount: responses.filter((r) => r.success).length,
        failureCount: responses.filter((r) => !r.success).length,
        responses,
      };
    },
  };
  const contagens = [];
  const avisosWeb = [];
  const enviarAvisoParaLoja = async (aviso) => { avisosWeb.push(aviso); return { totalSuccess: 1, totalFailures: 0 }; };
  const rodar = (pedido = { establishmentId: 'loja-1', userId: 'cli-1', userName: 'Nome do app' }, extra = {}) => avisarPedidoDeCupomUmaVez({
    db: falso.db,
    FieldValue,
    messaging,
    contar: (contagem) => contagens.push(contagem),
    enviarAvisoParaLoja,
    pedido,
    pedidoId: 'req-1',
    agora: DIA,
    ...extra,
  });
  return { ...falso, mensagens, contagens, avisosWeb, rodar };
}

test('RP-179 item 7: titulo com o nome do cadastro e o texto aprovado, no app e no navegador', async () => {
  const c = cenario();
  const resultado = await c.rodar();
  assert.deepEqual(resultado, { enviado: true, motivo: null });
  assert.deepEqual(avisoDePedidoDeCupom('Ana Paula'), { title: 'Ana Paula quer cupom', body: 'Quando houver cupons disponíveis.' });
  assert.equal(c.mensagens.length, 1);
  assert.deepEqual(c.mensagens[0].notification, { title: 'Ana Paula quer cupom', body: 'Quando houver cupons disponíveis.' });
  assert.equal(c.avisosWeb.length, 1);
  assert.equal(c.avisosWeb[0].title, 'Ana Paula quer cupom', 'o nome do cadastro, nao o userName que o app mandou');
  assert.equal(c.avisosWeb[0].body, 'Quando houver cupons disponíveis.');
  assert.ok(!JSON.stringify([c.mensagens, c.avisosWeb]).includes('Nome do app'));
});

test('RP-179 item 7: o navegador vai para /cupons pela mesma funcao dos outros avisos, com a loja e a origem', async () => {
  const c = cenario();
  await c.rodar();
  const [aviso] = c.avisosWeb;
  assert.equal(aviso.companyId, 'loja-1');
  assert.equal(aviso.url, '/cupons');
  assert.equal(aviso.origem, 'avisarPedidoDeCupom');
  assert.equal(aviso.tag, 'pedido-de-cupom-req-1');
  assert.deepEqual(aviso.data, { kind: 'pedido_de_cupom', companyId: 'loja-1' });
});

test('RP-179 item 7: so os aparelhos do dono (clientID = Users do dono), sem token repetido', async () => {
  const c = cenario();
  await c.rodar();
  assert.deepEqual(c.consultas.filter((q) => q.nome === 'FcmTokens'), [{ nome: 'FcmTokens', campo: 'clientID', op: '==', valor: 'dono-1' }]);
  assert.deepEqual(c.mensagens[0].tokens, ['tok-ios', 'tok-android']);
});

test('RP-179 item 7: som padrao do aparelho e sem click_action; data.kind para o proximo build abrir Cupons', async () => {
  const c = cenario();
  await c.rodar();
  const [mensagem] = c.mensagens;
  assert.deepEqual(mensagem.apns.payload.aps, { sound: 'default' });
  assert.equal(mensagem.android.notification.defaultSound, true);
  assert.equal(mensagem.android.notification.sound, undefined, 'sem o ding');
  assert.equal(mensagem.android.notification.channelId, undefined, 'sem o canal do ding');
  assert.deepEqual(mensagem.data, { kind: 'pedido_de_cupom', companyId: 'loja-1' });
  assert.deepEqual(mensagem.android.data, mensagem.data);
  const texto = JSON.stringify(mensagem);
  assert.ok(!texto.includes('click_action') && !texto.includes('clickAction'), 'sem click_action');
  assert.ok(!texto.includes('ding'));
  // Mesmo formato direto pela funcao.
  const direta = mensagemDoAppDoLojista(['x'], { title: 't', body: 'b', data: { kind: 'k' } });
  assert.deepEqual(direta.apns.payload.aps, { sound: 'default' });
});

test('RP-179 item 7: no maximo um aviso por cliente e loja por dia de Sao Paulo, mesmo com toques ao mesmo tempo', async () => {
  const c = cenario();
  const resultados = await Promise.all([c.rodar(), c.rodar(), c.rodar()]);
  assert.equal(resultados.filter((r) => r.enviado).length, 1);
  assert.deepEqual(resultados.filter((r) => !r.enviado).map((r) => r.motivo), ['ja_avisado_hoje', 'ja_avisado_hoje']);
  assert.equal(c.mensagens.length, 1);
  assert.equal(c.avisosWeb.length, 1);
  assert.equal(c.criados.length, 1);
  assert.equal(c.criados[0].caminho, `${COLECAO_DE_AVISOS}/loja-1_cli-1_2026-11-14`);
  assert.equal(chaveDoAviso({ lojaId: 'loja-1', clienteId: 'cli-1', dia: '2026-11-14' }), 'loja-1_cli-1_2026-11-14');
  assert.ok(!JSON.stringify(c.criados[0].dados).includes('Ana'), 'a marca nao guarda o nome');

  // 23h30 de Sao Paulo ainda e o dia 14 (02h30 UTC do dia 15); 00h10 ja e o dia 15.
  assert.equal((await c.rodar(undefined, { agora: new Date('2026-11-15T02:30:00Z') })).motivo, 'ja_avisado_hoje');
  assert.equal((await c.rodar(undefined, { agora: new Date('2026-11-15T03:10:00Z') })).enviado, true);
  // Outro cliente e outra loja no mesmo dia avisam.
  c.banco.set('Users/cli-2', { name: 'Bruno' });
  c.banco.set('estabelecimentos/loja-2', { userReference: { id: 'dono-1' } });
  assert.equal((await c.rodar({ establishmentId: 'loja-1', userId: 'cli-2', userName: 'Bruno' })).enviado, true);
  assert.equal((await c.rodar({ establishmentId: 'loja-2', userId: 'cli-1', userName: 'Ana' })).enviado, true);
});

test('RP-179 item 7: sem nome no cadastro nao manda nada, nao reserva o dia e registra no log', async () => {
  for (const usuario of [undefined, { id: 'cli-1' }, { name: '   ' }, { name: '<b></b>' }]) {
    const c = cenario({ documentos: { 'Users/cli-1': usuario } });
    const avisos = [];
    const original = console.warn;
    console.warn = (...args) => avisos.push(args.join(' '));
    let resultado;
    try {
      resultado = await c.rodar();
    } finally {
      console.warn = original;
    }
    assert.deepEqual(resultado, { enviado: false, motivo: 'sem_nome' }, JSON.stringify(usuario));
    assert.equal(c.mensagens.length, 0);
    assert.equal(c.avisosWeb.length, 0);
    assert.equal(c.criados.length, 0);
    assert.equal(c.contagens.length, 0);
    assert.ok(avisos.some((linha) => linha.includes('sem nome no cadastro')));
  }
  assert.equal(nomeDoCadastro({ name: '  Ana   D\'Ávila ' }), 'Ana D\'Ávila');
  assert.equal(nomeDoCadastro({ nome: 'Cadastro antigo' }), 'Cadastro antigo');
});

test('RP-179 item 7: pedido com loja ou cliente invalido, ou loja inexistente, nao avisa', async () => {
  const c = cenario();
  assert.equal((await c.rodar({ establishmentId: 'a/b', userId: 'cli-1' })).motivo, 'pedido_invalido');
  assert.equal((await c.rodar({ establishmentId: 'loja-1' })).motivo, 'pedido_invalido');
  assert.equal((await c.rodar({ establishmentId: 'loja-x', userId: 'cli-1', userName: 'Ana' })).motivo, 'loja_inexistente');
  assert.equal(c.mensagens.length + c.avisosWeb.length + c.criados.length, 0);
});

test('RP-179 item 7 (Thay, 14/11): pedido sem nome (ausente, vazio ou so espacos) e ignorado, mesmo com nome no cadastro', async () => {
  for (const userName of [undefined, null, '', '   ', '\t \n', 7]) {
    const c = cenario();
    const avisos = [];
    const original = console.warn;
    console.warn = (...args) => avisos.push(args.join(' '));
    let resultado;
    try {
      resultado = await c.rodar({ establishmentId: 'loja-1', userId: 'cli-1', userName });
    } finally {
      console.warn = original;
    }
    assert.deepEqual(resultado, { enviado: false, motivo: 'pedido_sem_nome' }, JSON.stringify(userName));
    assert.equal(c.mensagens.length, 0);
    assert.equal(c.avisosWeb.length, 0);
    assert.equal(c.criados.length, 0, 'nao reserva o dia');
    assert.equal(c.contagens.length, 0);
    assert.ok(avisos.some((linha) => linha.includes('sem nome; ignorado')));
  }
  // Com nome no pedido, o titulo continua com o nome do cadastro.
  const c = cenario();
  const resultado = await c.rodar({ establishmentId: 'loja-1', userId: 'cli-1', userName: ' Ana ' });
  assert.equal(resultado.enviado, true);
  assert.equal(c.avisosWeb[0].title, 'Ana Paula quer cupom');
});

test('RP-179 item 7: dono sem aparelho conta sem_token e o navegador ainda recebe; loja sem dono so o navegador', async () => {
  const semAparelho = cenario({ documentos: { 'FcmTokens/t1': undefined, 'FcmTokens/t2': undefined, 'FcmTokens/t3': undefined } });
  [...semAparelho.banco.keys()].filter((k) => semAparelho.banco.get(k) === undefined).forEach((k) => semAparelho.banco.delete(k));
  await semAparelho.rodar();
  assert.equal(semAparelho.mensagens.length, 0);
  assert.equal(semAparelho.avisosWeb.length, 1);
  assert.deepEqual(semAparelho.contagens, [{
    loja: 'loja-1', origem: 'avisarPedidoDeCupom', audiencia: 'lojista',
    contagens: [{ plataforma: 'nenhuma', resultado: 'sem_token', vezes: 1 }], codigos: {},
  }]);

  const semDono = cenario({ documentos: { 'estabelecimentos/loja-1': { name: 'Loja' } } });
  await semDono.rodar();
  assert.equal(semDono.mensagens.length, 0);
  assert.equal(semDono.avisosWeb.length, 1);
});

test('RP-179 item 7: o resultado do envio conta em PushResumo por plataforma, sem token nem texto', async () => {
  const c = cenario({ respostas: [{ success: true }, { success: false, error: { code: 'messaging/registration-token-not-registered' } }] });
  await c.rodar();
  assert.equal(c.contagens.length, 1);
  const [contagem] = c.contagens;
  assert.equal(contagem.loja, 'loja-1');
  assert.equal(contagem.origem, 'avisarPedidoDeCupom');
  assert.equal(contagem.audiencia, 'lojista');
  assert.deepEqual(contagem.contagens, [
    { plataforma: 'ios', resultado: 'aceito', vezes: 1 },
    { plataforma: 'android', resultado: 'token_inexistente', vezes: 1 },
  ]);
  const texto = JSON.stringify(contagem);
  ['tok-', 'Ana', 'cupons disp'].forEach((trecho) => assert.ok(!texto.includes(trecho), trecho));
});

test('RP-179 item 7: falha no envio ao app conta a falha e o navegador ainda recebe; falha no navegador nao derruba', async () => {
  const erro = Object.assign(new Error('fora do ar'), { code: 'messaging/internal-error' });
  const c = cenario({ falhaNoMessaging: erro });
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal((await c.rodar()).enviado, true);
  } finally {
    console.error = original;
  }
  assert.equal(c.avisosWeb.length, 1);
  assert.deepEqual(c.contagens[0].codigos, { messaging_internal_error: 2 });

  const d = cenario();
  console.error = () => {};
  try {
    const resultado = await d.rodar(undefined, { enviarAvisoParaLoja: async () => { throw new Error('web caiu'); } });
    assert.equal(resultado.enviado, true);
  } finally {
    console.error = original;
  }
  assert.equal(d.mensagens.length, 1);
});

test('RP-179 item 7: a contagem nunca segura o envio (contar nao e esperado) e contar que lanca nao derruba', async () => {
  const c = cenario();
  let contou = false;
  const resultado = await c.rodar(undefined, {
    contar: () => { contou = true; return new Promise(() => {}); }, // gravacao que nunca termina
  });
  assert.equal(resultado.enviado, true);
  assert.equal(contou, true);
  assert.equal(c.avisosWeb.length, 1, 'o navegador saiu sem esperar a contagem do app');

  const d = cenario();
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal((await d.rodar(undefined, { contar: () => { throw new Error('contagem quebrou'); } })).enviado, true);
  } finally {
    console.error = original;
  }
  assert.equal(d.avisosWeb.length, 1);
});

test('RP-179 item 7 index.js: gatilho na criacao de CouponRequests, contagem sem esperar e espera no fim', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const inicio = index.indexOf('exports.avisarPedidoDeCupom = onDocumentCreated(');
  assert.ok(inicio > 0);
  const gatilho = index.slice(inicio, index.indexOf('async function loadStoreOrders'));
  assert.ok(gatilho.includes("'CouponRequests/{requestId}'"));
  assert.ok(gatilho.includes('contar: (contagem) => contarSemEsperar(gravarResultadoDosEnvios({'));
  assert.ok(gatilho.includes('enviarAvisoParaLoja,'));
  assert.ok(!/await contar/.test(gatilho));
  assert.match(gatilho, /\} finally \{\s+await esperarContagens\(\);\s+\}/);
  const modulo = fs.readFileSync(path.join(__dirname, 'avisoDeCupom.js'), 'utf8');
  assert.ok(!/await contar\(/.test(modulo), 'o envio nunca espera a contagem');
});
