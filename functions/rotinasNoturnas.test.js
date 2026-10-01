const test = require('node:test');
const assert = require('node:assert/strict');
const {
  NOITES_GUARDADAS,
  REGISTRO_VERSION,
  noiteDe,
  origemEmPartes,
  registrarRotina,
} = require('./rotinasNoturnas');

// Firestore de mentira: so o documento Stats/rotinasNoturnas.
function firestoreFalso(guardado = null) {
  const registro = { documento: guardado, gravacoes: 0 };
  const doc = {
    async get() {
      return { exists: Boolean(registro.documento), get: (campo) => (registro.documento || {})[campo] };
    },
    async set(dados) { registro.gravacoes += 1; registro.documento = dados; },
  };
  return {
    registro,
    storeRef: { id: 'loja-1', collection: () => ({ doc: () => doc }) },
  };
}

test('a noite e o dia no fuso de Sao Paulo', () => {
  assert.equal(noiteDe(new Date('2026-10-01T05:30:00Z')), '2026-10-01');
  assert.equal(noiteDe(new Date('2026-10-01T02:30:00Z')), '2026-09-30', '23h30 de Sao Paulo ainda e dia 30');
});

test('a origem vira dois campos, com o motivo separado', () => {
  assert.deepEqual(origemEmPartes('espelho'), { origem: 'espelho' });
  assert.deepEqual(origemEmPartes('recuo:espelho-de-outro-dia'), { origem: 'recuo', motivo: 'espelho-de-outro-dia' });
  assert.deepEqual(origemEmPartes('recuo'), { origem: 'recuo', motivo: 'sem-motivo' });
  assert.deepEqual(origemEmPartes(''), { origem: 'desconhecida' });
});

test('grava uma linha por rotina, com a origem e o motivo', async () => {
  const { storeRef, registro } = firestoreFalso();

  await registrarRotina({
    storeRef, rotina: 'summarizeProductSearchesNightly', noite: '2026-10-01', origem: 'espelho', atualizadoEm: 'quando',
  });
  await registrarRotina({
    storeRef, rotina: 'verifyProductImageFilesNightly', noite: '2026-10-01', origem: 'recuo:blocos-nao-batem', atualizadoEm: 'quando',
  });

  assert.equal(registro.documento.version, REGISTRO_VERSION);
  assert.equal(registro.documento.noites.length, 2);
  assert.deepEqual(registro.documento.noites[0], {
    noite: '2026-10-01', rotina: 'summarizeProductSearchesNightly', origem: 'espelho',
  });
  assert.deepEqual(registro.documento.noites[1], {
    noite: '2026-10-01', rotina: 'verifyProductImageFilesNightly', origem: 'recuo', motivo: 'blocos-nao-batem',
  });
  assert.equal(registro.documento.primeiraNoite, '2026-10-01');
  assert.equal(registro.documento.ultimaNoite, '2026-10-01');
});

test('o espelho entra com o que gerou, sem origem', async () => {
  const { storeRef, registro } = firestoreFalso();

  await registrarRotina({
    storeRef,
    rotina: 'mirrorProductCatalogNightly',
    noite: '2026-10-01',
    dados: { produtos: 6410, blocos: 7 },
    atualizadoEm: 'quando',
  });

  assert.deepEqual(registro.documento.noites[0], {
    noite: '2026-10-01', rotina: 'mirrorProductCatalogNightly', produtos: 6410, blocos: 7,
  });
});

test('rodar a mesma rotina duas vezes na mesma noite substitui a linha', async () => {
  const { storeRef, registro } = firestoreFalso();

  await registrarRotina({
    storeRef, rotina: 'summarizeProductSearchesNightly', noite: '2026-10-01', origem: 'recuo:sem-indice', atualizadoEm: 'quando',
  });
  await registrarRotina({
    storeRef, rotina: 'summarizeProductSearchesNightly', noite: '2026-10-01', origem: 'espelho', atualizadoEm: 'quando',
  });

  assert.equal(registro.documento.noites.length, 1);
  assert.deepEqual(registro.documento.noites[0], {
    noite: '2026-10-01', rotina: 'summarizeProductSearchesNightly', origem: 'espelho',
  });
});

test('guarda as ultimas trinta noites e descarta as mais antigas', async () => {
  const antigas = [];
  for (let dia = 1; dia <= 31; dia += 1) {
    antigas.push({ noite: `2026-08-${String(dia).padStart(2, '0')}`, rotina: 'mirrorProductCatalogNightly', produtos: 1 });
  }
  const { storeRef, registro } = firestoreFalso({ noites: antigas });

  const resultado = await registrarRotina({
    storeRef, rotina: 'mirrorProductCatalogNightly', noite: '2026-10-01', dados: { produtos: 2, blocos: 1 }, atualizadoEm: 'quando',
  });

  assert.equal(NOITES_GUARDADAS, 30);
  assert.equal(resultado.noites, 30);
  const noites = registro.documento.noites.map((entrada) => entrada.noite);
  assert.equal(noites.length, 30);
  assert.ok(!noites.includes('2026-08-01'), 'a noite mais antiga saiu');
  assert.ok(!noites.includes('2026-08-02'), 'a segunda mais antiga tambem');
  assert.ok(noites.includes('2026-10-01'), 'a noite nova entrou');
  assert.equal(registro.documento.primeiraNoite, '2026-08-03');
  assert.equal(registro.documento.ultimaNoite, '2026-10-01');
});

test('quatro rotinas por trinta noites cabem com folga', async () => {
  const linhas = [];
  for (let dia = 1; dia <= 30; dia += 1) {
    ['mirrorProductCatalogNightly', 'verifyProductImageFilesNightly', 'summarizeAgentConversationsNightly', 'summarizeProductSearchesNightly']
      .forEach((rotina) => linhas.push({
        noite: `2026-09-${String(dia).padStart(2, '0')}`, rotina, origem: 'espelho', produtos: 8666, blocos: 9,
      }));
  }
  const { storeRef, registro } = firestoreFalso({ noites: linhas });

  await registrarRotina({
    storeRef, rotina: 'mirrorProductCatalogNightly', noite: '2026-09-30', dados: { produtos: 8666, blocos: 9 }, atualizadoEm: 'quando',
  });

  assert.equal(registro.documento.noites.length, 120);
  const bytes = Buffer.byteLength(JSON.stringify(registro.documento));
  assert.ok(bytes < 60 * 1024, `documento com ${bytes} bytes`);
});
