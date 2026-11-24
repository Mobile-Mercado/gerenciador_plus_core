const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DIAS_SEM_USO, limiteDeUso, limparSessoesSemUsoDaLoja } = require('./sessoesWeb');

// Item 5.10 "Acessos conectados": limpeza de 7 dias sem uso. Falham com o codigo de antes:
// sessoesWeb.js e a rotina limparSessoesWebSemUso nao existiam.

const AGORA = new Date('2026-12-01T07:20:00.000Z'); // 04:20 em Sao Paulo
const DIA = 24 * 60 * 60 * 1000;

function bancoFalso(sessoes) {
  const docs = new Map(Object.entries(sessoes).map(([id, dados]) => [`estabelecimentos/loja-1/SessoesWeb/${id}`, dados]));
  const consultas = [];
  const ref = (caminho) => ({ path: caminho, collection: (nome) => colecao(`${caminho}/${nome}`) });
  const colecao = (caminho) => ({
    doc: (id) => ref(`${caminho}/${id}`),
    where: (campo, op, valor) => {
      consultas.push({ caminho, campo, op, valor });
      return {
        get: async () => ({
          docs: [...docs.entries()]
            .filter(([chave, dados]) => chave.startsWith(`${caminho}/`) && dados.ultimoUso < valor)
            .map(([chave]) => ({ ref: ref(chave) })),
        }),
      };
    },
  });
  const db = {
    collection: (nome) => colecao(nome),
    batch: () => {
      const apagar = [];
      return { delete: (r) => apagar.push(r.path), commit: async () => apagar.forEach((caminho) => docs.delete(caminho)) };
    },
  };
  return { db, docs, consultas };
}

test('5.10: limpeza apaga so a sessao com ultimoUso de mais de 7 dias (inclusive a ja encerrada)', async () => {
  const { db, docs, consultas } = bancoFalso({
    velha: { ultimoUso: new Date(AGORA - 8 * DIA), encerradaEm: null },
    encerradaVelha: { ultimoUso: new Date(AGORA - 30 * DIA), encerradaEm: new Date(AGORA - 29 * DIA) },
    noLimite: { ultimoUso: new Date(AGORA - 7 * DIA + 1000), encerradaEm: null },
    nova: { ultimoUso: new Date(AGORA - 60 * 1000), encerradaEm: null },
  });
  const resultado = await limparSessoesSemUsoDaLoja({ db, lojaId: 'loja-1', agora: AGORA });
  assert.deepEqual(resultado, { apagadas: 2 });
  assert.deepEqual([...docs.keys()].map((c) => c.split('/').at(-1)).sort(), ['noLimite', 'nova']);
  assert.equal(DIAS_SEM_USO, 7);
  assert.deepEqual(consultas.map(({ caminho, campo, op }) => [caminho, campo, op]), [['estabelecimentos/loja-1/SessoesWeb', 'ultimoUso', '<']]);
  assert.equal(limiteDeUso(AGORA).toISOString(), '2026-11-24T07:20:00.000Z');
});

test('5.10: rotina diaria no index.js, por loja, sem registrar IP nem id no log', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const bloco = index.slice(index.indexOf('exports.limparSessoesWebSemUso'), index.indexOf('exports.limparSessoesWebSemUso') + 1400);
  assert.match(bloco, /onSchedule\(/);
  assert.match(bloco, /schedule: '20 4 \* \* \*'/);
  assert.match(bloco, /timeZone: 'America\/Sao_Paulo'/);
  assert.match(bloco, /limparSessoesSemUsoDaLoja\(\{ db, lojaId: loja\.id, agora \}\)/);
  assert.ok(!/\bip\b/.test(bloco));
  const arquivo = fs.readFileSync(path.join(__dirname, 'sessoesWeb.js'), 'utf8');
  assert.ok(!arquivo.includes('console.'));
});
