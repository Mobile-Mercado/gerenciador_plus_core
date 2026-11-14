const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  MAX_REGISTROS_POR_APARELHO_POR_HORA,
  RegistroInvalido,
  cabemNoLimite,
  chaveDoLimite,
  codigoDeErro,
  gravarTentativas,
  listasFechadas,
  registrosPorLoja,
  resumirTentativas,
  resumoDoAparelho,
  rodarResumoDeLogin,
  validarChamada,
  validarRegistro,
} = require('./tentativasDeLogin');

// Banco de mentira: colecoes e documentos em memoria, com where por >=, < e ==, limit,
// get, set (com merge), create, delete e runTransaction.
function bancoFalso(inicial = {}) {
  const dados = new Map(Object.entries(inicial));
  let proximo = 0;
  const comparar = (valor) => (valor instanceof Date ? valor.getTime() : valor);
  const documento = (caminho) => ({
    id: caminho.split('/').at(-1),
    path: caminho,
    collection: (nome) => colecao(`${caminho}/${nome}`),
    async get() {
      const valor = dados.get(caminho);
      return {
        exists: valor !== undefined, id: caminho.split('/').at(-1), data: () => valor, get: (campo) => valor?.[campo],
      };
    },
    async set(valor, opcoes = {}) {
      dados.set(caminho, opcoes.merge ? { ...(dados.get(caminho) || {}), ...valor } : { ...valor });
    },
    async create(valor) {
      if (dados.has(caminho)) throw new Error(`ja existe ${caminho}`);
      dados.set(caminho, { ...valor });
    },
    async delete() { dados.delete(caminho); },
  });
  const consulta = (base, filtros = [], maximo = Infinity) => ({
    where: (campo, op, valor) => consulta(base, [...filtros, { campo, op, valor }], maximo),
    limit: (n) => consulta(base, filtros, n),
    async get() {
      const docs = [...dados.entries()]
        .filter(([caminho]) => caminho.startsWith(`${base}/`) && !caminho.slice(base.length + 1).includes('/'))
        .filter(([, valor]) => filtros.every(({ campo, op, valor: alvo }) => {
          const atual = comparar(valor[campo]);
          if (op === '>=') return atual >= comparar(alvo);
          if (op === '<') return atual < comparar(alvo);
          if (op === '==') return atual === comparar(alvo);
          throw new Error(op);
        }))
        .slice(0, maximo)
        .map(([caminho, valor]) => ({
          id: caminho.split('/').at(-1), ref: documento(caminho), data: () => valor, get: (campo) => valor[campo],
        }));
      return { docs, empty: !docs.length, size: docs.length };
    },
  });
  const colecao = (base) => ({
    ...consulta(base),
    doc: (id) => documento(`${base}/${id ?? `auto${(proximo += 1)}`}`),
  });
  return {
    dados,
    collection: (nome) => colecao(nome),
    async runTransaction(corpo) {
      const transacao = {
        get: (ref) => ref.get(),
        create: (ref, valor) => { dados.set(ref.path, { ...valor }); },
        set: (ref, valor, opcoes) => { ref.set(valor, opcoes); },
      };
      return corpo(transacao);
    },
  };
}

const LISTAS = listasFechadas([
  { id: 'zg', whitelabelId: 'br.com.zero.grau' },
  { id: 'gs', whitelabelId: 'br.com.gsatacarejo' },
  { id: 'sem-marca' },
]);
const AGORA = new Date('2026-11-14T15:00:00Z');

function registro(campos = {}) {
  return {
    tentativa: 'tent-0001',
    loja: 'zg',
    marca: 'br.com.zero.grau',
    metodo: 'telefone',
    plataforma: 'ios',
    versao: '1.0.37+58',
    etapa: 'pediu_codigo',
    ...campos,
  };
}

function validar(campos, extra = {}) {
  return validarRegistro(registro(campos), {
    ...LISTAS, aparelho: 'abc', agora: AGORA, ...extra,
  });
}

test('listas fechadas: as lojas do banco e as marcas delas, mais a do app geral', () => {
  assert.deepEqual([...LISTAS.lojas].sort(), ['gs', 'sem-marca', 'zg']);
  assert.deepEqual([...LISTAS.marcas].sort(), ['br.com.gsatacarejo', 'br.com.mobile.cliente', 'br.com.zero.grau']);
});

test('registro valido: os campos da cola, o aparelho resumido, a validade de 90 dias e nenhum uid antes do login', () => {
  const gravado = validar({}, { uidDoLogin: 'uid-anonimo' });
  assert.deepEqual(gravado, {
    tentativa: 'tent-0001',
    loja: 'zg',
    marca: 'br.com.zero.grau',
    metodo: 'telefone',
    plataforma: 'ios',
    versao: '1.0.37+58',
    etapa: 'pediu_codigo',
    erro: null,
    uid: null,
    aparelho: 'abc',
    em: AGORA,
    expiraEm: new Date('2027-02-12T15:00:00Z'),
  });
});

test('uid so no "entrou", e do token da chamada (o do corpo e ignorado)', () => {
  assert.equal(validar({ etapa: 'entrou', uid: 'do-corpo' }, { uidDoLogin: 'do-token' }).uid, 'do-token');
  assert.equal(validar({ etapa: 'entrou' }).uid, null);
  assert.equal(validar({ etapa: 'codigo_confirmado' }, { uidDoLogin: 'do-token' }).uid, null);
  assert.equal(validar({ uid: 'do-corpo' }).uid, null);
});

test('cada campo de lista fechada recusa o que nao esta na lista', () => {
  const recusa = (campos, campo) => assert.throws(() => validar(campos), (error) => error instanceof RegistroInvalido && error.message === campo);
  recusa({ metodo: 'facebook' }, 'metodo');
  recusa({ plataforma: 'web' }, 'plataforma');
  recusa({ etapa: 'digitou_o_telefone' }, 'etapa');
  recusa({ marca: 'br.com.outra' }, 'marca');
  recusa({ loja: 'loja-que-nao-existe' }, 'loja');
  recusa({ versao: 'um ponto zero' }, 'versao');
  recusa({ tentativa: 'curta' }, 'tentativa');
  recusa({ etapa: 'falhou' }, 'erro');
  recusa({ etapa: 'pediu_codigo', erro: 'unknown' }, 'erro');
  assert.equal(validar({ loja: null }).loja, null);
});

test('codigo do erro: minusculo, sem espaco, sem "@" e sem sequencia de 7 digitos (nada de telefone ou e-mail)', () => {
  assert.equal(codigoDeErro('Invalid-Verification-Code'), 'invalid-verification-code');
  assert.equal(codigoDeErro('google/canceled'), 'google/canceled');
  assert.equal(codigoDeErro('apple/unknown'), 'apple/unknown');
  assert.equal(codigoDeErro('internal-error-17999'), 'internal-error-17999');
  assert.equal(codigoDeErro('+5511987654321'), null);
  assert.equal(codigoDeErro('erro 11987654321'), null);
  assert.equal(codigoDeErro('fulano@gmail.com'), null);
  assert.equal(codigoDeErro('reCAPTCHA failed for ...'), null);
  assert.equal(codigoDeErro(''), null);
  assert.equal(validar({ etapa: 'falhou', erro: 'unknown' }).erro, 'unknown');
});

test('registro guardado sem internet: vale a hora do aparelho ate 7 dias; futuro ou mais velho vira a hora da chamada', () => {
  const ontem = new Date('2026-11-13T22:00:00Z');
  assert.deepEqual(validar({ quando: ontem.getTime() }).em, ontem);
  assert.deepEqual(validar({ quando: new Date('2026-11-01T00:00:00Z').getTime() }).em, AGORA);
  assert.deepEqual(validar({ quando: new Date('2026-11-14T16:00:00Z').getTime() }).em, AGORA);
});

test('chamada: aparelho e lista obrigatorios, no maximo 20 registros; o invalido fica fora com o motivo, sem o valor', () => {
  assert.throws(() => validarChamada({ registros: [registro()] }, { ...LISTAS, agora: AGORA }), /aparelho/);
  assert.throws(() => validarChamada({ aparelho: 'aparelho-01', registros: [] }, { ...LISTAS, agora: AGORA }), /registros/);
  assert.throws(() => validarChamada({ aparelho: 'aparelho-01', registros: Array(21).fill(registro()) }, { ...LISTAS, agora: AGORA }), /registros/);
  const chamada = validarChamada({
    aparelho: 'aparelho-01',
    registros: [registro(), registro({ metodo: 'facebook' }), registro({ etapa: 'falhou', erro: 'fulano@gmail.com' })],
  }, { ...LISTAS, agora: AGORA });
  assert.equal(chamada.validos.length, 1);
  assert.equal(chamada.invalidos, 2);
  assert.deepEqual(chamada.motivos, { metodo: 1, erro: 1 });
  assert.equal(chamada.aparelho, resumoDoAparelho('aparelho-01'));
  assert.equal(chamada.aparelho.length, 16);
  assert.notEqual(chamada.aparelho, 'aparelho-01');
});

test('limite por aparelho: 60 registros por hora; o que passa fica fora e e contado', async () => {
  assert.equal(MAX_REGISTROS_POR_APARELHO_POR_HORA, 60);
  assert.equal(cabemNoLimite(0, 4), 4);
  assert.equal(cabemNoLimite(58, 4), 2);
  assert.equal(cabemNoLimite(60, 4), 0);
  assert.equal(chaveDoLimite('abc', AGORA), 'abc_2026111415');

  const db = bancoFalso({ 'LoginAttemptsLimite/abc_2026111415': { registros: 58 } });
  const validos = [1, 2, 3].map((n) => validar({ tentativa: `tent-000${n}` }));
  const resultado = await gravarTentativas({
    db, validos, aparelho: 'abc', agora: AGORA, recebidoEm: 'agora-do-servidor',
  });
  assert.deepEqual(resultado, { gravados: 2, descartadosPeloLimite: 1 });
  const gravados = [...db.dados.entries()].filter(([caminho]) => caminho.startsWith('LoginAttempts/'));
  assert.equal(gravados.length, 2);
  assert.equal(gravados[0][1].recebidoEm, 'agora-do-servidor');
  assert.equal(db.dados.get('LoginAttemptsLimite/abc_2026111415').registros, 60);
});

function doDia(campos) {
  return { em: new Date('2026-11-13T15:00:00Z'), aparelho: 'ap1', ...registro(campos) };
}

test('resumo do dia: tentativas, entradas, falhas e sem resultado por metodo, plataforma, versao e codigo', () => {
  const resumo = resumirTentativas({
    dia: '2026-11-13',
    registros: [
      // SMS que entrou.
      doDia({ tentativa: 'sms-ok-01', etapa: 'pediu_codigo' }),
      doDia({ tentativa: 'sms-ok-01', etapa: 'codigo_enviado' }),
      doDia({ tentativa: 'sms-ok-01', etapa: 'codigo_confirmado' }),
      doDia({ tentativa: 'sms-ok-01', etapa: 'entrou' }),
      // SMS que falhou antes do codigo, no iPhone, de outro aparelho.
      doDia({ tentativa: 'sms-err-01', etapa: 'pediu_codigo', aparelho: 'ap2' }),
      doDia({ tentativa: 'sms-err-01', etapa: 'falhou', erro: 'unknown', aparelho: 'ap2' }),
      // Google cancelado no Android.
      doDia({ tentativa: 'goo-can-01', metodo: 'google', plataforma: 'android', versao: '1.0.36+55', etapa: 'falhou', erro: 'google/canceled' }),
      // Pediu o codigo e nao voltou.
      doDia({ tentativa: 'sms-sem-01', etapa: 'pediu_codigo' }),
    ],
  });
  assert.equal(resumo.registros, 8);
  assert.equal(resumo.tentativas, 4);
  assert.equal(resumo.entradas, 1);
  assert.equal(resumo.falhas, 2);
  assert.equal(resumo.semResultado, 1);
  assert.equal(resumo.canceladas, 1);
  assert.equal(resumo.aparelhos, 2);
  // ap1 falhou no Google mas entrou pelo SMS; ap2 so falhou.
  assert.equal(resumo.aparelhosSemEntrar, 1);
  assert.deepEqual(resumo.porMetodo.telefone, { tentativas: 3, entradas: 1, falhas: 1, semResultado: 1 });
  assert.deepEqual(resumo.porMetodo.google, { tentativas: 1, entradas: 0, falhas: 1, semResultado: 0 });
  assert.deepEqual(resumo.porMetodo.apple, { tentativas: 0, entradas: 0, falhas: 0, semResultado: 0 });
  assert.deepEqual(resumo.porPlataforma.ios, { tentativas: 3, entradas: 1, falhas: 1, semResultado: 1 });
  assert.deepEqual(resumo.porVersao.map((linha) => [linha.versao, linha.tentativas]), [['1.0.37+58', 3], ['1.0.36+55', 1]]);
  assert.deepEqual(resumo.porEtapa, {
    pediu_codigo: 3, codigo_enviado: 1, codigo_confirmado: 1, entrou: 1, falhou: 2,
  });
  assert.deepEqual(resumo.erros, [
    { erro: 'google/canceled', metodo: 'google', plataforma: 'android', vezes: 1 },
    { erro: 'unknown', metodo: 'telefone', plataforma: 'ios', vezes: 1 },
  ]);
  // Nada alem de contagem, codigo e versao: sem uid, sem aparelho, sem tentativa.
  const texto = JSON.stringify(resumo);
  ['sms-ok-01', 'ap1', 'ap2'].forEach((valor) => assert.ok(!texto.includes(valor), valor));
});

test('por loja: o registro da loja vai para ela; so com a marca, vai para a loja unica da marca', () => {
  const porLoja = registrosPorLoja({
    lojas: [{ id: 'zg', whitelabelId: 'br.com.zero.grau' }, { id: 'gs', whitelabelId: 'br.com.gsatacarejo' }, { id: 'gs2', whitelabelId: 'br.com.gsatacarejo' }],
    registros: [
      registro({ loja: 'zg' }),
      registro({ loja: null, marca: 'br.com.zero.grau' }),
      registro({ loja: null, marca: 'br.com.gsatacarejo' }),
      registro({ loja: 'gs2', marca: 'br.com.gsatacarejo' }),
      registro({ loja: 'fora-da-lista' }),
    ],
  });
  assert.equal(porLoja.get('zg').length, 2);
  assert.equal(porLoja.get('gs').length, 0);
  assert.equal(porLoja.get('gs2').length, 1);
});

test('rotina: grava LoginResumo/todas e o de cada loja no molde do resumo de buscas, e apaga o que passou de 90 dias', async () => {
  const db = bancoFalso({
    'LoginAttempts/a': { ...doDia({ etapa: 'falhou', erro: 'unknown' }) },
    'LoginAttempts/b': { ...doDia({ tentativa: 'tent-0002', loja: 'gs', marca: 'br.com.gsatacarejo', etapa: 'entrou' }) },
    'LoginAttempts/velho': { ...doDia({}), em: new Date('2026-08-01T12:00:00Z') },
    'LoginAttemptsLimite/x_2026111410': { registros: 3, expiraEm: new Date('2026-11-14T12:00:00Z') },
    'LoginResumo/zg': { dias: [{ dia: '2025-11-01', tentativas: 1, documento: false }] },
  });
  const resultado = await rodarResumoDeLogin({
    db,
    lojas: [{ id: 'zg', whitelabelId: 'br.com.zero.grau' }, { id: 'gs', whitelabelId: 'br.com.gsatacarejo' }],
    agora: AGORA,
    atualizadoEm: 'carimbo',
  });
  assert.equal(resultado.dia, '2026-11-13');
  assert.equal(resultado.tentativas, 2);
  assert.deepEqual(resultado.lojas, [
    { establishmentId: 'zg', tentativas: 1, falhas: 1 },
    { establishmentId: 'gs', tentativas: 1, falhas: 0 },
  ]);
  const todas = db.dados.get('LoginResumo/todas/dias/2026-11-13');
  assert.equal(todas.tentativas, 2);
  assert.equal(todas.atualizadoEm, 'carimbo');
  const topoZg = db.dados.get('LoginResumo/zg');
  // A linha de um ano atras sai do topo; a do dia entra.
  assert.deepEqual(topoZg.dias, [{
    dia: '2026-11-13', tentativas: 1, entradas: 0, falhas: 1, semResultado: 0, canceladas: 0, aparelhosSemEntrar: 1, documento: true,
  }]);
  assert.ok(db.dados.has('LoginResumo/gs/dias/2026-11-13'));
  assert.ok(!db.dados.has('LoginAttempts/velho'));
  assert.ok(db.dados.has('LoginAttempts/a'));
  assert.ok(!db.dados.has('LoginAttemptsLimite/x_2026111410'));
  assert.deepEqual(resultado.limpeza, { removidos: 1, limitesRemovidos: 1 });
});

test('RP-174: o resumo de cada loja fica em LoginResumo/{loja}, nunca em estabelecimentos (que a regra abre para conta logada)', async () => {
  const db = bancoFalso({
    'LoginAttempts/a': { ...doDia({ etapa: 'falhou', erro: 'unknown' }) },
  });
  const resultado = await rodarResumoDeLogin({
    db,
    lojas: [{ id: 'zg', whitelabelId: 'br.com.zero.grau' }, { id: 'todas', whitelabelId: 'x' }],
    agora: AGORA,
    atualizadoEm: 'carimbo',
    limpar: false,
  });
  const caminhos = [...db.dados.keys()].filter((caminho) => !caminho.startsWith('LoginAttempts/'));
  assert.ok(caminhos.length > 0);
  assert.ok(caminhos.every((caminho) => caminho.startsWith('LoginResumo/')), caminhos.join(','));
  assert.ok(db.dados.has('LoginResumo/zg/dias/2026-11-13'));
  // Um id de loja igual a "todas" nao grava por cima do resumo de todas.
  assert.deepEqual(resultado.lojas.at(-1), { establishmentId: 'todas', status: 'id-reservado' });
  assert.equal(db.dados.get('LoginResumo/todas/dias/2026-11-13').tentativas, 1);
});

test('RP-174: a linha da rotina em Stats/rotinasNoturnas (lido por conta logada) nao leva contagem de login', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const rotina = index.slice(index.indexOf('exports.summarizeLoginAttemptsNightly'), index.indexOf("console.log('[summarizeLoginAttemptsNightly] Passada concluida'"));
  assert.ok(rotina.includes("dados: { dia: resultado.dia, situacao: daLoja?.status || 'ok' },"));
  assert.ok(!/dados: {[^}]*(tentativas|falhas|entradas)/.test(rotina));
  assert.ok(!rotina.includes("collection('Stats')"));
});

test('index.js: registrarTentativaDeLogin aceita chamada sem login e so le o corpo pela validacao; resumo as 3h30, sozinho na faixa', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const callable = index.slice(index.indexOf('exports.registrarTentativaDeLogin = onCall('), index.indexOf('exports.summarizeLoginAttemptsNightly'));
  assert.ok(callable.includes('validarChamada(request.data'));
  assert.ok(callable.includes("uidDoLogin: request.auth?.uid || null"));
  assert.ok(!/if \(!request\.auth\)/.test(callable), 'nao exige login');
  assert.ok(!/console\.\w+\([^)]*request\.data/.test(callable), 'o corpo nao vai para o log');
  assert.match(index, /exports\.summarizeLoginAttemptsNightly = onSchedule\(\s+\{\s+schedule: '30 3 \* \* \*',\s+timeZone: 'America\/Sao_Paulo'/);
  const horarios = [...index.matchAll(/schedule: '([^']+)'/g)].map((achado) => achado[1]);
  assert.equal(horarios.filter((horario) => horario.startsWith('30 3 ')).length, 1);
});
