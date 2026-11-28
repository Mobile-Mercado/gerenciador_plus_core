const test = require('node:test');
const assert = require('node:assert/strict');
const { blocosDe, idsDosDestinatarios, tokensDaLoja } = require('./destinatariosDaLoja');

// Os testes 1 e 2 sao iguais aos do mobile_old_web_platform (functions/destinatariosDaLoja.test.ts):
// as duas copias da regra nao mudam uma sem a outra (cola B57-18g, item 1).

const grupos = new Map([
  ['g-separador', { name: 'Separador', permissions: ['requests.view', 'requests.remove_item'] }],
  ['g-admin', { name: 'Administrador', isAdmin: true }],
  ['g-caixa', { name: 'Caixa', permissions: ['products.view'] }],
]);

test('B57-18g item 1: so o dono quando nao ha funcionario', () => {
  assert.deepEqual(idsDosDestinatarios('dono-1', [], grupos), ['dono-1']);
});

test('B57-18g item 1: dono primeiro; entra quem tem Ver pedidos ou e Administrador, mesmo sem chave', () => {
  const funcionarios = [
    { uid: 'f-sep', active: true, groupId: 'g-separador' },
    { uid: 'f-adm', groupId: 'g-admin' }, // sem o campo active: entra
    { uid: 'f-caixa', active: true, groupId: 'g-caixa' }, // sem requests.view: fora
    { uid: 'f-inativo', active: false, groupId: 'g-separador' }, // desativado: fora
    { uid: 'f-sem-grupo', active: true, groupId: 'g-apagado' }, // grupo inexistente: fora
    { uid: 'f-nulo', active: true }, // sem grupo: fora
    { uid: 'dono-1', active: true, groupId: 'g-admin' }, // o proprio dono: nao repete
    { uid: 'f-sep', active: true, groupId: 'g-separador' }, // repetido: nao repete
  ];
  assert.deepEqual(idsDosDestinatarios('dono-1', funcionarios, grupos), ['dono-1', 'f-sep', 'f-adm']);
});

test('B57-18g item 1: sem dono, so os funcionarios que podem', () => {
  assert.deepEqual(idsDosDestinatarios('', [{ uid: 'f-sep', groupId: 'g-separador' }], grupos), ['f-sep']);
});

test('B57-18g item 1: blocos de 30 para o "in"', () => {
  const ids = (n) => Array.from({ length: n }, (_, i) => `u${i}`);
  assert.equal(blocosDe(ids(0)).length, 0);
  assert.equal(blocosDe(ids(30)).length, 1);
  assert.equal(blocosDe(ids(31)).length, 2);
  assert.equal(blocosDe(ids(61)).length, 3);
  assert.deepEqual(blocosDe(ids(61)).map((b) => b.length), [30, 30, 1]);
  assert.deepEqual(blocosDe(ids(61)).flat(), ids(61));
});

// Banco de mentira: documentos por caminho; collection(caminho).get() lista os filhos diretos;
// where('clientID', 'in', lista) em FcmTokens; getAll(...refs) le varios documentos.
function bancoFalso(documentos = {}, { falhaEm = null } = {}) {
  const banco = new Map(Object.entries(documentos));
  const consultas = [];
  const filhos = (colecao) => [...banco.entries()]
    .filter(([caminho]) => caminho.startsWith(`${colecao}/`) && caminho.split('/').length === colecao.split('/').length + 1);
  const doc = (caminho) => ({ id: caminho.split('/').at(-1), path: caminho });
  const db = {
    doc,
    collection: (colecao) => ({
      async get() {
        consultas.push({ colecao });
        if (falhaEm && colecao.endsWith(falhaEm)) throw new Error('leitura negada');
        return { docs: filhos(colecao).map(([caminho, dados]) => ({ id: caminho.split('/').at(-1), data: () => dados })) };
      },
      where: (campo, op, valor) => ({
        async get() {
          consultas.push({ colecao, campo, op, valor });
          const docs = filhos(colecao)
            .filter(([, dados]) => (op === 'in' ? valor.includes(dados?.[campo]) : dados?.[campo] === valor))
            .map(([caminho, dados]) => ({ id: caminho.split('/').at(-1), data: () => dados }));
          return { docs };
        },
      }),
    }),
    async getAll(...refs) {
      consultas.push({ getAll: refs.map((r) => r.path) });
      if (falhaEm === 'PermissionGroups') throw new Error('leitura negada');
      return refs.map((r) => ({ id: r.id, exists: banco.has(r.path), data: () => banco.get(r.path) }));
    },
  };
  return { db, banco, consultas };
}

function semLog(fn) {
  const original = console.error;
  const linhas = [];
  console.error = (...args) => linhas.push(args.join(' '));
  return Promise.resolve(fn()).finally(() => { console.error = original; }).then((r) => ({ r, linhas }));
}

const LOJA = 'estabelecimentos/loja-1';

test('B57-18g item 1: tokens do dono e dos funcionarios, sem repetir, com a plataforma', async () => {
  const { db, consultas } = bancoFalso({
    [`${LOJA}/AdminUsers/f-sep`]: { active: true, groupId: 'g-sep' },
    [`${LOJA}/AdminUsers/f-caixa`]: { active: true, groupId: 'g-caixa' },
    [`${LOJA}/PermissionGroups/g-sep`]: { permissions: ['requests.view'] },
    [`${LOJA}/PermissionGroups/g-caixa`]: { permissions: [] },
    'FcmTokens/a': { clientID: 'dono-1', token: 'tok-dono', platform: 'ios' },
    'FcmTokens/b': { clientID: 'f-sep', token: 'tok-dono', platform: 'ios' }, // mesmo aparelho
    'FcmTokens/c': { clientID: 'f-sep', token: 'tok-sep', platform: 'android' },
    'FcmTokens/d': { clientID: 'f-caixa', token: 'tok-caixa', platform: 'android' },
    'FcmTokens/e': { clientID: 'dono-1', token: '  ' }, // vazio: fora
  });
  const { tokens, plataformas } = await tokensDaLoja(db, 'loja-1', 'dono-1');
  assert.deepEqual(tokens, ['tok-dono', 'tok-sep']);
  assert.deepEqual(plataformas, ['ios', 'android']);
  assert.deepEqual(consultas.filter((q) => q.colecao === 'FcmTokens'), [
    { colecao: 'FcmTokens', campo: 'clientID', op: 'in', valor: ['dono-1', 'f-sep'] },
  ]);
  // So os grupos dos funcionarios ativos, cada um uma vez.
  assert.deepEqual(consultas.find((q) => q.getAll).getAll.sort(), [`${LOJA}/PermissionGroups/g-caixa`, `${LOJA}/PermissionGroups/g-sep`]);
});

test('B57-18g item 1: dono sem funcionario faz uma consulta "in" so com ele e nao le grupos', async () => {
  const { db, consultas } = bancoFalso({ 'FcmTokens/a': { clientID: 'dono-1', token: 'tok-dono', platform: 'ios' } });
  const { tokens } = await tokensDaLoja(db, 'loja-1', 'dono-1');
  assert.deepEqual(tokens, ['tok-dono']);
  assert.equal(consultas.some((q) => q.getAll), false);
  assert.deepEqual(consultas.filter((q) => q.colecao === 'FcmTokens').map((q) => q.valor), [['dono-1']]);
});

test('B57-18g item 1: 31 destinatarios fazem 2 consultas "in"', async () => {
  const documentos = { [`${LOJA}/PermissionGroups/g`]: { permissions: ['requests.view'] } };
  for (let i = 0; i < 30; i++) {
    documentos[`${LOJA}/AdminUsers/f${i}`] = { groupId: 'g' };
    documentos[`FcmTokens/t${i}`] = { clientID: `f${i}`, token: `tok-${i}` };
  }
  documentos['FcmTokens/dono'] = { clientID: 'dono-1', token: 'tok-dono' };
  const { db, consultas } = bancoFalso(documentos);
  const { tokens } = await tokensDaLoja(db, 'loja-1', 'dono-1');
  const emFcm = consultas.filter((q) => q.colecao === 'FcmTokens');
  assert.deepEqual(emFcm.map((q) => q.valor.length), [30, 1]);
  assert.equal(emFcm[0].valor[0], 'dono-1');
  assert.equal(tokens.length, 31);
});

test('B57-18g item 1: falha ao ler AdminUsers ou os grupos devolve so os tokens do dono, com log', async () => {
  for (const falhaEm of ['AdminUsers', 'PermissionGroups']) {
    const { db, consultas } = bancoFalso({
      [`${LOJA}/AdminUsers/f-sep`]: { groupId: 'g-sep' },
      [`${LOJA}/PermissionGroups/g-sep`]: { permissions: ['requests.view'] },
      'FcmTokens/a': { clientID: 'dono-1', token: 'tok-dono', platform: 'ios' },
      'FcmTokens/b': { clientID: 'f-sep', token: 'tok-sep' },
    }, { falhaEm });
    const { r, linhas } = await semLog(() => tokensDaLoja(db, 'loja-1', 'dono-1'));
    assert.deepEqual(r.tokens, ['tok-dono'], falhaEm);
    assert.deepEqual(consultas.filter((q) => q.colecao === 'FcmTokens').map((q) => q.valor), [['dono-1']]);
    assert.ok(linhas.some((l) => l.includes('loja-1') && l.includes('so o dono')), falhaEm);
  }
});
