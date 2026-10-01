const test = require('node:test');
const assert = require('node:assert/strict');
const {
  diaAnterior,
  diaMenos,
  limitesDoDia,
  limiteDeRetencao,
  resumirBuscas,
  rodarResumoDeBuscas,
} = require('./buscasResumo');

const DIA = '2026-09-30';
const AGORA = new Date('2026-10-01T06:00:00Z');

function em(hora, minuto = 0) {
  // hora no fuso de Sao Paulo
  return { toDate: () => new Date(Date.UTC(2026, 8, 30, hora + 3, minuto, 0)) };
}

function busca(extra = {}) {
  return {
    termo: 'COCA COLA',
    termoNormalizado: 'coca cola',
    clienteId: 'cliente-1',
    resultados: 12,
    origem: 'app',
    em: em(10),
    ...extra,
  };
}

// Firestore de mentira: SearchLogs, o resumo de topo e a subcolecao dias, anotando a
// ordem das operacoes para o teste da limpeza.
function firestoreFalso({ logs = [], resumo = null, falharNaExclusao = false } = {}) {
  const registro = { ordem: [], gravados: {}, dias: {}, excluidos: [], diasExcluidos: [] };
  const documentos = logs.map((dados, indice) => ({
    id: `log-${indice}`,
    data: () => dados,
    get: (campo) => dados[campo],
    ref: {
      async delete() {
        if (falharNaExclusao) throw new Error('permissao negada');
        registro.ordem.push(`excluiu:log-${indice}`);
        registro.excluidos.push(indice);
      },
    },
  }));

  const consultaLogs = (filtros = [], limite = null) => ({
    where: (campo, operador, valor) => consultaLogs([...filtros, { campo, operador, valor }], limite),
    limit: (n) => consultaLogs(filtros, n),
    async get() {
      let achados = documentos.filter((documento) => filtros.every(({ operador, valor }) => {
        const quando = documento.data().em.toDate();
        if (operador === '>=') return quando >= valor;
        if (operador === '<') return quando < valor;
        return true;
      }));
      achados = achados.filter((documento) => !registro.excluidos.includes(Number(documento.id.split('-')[1])));
      if (limite) achados = achados.slice(0, limite);
      return { docs: achados, size: achados.length, empty: achados.length === 0 };
    },
  });

  const docDia = (dia) => ({
    async set(dados) { registro.ordem.push(`gravouDia:${dia}`); registro.dias[dia] = dados; },
    async delete() { registro.diasExcluidos.push(dia); delete registro.dias[dia]; },
  });

  const docResumo = {
    async get() {
      return { exists: Boolean(resumo), get: (campo) => (resumo || {})[campo] };
    },
    async set(dados) { registro.ordem.push('gravouResumo'); registro.gravados.resumo = dados; },
    collection: () => ({ doc: docDia }),
  };

  return {
    registro,
    storeRef: {
      collection: (nome) => {
        if (nome === 'SearchLogs') return consultaLogs();
        if (nome === 'Stats') return { doc: () => docResumo };
        throw new Error(`colecao inesperada: ${nome}`);
      },
    },
  };
}

test('o dia do resumo e o anterior, no fuso de Sao Paulo', () => {
  assert.equal(diaAnterior(AGORA), DIA);
  // 1h de Sao Paulo no dia 1 ainda resume o dia 30
  assert.equal(diaAnterior(new Date('2026-10-01T04:00:00Z')), DIA);
  const { inicio, fim } = limitesDoDia(DIA);
  assert.equal(inicio.toISOString(), '2026-09-30T03:00:00.000Z');
  assert.equal(fim.toISOString(), '2026-10-01T03:00:00.000Z');
  assert.equal(limiteDeRetencao(AGORA).toISOString(), '2026-07-03T06:00:00.000Z');
});

test('tres termos em sequencia do mesmo cliente continuam tres', () => {
  const resumo = resumirBuscas({
    dia: DIA,
    buscas: [
      busca({ termo: 'COCA COLA 1', em: em(9) }),
      busca({ termo: 'COCA COLA 1 LI', em: em(9, 1) }),
      busca({ termo: 'COCA COLA 1 LITRO', em: em(9, 2) }),
    ],
  });

  assert.equal(resumo.buscas, 3);
  assert.equal(resumo.termosDistintos, 3);
  assert.deepEqual(resumo.termos.map((t) => t.termo).sort(), ['COCA COLA 1', 'COCA COLA 1 LI', 'COCA COLA 1 LITRO']);
  assert.deepEqual(resumo.termos.map((t) => t.vezes), [1, 1, 1]);
  assert.equal(resumo.porCliente.length, 1);
  assert.equal(resumo.porCliente[0].termos.length, 3);
  assert.equal(resumo.porCliente[0].buscas, 3);
});

test('o mesmo texto repetido conta vezes, e a data da ultima e guardada', () => {
  const resumo = resumirBuscas({
    dia: DIA,
    buscas: [busca({ em: em(8) }), busca({ em: em(20) }), busca({ termo: 'ARROZ', em: em(9) })],
  });

  const coca = resumo.termos.find((t) => t.termo === 'COCA COLA');
  assert.equal(coca.vezes, 2);
  assert.deepEqual(coca.ultima, em(20).toDate());
  assert.equal(resumo.termos[0].termo, 'COCA COLA', 'ordenado por vezes');
  assert.equal(resumo.termosDistintos, 2);
});

test('busca sem cliente entra no total da loja e fica fora do por cliente', () => {
  const resumo = resumirBuscas({
    dia: DIA,
    buscas: [busca({ clienteId: null, termo: 'DETERGENTE' }), busca({ termo: 'DETERGENTE' })],
  });

  assert.equal(resumo.buscas, 2);
  assert.equal(resumo.termos.find((t) => t.termo === 'DETERGENTE').vezes, 2);
  assert.equal(resumo.clientes, 1);
  assert.equal(resumo.porCliente[0].buscas, 1);
});

test('busca sem resultado conta no total da loja e no termo', () => {
  const resumo = resumirBuscas({
    dia: DIA,
    buscas: [
      busca({ termo: 'QUIBOA', resultados: 0 }),
      busca({ termo: 'QUIBOA', resultados: 0 }),
      busca({ termo: 'ARROZ', resultados: 30 }),
    ],
  });

  assert.equal(resumo.buscas, 3);
  assert.equal(resumo.semResultado, 2);
  assert.equal(resumo.termos.find((t) => t.termo === 'QUIBOA').semResultado, 2);
  assert.equal(resumo.termos.find((t) => t.termo === 'ARROZ').semResultado, 0);
});

test('dia sem nenhuma busca grava resumo zerado, sem termos', async () => {
  const { storeRef, registro } = firestoreFalso({ logs: [] });

  const resultado = await rodarResumoDeBuscas({ storeRef, agora: AGORA, atualizadoEm: 'quando' });

  assert.equal(resultado.dia, DIA);
  assert.equal(resultado.buscas, 0);
  assert.equal(resultado.termosDistintos, 0);
  assert.deepEqual(registro.dias[DIA].termos, []);
  assert.deepEqual(registro.dias[DIA].porCliente, []);
  assert.equal(registro.gravados.resumo.dias.length, 1);
  assert.deepEqual(registro.gravados.resumo.dias[0], {
    dia: DIA, buscas: 0, semResultado: 0, termosDistintos: 0, clientes: 0, documento: true,
  });
});

test('o resumo acumula um dia por vez, sem apagar o historico', async () => {
  const anterior = {
    dias: [
      { dia: '2026-09-28', buscas: 5, semResultado: 1, termosDistintos: 4, clientes: 2 },
      { dia: '2026-09-29', buscas: 7, semResultado: 0, termosDistintos: 5, clientes: 3 },
    ],
  };
  const { storeRef, registro } = firestoreFalso({ logs: [busca()], resumo: anterior });

  await rodarResumoDeBuscas({ storeRef, agora: AGORA, atualizadoEm: 'quando' });

  const dias = registro.gravados.resumo.dias;
  assert.deepEqual(dias.map((d) => d.dia), ['2026-09-28', '2026-09-29', DIA]);
  assert.equal(registro.gravados.resumo.primeiroDia, '2026-09-28');
  assert.equal(registro.gravados.resumo.ultimoDia, DIA);
});

test('dia que sai da janela do topo perde a linha e o documento', async () => {
  const anterior = { dias: [{ dia: '2026-01-01', buscas: 3, semResultado: 0, termosDistintos: 2, clientes: 1, documento: true }] };
  const { storeRef, registro } = firestoreFalso({ logs: [], resumo: anterior });

  await rodarResumoDeBuscas({
    storeRef, agora: AGORA, atualizadoEm: 'quando', diasNoTopo: 1,
  });

  assert.deepEqual(registro.gravados.resumo.dias.map((d) => d.dia), [DIA]);
  assert.deepEqual(registro.diasExcluidos, ['2026-01-01']);
});

test('as duas janelas: 365 dias de contagem no topo, 90 dias de documento de dia', async () => {
  // 100 dias atras: fora da retencao de documento, dentro do ano. 400: fora das duas.
  const anterior = {
    dias: [
      { dia: diaMenos(DIA, 400), buscas: 2, semResultado: 0, termosDistintos: 2, clientes: 1, documento: true },
      { dia: diaMenos(DIA, 100), buscas: 9, semResultado: 2, termosDistintos: 7, clientes: 4, documento: true },
      { dia: diaMenos(DIA, 10), buscas: 5, semResultado: 0, termosDistintos: 5, clientes: 2, documento: true },
    ],
  };
  const { storeRef, registro } = firestoreFalso({ logs: [busca()], resumo: anterior });

  const resultado = await rodarResumoDeBuscas({ storeRef, agora: AGORA, atualizadoEm: 'quando' });

  const dias = registro.gravados.resumo.dias;
  const linha = (dia) => dias.find((entrada) => entrada.dia === dia);

  // o de 400 dias sai inteiro do topo
  assert.equal(linha(diaMenos(DIA, 400)), undefined);
  assert.deepEqual(dias.map((d) => d.dia), [diaMenos(DIA, 100), diaMenos(DIA, 10), DIA]);

  // o de 100 dias mantem a contagem e perde o documento
  assert.equal(linha(diaMenos(DIA, 100)).buscas, 9);
  assert.equal(linha(diaMenos(DIA, 100)).documento, false);

  // o de 10 dias e o de ontem seguem com documento
  assert.equal(linha(diaMenos(DIA, 10)).documento, true);
  assert.equal(linha(DIA).documento, true);

  assert.deepEqual(registro.diasExcluidos.sort(), [diaMenos(DIA, 400), diaMenos(DIA, 100)].sort());
  assert.equal(resultado.diasSemDocumento, 1);
  assert.equal(resultado.linhasRemovidas, 1);
  assert.equal(registro.gravados.resumo.primeiroDia, diaMenos(DIA, 100));
  assert.equal(registro.gravados.resumo.primeiroDiaComDocumento, diaMenos(DIA, 10));
});

test('dia que ja perdeu o documento nao e apagado de novo toda noite', async () => {
  const anterior = {
    dias: [{ dia: diaMenos(DIA, 120), buscas: 4, semResultado: 1, termosDistintos: 3, clientes: 2, documento: false }],
  };
  const { storeRef, registro } = firestoreFalso({ logs: [], resumo: anterior });

  await rodarResumoDeBuscas({ storeRef, agora: AGORA, atualizadoEm: 'quando' });

  assert.deepEqual(registro.diasExcluidos, []);
  assert.equal(registro.gravados.resumo.dias.length, 2);
});

test('documento antigo e apagado, e so depois de o resumo estar gravado', async () => {
  const antigo = busca({ termo: 'VELHO', em: { toDate: () => new Date('2026-01-10T12:00:00Z') } });
  const { storeRef, registro } = firestoreFalso({ logs: [busca(), antigo] });

  const resultado = await rodarResumoDeBuscas({ storeRef, agora: AGORA, atualizadoEm: 'quando' });

  assert.equal(resultado.removidos, 1);
  assert.equal(registro.excluidos.length, 1);
  const primeiraExclusao = registro.ordem.findIndex((passo) => passo.startsWith('excluiu:'));
  assert.ok(registro.ordem.indexOf(`gravouDia:${DIA}`) < primeiraExclusao, 'dia gravado antes da exclusao');
  assert.ok(registro.ordem.indexOf('gravouResumo') < primeiraExclusao, 'resumo gravado antes da exclusao');
  // a busca de ontem nao foi apagada
  assert.equal(registro.dias[DIA].buscas, 1);
});

test('falha na exclusao nao desfaz o resumo', async () => {
  const antigo = busca({ termo: 'VELHO', em: { toDate: () => new Date('2026-01-10T12:00:00Z') } });
  const { storeRef, registro } = firestoreFalso({ logs: [busca(), antigo], falharNaExclusao: true });

  const resultado = await rodarResumoDeBuscas({ storeRef, agora: AGORA, atualizadoEm: 'quando' });

  assert.equal(resultado.removidos, 0);
  assert.match(resultado.falhaNaLimpeza, /permissao negada/);
  assert.equal(registro.dias[DIA].buscas, 1);
  assert.equal(registro.gravados.resumo.ultimoDia, DIA);
});

test('o resumo nao guarda nada alem de termo, contagem, datas e id de cliente', async () => {
  const { storeRef, registro } = firestoreFalso({ logs: [busca({ origem: 'app', termoNormalizado: 'coca cola' })] });

  await rodarResumoDeBuscas({ storeRef, agora: AGORA, atualizadoEm: 'quando' });

  const gravado = JSON.stringify(registro.dias[DIA]);
  assert.ok(gravado.includes('COCA COLA'));
  assert.ok(!gravado.includes('coca cola'), 'termoNormalizado fica fora');
  assert.ok(!gravado.includes('app'), 'origem fica fora');
  assert.deepEqual(
    Object.keys(registro.dias[DIA]).sort(),
    ['atualizadoEm', 'buscas', 'clientes', 'dia', 'porCliente', 'semResultado', 'termos', 'termosDistintos', 'version'],
  );
});
