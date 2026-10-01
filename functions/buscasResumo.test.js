const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RESUMO_VERSION,
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
function firestoreFalso({
  logs = [], resumo = null, falharNaExclusao = false, catalogo = [],
} = {}) {
  const registro = {
    ordem: [], gravados: {}, dias: {}, excluidos: [], diasExcluidos: [], leiturasDoCatalogo: 0,
  };
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

  // Catalogo de mentira: conta quantas vezes foi lido, para o teste do dia sem termo
  // sem resultado provar que nao houve leitura.
  const consultaProdutos = () => ({
    where: () => consultaProdutos(),
    select: () => consultaProdutos(),
    async get() {
      registro.ordem.push('leuCatalogo');
      registro.leiturasDoCatalogo += 1;
      return { docs: catalogo.map((name) => ({ get: () => name })), size: catalogo.length, empty: !catalogo.length };
    },
  });

  const docDia = (dia) => ({
    async set(dados) { registro.ordem.push(`gravouDia:${dia}`); registro.dias[dia] = dados; },
    async delete() { registro.diasExcluidos.push(dia); delete registro.dias[dia]; },
    async get() {
      const dados = registro.dias[dia];
      return { exists: Boolean(dados), get: (campo) => (dados || {})[campo] };
    },
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
        if (nome === 'Products') return consultaProdutos();
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

// Cruzamento de busca com pedido: janela de 2 horas, a mesma da rotina do agente.
function pedido(extra = {}) {
  return {
    clientId: 'cliente-1',
    currentPurchaseStatus: 'PurchaseStatus.completed',
    createdAt: em(10, 30),
    ...extra,
  };
}

test('busca com pedido do mesmo cliente dentro de 2 horas conta como convertida', () => {
  const resumo = resumirBuscas({
    dia: DIA,
    buscas: [busca({ em: em(10) })],
    pedidos: [pedido({ createdAt: em(11, 59) })],
  });

  assert.equal(resumo.convertidas, 1);
  assert.equal(resumo.semPedido, 0);
  assert.equal(resumo.semCliente, 0);
  assert.equal(resumo.porCliente[0].convertidas, 1);
  assert.equal(resumo.porCliente[0].buscas, 1);
});

test('pedido 3 horas depois nao conta, e pedido antes da busca tambem nao', () => {
  const tarde = resumirBuscas({ dia: DIA, buscas: [busca({ em: em(10) })], pedidos: [pedido({ createdAt: em(13) })] });
  const antes = resumirBuscas({ dia: DIA, buscas: [busca({ em: em(10) })], pedidos: [pedido({ createdAt: em(9) })] });

  assert.equal(tarde.convertidas, 0);
  assert.equal(tarde.semPedido, 1);
  assert.equal(antes.convertidas, 0);
  assert.equal(antes.semPedido, 1);
});

test('pedido de outro cliente nao conta', () => {
  const resumo = resumirBuscas({
    dia: DIA,
    buscas: [busca({ clienteId: 'cliente-1', em: em(10) })],
    pedidos: [pedido({ clientId: 'cliente-2', createdAt: em(10, 30) })],
  });

  assert.equal(resumo.convertidas, 0);
  assert.equal(resumo.semPedido, 1);
  assert.equal(resumo.porCliente[0].convertidas, 0);
});

test('busca sem cliente fica fora dos dois lados e aparece na contagem a parte', () => {
  const resumo = resumirBuscas({
    dia: DIA,
    buscas: [busca({ clienteId: null, em: em(10) }), busca({ em: em(10) })],
    pedidos: [pedido({ createdAt: em(10, 30) })],
  });

  assert.equal(resumo.buscas, 2);
  assert.equal(resumo.semCliente, 1);
  assert.equal(resumo.convertidas, 1);
  assert.equal(resumo.semPedido, 0);
  assert.equal(resumo.convertidas + resumo.semPedido + resumo.semCliente, resumo.buscas);
});

test('pedido de teste nao conta, pelas tres marcas que o Core usa', () => {
  const comMarca = (extra) => resumirBuscas({
    dia: DIA,
    buscas: [busca({ em: em(10) })],
    pedidos: [pedido({ createdAt: em(10, 30), ...extra })],
    testAccountIds: extra.viaCliente ? new Set(['cliente-1']) : new Set(),
  });

  assert.equal(comMarca({ isTest: true }).convertidas, 0, 'isTest no pedido');
  assert.equal(comMarca({ isTestAccount: true }).convertidas, 0, 'espelho isTestAccount no pedido');
  assert.equal(comMarca({ viaCliente: true }).convertidas, 0, 'conta de teste cruzada pelo cliente');
  assert.equal(comMarca({}).convertidas, 1, 'pedido normal conta');
});

test('dia sem busca nenhuma nao le pedido nenhum', async () => {
  const { storeRef } = firestoreFalso({ logs: [] });
  let chamadas = 0;

  const resultado = await rodarResumoDeBuscas({
    storeRef,
    agora: AGORA,
    atualizadoEm: 'quando',
    carregarPedidos: async () => { chamadas += 1; return [pedido()]; },
  });

  assert.equal(chamadas, 0);
  assert.equal(resultado.pedidosLidos, 0);
  assert.equal(resultado.convertidas, 0);
});

test('busca sem cliente tambem nao faz ler pedido', async () => {
  const { storeRef } = firestoreFalso({ logs: [busca({ clienteId: null })] });
  let chamadas = 0;

  const resultado = await rodarResumoDeBuscas({
    storeRef,
    agora: AGORA,
    atualizadoEm: 'quando',
    carregarPedidos: async () => { chamadas += 1; return []; },
  });

  assert.equal(chamadas, 0);
  assert.equal(resultado.semCliente, 1);
});

test('a janela de pedidos vai ate 2 horas depois do fim do dia', async () => {
  const { storeRef, registro } = firestoreFalso({ logs: [busca({ em: em(23, 50) })] });
  let janela = null;

  await rodarResumoDeBuscas({
    storeRef,
    agora: AGORA,
    atualizadoEm: 'quando',
    carregarPedidos: async (intervalo) => {
      janela = intervalo;
      return [pedido({ createdAt: { toDate: () => new Date(Date.UTC(2026, 9, 1, 3, 30, 0)) } })];
    },
  });

  assert.equal(janela.inicio.toISOString(), '2026-09-30T03:00:00.000Z');
  assert.equal(janela.fim.toISOString(), '2026-10-01T05:00:00.000Z');
  assert.equal(registro.dias[DIA].convertidas, 1, 'busca das 23h50 converte com pedido da meia-noite e meia');
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
    dia: DIA, buscas: 0, semResultado: 0, termosDistintos: 0, clientes: 0, convertidas: 0, semPedido: 0, documento: true,
  });
});

test('a linha do topo leva convertidas e semPedido, para a conversao de um periodo sair de uma leitura', async () => {
  const { storeRef, registro } = firestoreFalso({
    logs: [busca({ em: em(10) }), busca({ clienteId: 'cliente-2', em: em(12) })],
  });

  await rodarResumoDeBuscas({
    storeRef,
    agora: AGORA,
    atualizadoEm: 'quando',
    carregarPedidos: async () => [pedido({ createdAt: em(11, 59) })],
  });

  const linha = registro.gravados.resumo.dias.at(-1);
  assert.equal(linha.dia, DIA);
  assert.equal(linha.convertidas, 1);
  assert.equal(linha.semPedido, 1);
  // semCliente nao entra em card nenhum: fica so no documento do dia.
  assert.equal('semCliente' in linha, false);
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

test('termo sem resultado com produto no catalogo: defeito de busca', async () => {
  const { storeRef, registro } = firestoreFalso({
    logs: [busca({ termo: 'BATATINHA', resultados: 0 })],
    catalogo: ['Batatinha Frita Elma Chips 100g', 'Arroz Branco 5kg'],
  });

  const resultado = await rodarResumoDeBuscas({ storeRef, agora: AGORA, atualizadoEm: 'quando' });

  const termo = registro.dias[DIA].termos[0];
  assert.equal(termo.termo, 'BATATINHA');
  assert.equal(termo.semResultado, 1);
  assert.equal(termo.existeNoCatalogo, true);
  assert.equal(resultado.catalogoLido, 2);
});

test('termo sem resultado sem produto no catalogo: decisao de compra', async () => {
  const { storeRef, registro } = firestoreFalso({
    logs: [busca({ termo: 'QUIBOA', resultados: 0 })],
    catalogo: ['Agua Sanitaria Ype 1L', 'Arroz Branco 5kg'],
  });

  await rodarResumoDeBuscas({ storeRef, agora: AGORA, atualizadoEm: 'quando' });

  assert.equal(registro.dias[DIA].termos[0].existeNoCatalogo, false);
});

test('a marca ignora acento e caixa, nos dois lados', async () => {
  const { storeRef, registro } = firestoreFalso({
    logs: [busca({ termo: 'agua de coco', resultados: 0 }), busca({ termo: 'PAO', resultados: 0 })],
    catalogo: ['Água de Côco Natural 300ml', 'Pãozinho Frances kg'],
  });

  await rodarResumoDeBuscas({ storeRef, agora: AGORA, atualizadoEm: 'quando' });

  const marca = (termo) => registro.dias[DIA].termos.find((t) => t.termo === termo).existeNoCatalogo;
  assert.equal(marca('agua de coco'), true);
  assert.equal(marca('PAO'), true);
});

test('dia sem nenhum termo sem resultado nao le o catalogo', async () => {
  const { storeRef, registro } = firestoreFalso({
    logs: [busca({ resultados: 12 }), busca({ termo: 'ARROZ', resultados: 30 })],
    catalogo: ['Arroz Branco 5kg'],
  });

  const resultado = await rodarResumoDeBuscas({ storeRef, agora: AGORA, atualizadoEm: 'quando' });

  assert.equal(registro.leiturasDoCatalogo, 0);
  assert.equal(resultado.catalogoLido, 0);
  assert.ok(!registro.ordem.includes('leuCatalogo'));
});

test('termo com resultado nao recebe marca nenhuma', async () => {
  const { storeRef, registro } = firestoreFalso({
    logs: [busca({ termo: 'ARROZ', resultados: 30 }), busca({ termo: 'QUIBOA', resultados: 0 })],
    catalogo: ['Arroz Branco 5kg'],
  });

  await rodarResumoDeBuscas({ storeRef, agora: AGORA, atualizadoEm: 'quando' });

  const arroz = registro.dias[DIA].termos.find((t) => t.termo === 'ARROZ');
  const quiboa = registro.dias[DIA].termos.find((t) => t.termo === 'QUIBOA');
  assert.equal('existeNoCatalogo' in arroz, false);
  assert.equal(quiboa.existeNoCatalogo, false);
});

test('o catalogo e lido uma vez por loja, mesmo com varios termos sem resultado', async () => {
  const { storeRef, registro } = firestoreFalso({
    logs: [
      busca({ termo: 'QUIBOA', resultados: 0 }),
      busca({ termo: 'BATATINHA', resultados: 0 }),
      busca({ termo: 'CERVEJA', resultados: 0 }),
    ],
    catalogo: ['Batatinha Frita 100g'],
  });

  await rodarResumoDeBuscas({ storeRef, agora: AGORA, atualizadoEm: 'quando' });

  assert.equal(registro.leiturasDoCatalogo, 1);
  const marca = (termo) => registro.dias[DIA].termos.find((t) => t.termo === termo).existeNoCatalogo;
  assert.deepEqual([marca('QUIBOA'), marca('BATATINHA'), marca('CERVEJA')], [false, true, false]);
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
    ['atualizadoEm', 'buscas', 'clientes', 'convertidas', 'dia', 'porCliente', 'semCliente', 'semPedido', 'semResultado', 'termos', 'termosDistintos', 'version'],
  );
});

// Traducao do uid do Authentication para o id do documento em Users.
const { indiceDeUsuarios } = require('./provedoresDeLogin');

function docUsuario(id, userAuthId = null) {
  const dados = { userAuthId };
  return { id, get: (campo) => dados[campo] };
}

test('conta antiga: uid diferente do id do documento casa pelo userAuthId', () => {
  const indice = indiceDeUsuarios([docUsuario('cliente-antigo', 'uid-antigo')]);

  const resumo = resumirBuscas({
    dia: DIA,
    buscas: [busca({ clienteId: 'uid-antigo' })],
    indiceDeUsuarios: indice,
  });

  assert.equal(resumo.porCliente[0].clienteId, 'uid-antigo', 'o cru nao muda');
  assert.equal(resumo.porCliente[0].clienteDocId, 'cliente-antigo');
});

test('conta nova: uid igual ao id do documento', () => {
  const indice = indiceDeUsuarios([docUsuario('uid-novo')]);

  const resumo = resumirBuscas({
    dia: DIA,
    buscas: [busca({ clienteId: 'uid-novo' })],
    indiceDeUsuarios: indice,
  });

  assert.equal(resumo.porCliente[0].clienteDocId, 'uid-novo');
});

test('uid sem documento em Users fica com clienteDocId nulo', () => {
  const indice = indiceDeUsuarios([docUsuario('cliente-outro', 'uid-outro')]);

  const resumo = resumirBuscas({
    dia: DIA,
    buscas: [busca({ clienteId: 'uid-sem-cadastro' })],
    indiceDeUsuarios: indice,
  });

  assert.equal(resumo.porCliente[0].clienteId, 'uid-sem-cadastro');
  assert.equal(resumo.porCliente[0].clienteDocId, null);
});

test('uid com dois documentos fica nulo: nao se escolhe no escuro', () => {
  const indice = indiceDeUsuarios([
    docUsuario('cliente-a', 'uid-duplo'),
    docUsuario('cliente-b', 'uid-duplo'),
  ]);

  assert.equal(indice.ambiguo('uid-duplo'), true);
  const resumo = resumirBuscas({
    dia: DIA,
    buscas: [busca({ clienteId: 'uid-duplo' })],
    indiceDeUsuarios: indice,
  });

  assert.equal(resumo.porCliente[0].clienteDocId, null);
});

test('sem indice, clienteDocId sai nulo e nada quebra', () => {
  const resumo = resumirBuscas({ dia: DIA, buscas: [busca()] });

  assert.equal(resumo.porCliente[0].clienteDocId, null);
});

test('dia de versao antiga e refeito, e dia na versao atual nao', async () => {
  const anterior = {
    dias: [
      { dia: '2026-09-29', buscas: 1, semResultado: 0, termosDistintos: 1, clientes: 1, documento: true },
      { dia: '2026-09-28', buscas: 1, semResultado: 0, termosDistintos: 1, clientes: 1, documento: true },
    ],
  };
  const emVinteNove = { toDate: () => new Date(Date.UTC(2026, 8, 29, 15, 0, 0)) };
  const { storeRef, registro } = firestoreFalso({ logs: [busca(), busca({ em: emVinteNove })], resumo: anterior });
  registro.dias['2026-09-29'] = { dia: '2026-09-29', version: 1, buscas: 1 };
  registro.dias['2026-09-28'] = { dia: '2026-09-28', version: RESUMO_VERSION, buscas: 1 };

  const resultado = await rodarResumoDeBuscas({ storeRef, agora: AGORA, atualizadoEm: 'quando' });

  assert.equal(resultado.diasRefeitos, 1);
  assert.deepEqual(resultado.diasRefeitosEm, ['2026-09-29']);
  assert.equal(registro.dias['2026-09-29'].version, RESUMO_VERSION, 'refeito na versao nova');
  assert.equal(registro.dias['2026-09-28'].version, RESUMO_VERSION, 'nao foi tocado');
});

test('dia de versao antiga sem SearchLogs nao e refeito', async () => {
  const anterior = {
    dias: [{ dia: '2026-09-25', buscas: 12, semResultado: 2, termosDistintos: 9, clientes: 4, documento: true }],
  };
  const { storeRef, registro } = firestoreFalso({ logs: [], resumo: anterior });
  registro.dias['2026-09-25'] = {
    dia: '2026-09-25', version: 1, buscas: 12, termos: [{ termo: 'ARROZ', vezes: 12 }],
  };

  const resultado = await rodarResumoDeBuscas({ storeRef, agora: AGORA, atualizadoEm: 'quando' });

  assert.equal(resultado.diasRefeitos, 0);
  assert.deepEqual(resultado.diasSemDadoBruto, ['2026-09-25']);
  assert.equal(registro.dias['2026-09-25'].buscas, 12, 'o numero antigo ficou de pe');
  assert.equal(registro.dias['2026-09-25'].version, 1);
});

test('o teto de sete dias por passada e respeitado', async () => {
  const dias = [];
  for (let dia = 20; dia <= 29; dia += 1) {
    dias.push({ dia: `2026-09-${dia}`, buscas: 1, semResultado: 0, termosDistintos: 1, clientes: 1, documento: true });
  }
  const { storeRef, registro } = firestoreFalso({ logs: [busca()], resumo: { dias } });
  dias.forEach(({ dia }) => { registro.dias[dia] = { dia, version: 1, buscas: 0 }; });

  const resultado = await rodarResumoDeBuscas({ storeRef, agora: AGORA, atualizadoEm: 'quando' });

  assert.equal(resultado.diasRefeitos, 7);
  assert.deepEqual(resultado.diasRefeitosEm, [
    '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29',
  ]);
});
