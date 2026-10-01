const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CAMPO,
  indiceDeUsuarios,
  provedoresDaConta,
  rodarProvedoresDeLogin,
} = require('./provedoresDeLogin');

function conta(uid, provedores) {
  return { uid, providerData: provedores.map((providerId) => ({ providerId })) };
}

// Documento de Users de mentira: o get devolve os dois campos que a rotina le.
function documento(id, { userAuthId = null, provedoresDeLogin = undefined } = {}) {
  const dados = { userAuthId, [CAMPO]: provedoresDeLogin };
  return { id, get: (campo) => dados[campo] };
}

function cenario({ contas = [], documentos = [] } = {}) {
  const gravacoes = [];
  return {
    gravacoes,
    async rodar() {
      return rodarProvedoresDeLogin({
        listarContas: async () => ({ contas }),
        lerUsuarios: async () => documentos,
        gravar: async ({ id, provedores }) => { gravacoes.push({ id, provedores }); },
      });
    },
  };
}

test('conta com um provedor grava o valor cru do Firebase', async () => {
  const c = cenario({
    contas: [conta('uid-1', ['phone'])],
    documentos: [documento('cliente-1', { userAuthId: 'uid-1' })],
  });

  const resumo = await c.rodar();

  assert.deepEqual(c.gravacoes, [{ id: 'cliente-1', provedores: ['phone'] }]);
  assert.equal(resumo.escritas, 1);
  assert.equal(resumo.comCadastro, 1);
  assert.deepEqual(resumo.porProvedor, { phone: 1 });
});

test('conta com dois provedores guarda a lista, nao um deles', async () => {
  const c = cenario({
    contas: [conta('uid-2', ['password', 'google.com'])],
    documentos: [documento('cliente-2', { userAuthId: 'uid-2' })],
  });

  await c.rodar();

  assert.deepEqual(c.gravacoes[0].provedores, ['google.com', 'password'], 'ordenado, sem repetir');
});

test('conta anonima grava lista vazia, que e diferente de campo ausente', async () => {
  const c = cenario({
    contas: [conta('uid-3', [])],
    documentos: [documento('cliente-3', { userAuthId: 'uid-3' })],
  });

  const resumo = await c.rodar();

  assert.deepEqual(c.gravacoes, [{ id: 'cliente-3', provedores: [] }]);
  assert.equal(resumo.anonimas, 1);
  assert.deepEqual(provedoresDaConta(conta('x', [])), []);
});

test('conta sem documento em Users nao gera escrita', async () => {
  const c = cenario({
    contas: [conta('uid-4', ['apple.com'])],
    documentos: [documento('cliente-9', { userAuthId: 'uid-outro' })],
  });

  const resumo = await c.rodar();

  assert.deepEqual(c.gravacoes, []);
  assert.equal(resumo.semCadastro, 1);
  assert.equal(resumo.comCadastro, 0);
  // o provedor ainda e contado: o resumo e do Authentication, nao de Users
  assert.deepEqual(resumo.porProvedor, { 'apple.com': 1 });
});

test('cadastro alcancavel so pelo id do documento tambem e gravado', async () => {
  const c = cenario({
    contas: [conta('uid-5', ['google.com'])],
    documentos: [documento('uid-5')],
  });

  await c.rodar();

  assert.deepEqual(c.gravacoes, [{ id: 'uid-5', provedores: ['google.com'] }]);
});

test('valor que nao mudou nao gera escrita, nem para lista vazia', async () => {
  const c = cenario({
    contas: [conta('uid-6', ['phone']), conta('uid-7', [])],
    documentos: [
      documento('cliente-6', { userAuthId: 'uid-6', provedoresDeLogin: ['phone'] }),
      documento('cliente-7', { userAuthId: 'uid-7', provedoresDeLogin: [] }),
    ],
  });

  const resumo = await c.rodar();

  assert.deepEqual(c.gravacoes, []);
  assert.equal(resumo.semMudanca, 2);
  assert.equal(resumo.escritas, 0);
});

test('valor que mudou de um provedor para dois gera escrita', async () => {
  const c = cenario({
    contas: [conta('uid-8', ['google.com', 'password'])],
    documentos: [documento('cliente-8', { userAuthId: 'uid-8', provedoresDeLogin: ['google.com'] })],
  });

  const resumo = await c.rodar();

  assert.deepEqual(c.gravacoes, [{ id: 'cliente-8', provedores: ['google.com', 'password'] }]);
  assert.equal(resumo.escritas, 1);
});

test('o indice cobre os dois caminhos e o campo userAuthId tem prioridade', () => {
  const indice = indiceDeUsuarios([
    documento('cliente-10', { userAuthId: 'uid-10' }),
    documento('uid-11'),
  ]);

  assert.equal(indice.procurar('uid-10').id, 'cliente-10');
  assert.equal(indice.procurar('uid-11').id, 'uid-11');
  assert.equal(indice.procurar('uid-ausente'), null);
});

test('paginacao: duas paginas de contas sao percorridas', async () => {
  const gravacoes = [];
  const resumo = await rodarProvedoresDeLogin({
    listarContas: async ({ pageToken }) => (pageToken
      ? { contas: [conta('uid-b', ['apple.com'])] }
      : { contas: [conta('uid-a', ['phone'])], pageToken: 'proxima' }),
    lerUsuarios: async () => [
      documento('cliente-a', { userAuthId: 'uid-a' }),
      documento('cliente-b', { userAuthId: 'uid-b' }),
    ],
    gravar: async (entrada) => { gravacoes.push(entrada.id); },
  });

  assert.deepEqual(gravacoes, ['cliente-a', 'cliente-b']);
  assert.equal(resumo.contas, 2);
});

// A marca da loja como critério de desempate em documentoDe.
function docMarca(id, userAuthId, whitelabelId) {
  const dados = { userAuthId, whitelabelId };
  return { id, get: (campo) => dados[campo] };
}

test('uma copia com a marca da loja resolve, mesmo havendo outras marcas', () => {
  const indice = indiceDeUsuarios([
    docMarca('copia-zero', 'uid-1', 'br.com.zero.grau'),
    docMarca('copia-uau', 'uid-1', 'br.com.uaumart'),
    docMarca('copia-sem-marca', 'uid-1', null),
  ]);

  assert.equal(indice.documentoDe('uid-1', 'br.com.zero.grau'), 'copia-zero');
  assert.equal(indice.documentoDe('uid-1', 'br.com.uaumart'), 'copia-uau');
});

test('loja sem marca, ou marca que nao casa, cai no comportamento antigo', () => {
  const duas = indiceDeUsuarios([
    docMarca('copia-a', 'uid-2', 'br.com.zero.grau'),
    docMarca('copia-b', 'uid-2', 'br.com.uaumart'),
  ]);
  const uma = indiceDeUsuarios([docMarca('copia-unica', 'uid-3', 'br.com.outra')]);

  // duas copias e nenhuma da marca pedida: nulo, como antes
  assert.equal(duas.documentoDe('uid-2', 'br.com.gsatacarejo'), null);
  assert.equal(duas.documentoDe('uid-2', null), null);
  // uma copia so resolve, com marca diferente ou sem marca na loja
  assert.equal(uma.documentoDe('uid-3', 'br.com.gsatacarejo'), 'copia-unica');
  assert.equal(uma.documentoDe('uid-3', null), 'copia-unica');
});

test('duas copias na mesma marca da loja: ambiguidade de verdade, nulo', () => {
  const indice = indiceDeUsuarios([
    docMarca('copia-1', 'uid-4', 'br.com.zero.grau'),
    docMarca('copia-2', 'uid-4', 'br.com.zero.grau'),
  ]);

  assert.equal(indice.documentoDe('uid-4', 'br.com.zero.grau'), null);
});

test('copia sem whitelabelId nao casa pela marca, mas resolve quando e a unica', () => {
  const comOutra = indiceDeUsuarios([
    docMarca('sem-marca', 'uid-5', null),
    docMarca('com-marca', 'uid-5', 'br.com.zero.grau'),
  ]);
  const sozinha = indiceDeUsuarios([docMarca('sem-marca-2', 'uid-6', null)]);

  assert.equal(comOutra.documentoDe('uid-5', 'br.com.zero.grau'), 'com-marca');
  assert.equal(comOutra.documentoDe('uid-5', 'br.com.uaumart'), null, 'duas copias, nenhuma da marca');
  assert.equal(sozinha.documentoDe('uid-6', 'br.com.zero.grau'), 'sem-marca-2');
});

test('uid que e o proprio id do documento continua resolvendo', () => {
  const indice = indiceDeUsuarios([docMarca('uid-7', null, 'br.com.zero.grau')]);

  assert.equal(indice.documentoDe('uid-7', 'br.com.zero.grau'), 'uid-7');
  assert.equal(indice.documentoDe('uid-7', null), 'uid-7');
});
