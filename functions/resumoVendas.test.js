const test = require('node:test');
const assert = require('node:assert/strict');
const {
  atualizarResumoDeVendas,
  contribuicaoDoPedido,
  dataDaVenda,
  ehVenda,
  momentoDaVenda,
  montarMeses,
} = require('./resumoVendas');

const ts = (iso) => ({ toDate: () => new Date(iso) });

// ----- Regra de venda -----

test('status confirmados contam como venda, com ou sem prefixo e sem diferenca de caixa', () => {
  ['accepted', 'picking', 'separatingOrder', 'waitingForDelivery', 'waiting', 'deliveryRoute', 'on_route', 'completed', 'delivered']
    .forEach((status) => {
      assert.equal(ehVenda({ currentPurchaseStatus: `PurchaseStatus.${status}` }), true, status);
      assert.equal(ehVenda({ currentPurchaseStatus: status.toUpperCase() }), true, status);
    });
});

test('pendente, aguardando pagamento, negado, cancelado e desistencia nao contam', () => {
  ['pending', 'awaitingPayment', 'waitingForOrderPayment', 'waitingConfirmation', 'denied', 'giveUp', 'return', 'canceled', 'cancelled', 'cancelado', 'refundRequested', '']
    .forEach((status) => assert.equal(ehVenda({ currentPurchaseStatus: `PurchaseStatus.${status}` }), false, status));
  assert.equal(ehVenda(null), false);
});

test('status cai para purchaseStatus, status e stats, como no painel', () => {
  assert.equal(ehVenda({ purchaseStatus: 'accepted' }), true);
  assert.equal(ehVenda({ status: 'completed' }), true);
  assert.equal(ehVenda({ stats: 'deliveryRoute' }), true);
});

test('pedido de teste fica fora da venda', () => {
  assert.equal(ehVenda({ currentPurchaseStatus: 'PurchaseStatus.completed', isTest: true }), false);
  assert.equal(ehVenda({ currentPurchaseStatus: 'PurchaseStatus.completed', isTestAccount: true }), false);
  assert.equal(ehVenda({ currentPurchaseStatus: 'PurchaseStatus.completed', isTest: false }), true);
});

test('data da venda: paidAt, depois acceptedAt, depois createdAt', () => {
  const criado = ts('2026-09-01T12:00:00Z');
  const aceito = ts('2026-09-02T12:00:00Z');
  const pago = ts('2026-09-03T12:00:00Z');
  assert.equal(dataDaVenda({ createdAt: criado, acceptedAt: aceito, paidAt: pago }).toISOString(), '2026-09-03T12:00:00.000Z');
  assert.equal(dataDaVenda({ createdAt: criado, acceptedAt: aceito }).toISOString(), '2026-09-02T12:00:00.000Z');
  assert.equal(dataDaVenda({ createdAt: criado }).toISOString(), '2026-09-01T12:00:00.000Z');
  assert.equal(dataDaVenda({}), null);
});

test('momento da venda no fuso de Sao Paulo, inclusive na virada do mes', () => {
  assert.deepEqual(momentoDaVenda(new Date('2026-10-01T01:30:00Z')), {
    mes: '2026-09', dia: '30', hora: 'h22', semanaHora: 'd3h22',
  });
  assert.deepEqual(momentoDaVenda(new Date('2026-10-04T03:00:00Z')), {
    mes: '2026-10', dia: '04', hora: 'h00', semanaHora: 'd0h00',
  });
});

const pedido = (extra = {}) => ({
  companyId: 'loja-1',
  currentPurchaseStatus: 'PurchaseStatus.completed',
  createdAt: ts('2026-09-10T15:20:00Z'),
  clientId: 'cli-1',
  clientName: 'Ana',
  price: 30,
  deliveryPrice: 5,
  total: 35,
  address: { neighborhood: 'Centro' },
  productsCart: [
    { id: 'p-arroz', quantity: 2, product: { name: 'Arroz', price: 10 } },
    { id: 'p-feijao', quantity: 1, product: { name: 'Feijao', price: 10 } },
  ],
  ...extra,
});

const META = {
  produtos: new Map([
    ['p-arroz', { name: 'Arroz', categoriesIds: ['cereais'], shelves: [] }],
    ['p-feijao', { name: 'Feijao', categoriesIds: ['cereais'], shelves: [] }],
  ]),
  categorias: new Map([['cereais', 'CEREAIS']]),
};

test('canal: agente pelo campo ou pela origem, app sem nada', () => {
  assert.equal(contribuicaoDoPedido('x', pedido(), META).canal, 'app');
  assert.equal(contribuicaoDoPedido('x', pedido({ agentOrder: true }), META).canal, 'agent');
  assert.equal(contribuicaoDoPedido('x', pedido({ origin: 'WhatsApp' }), META).canal, 'agent');
});

test('contribuicao: valores, momento, rankings e chaves como no painel', () => {
  const contribuicao = contribuicaoDoPedido('ped-1', pedido(), META);
  assert.equal(contribuicao.mes, '2026-09');
  assert.equal(contribuicao.dia, '10');
  assert.equal(contribuicao.hora, 'h12');
  assert.equal(contribuicao.price, 30);
  assert.equal(contribuicao.frete, 5);
  assert.equal(contribuicao.total, 35);
  assert.deepEqual(contribuicao.produtos, {
    'p-arroz': { nome: 'Arroz', qtd: 2, valor: 20 },
    'p-feijao': { nome: 'Feijao', qtd: 1, valor: 10 },
  });
  assert.deepEqual(contribuicao.categorias, { cereais: { nome: 'CEREAIS', qtd: 3, valor: 30 } });
  assert.deepEqual(contribuicao.cliente, { chave: 'cli-1', nome: 'Ana', valor: 30 });
  assert.deepEqual(contribuicao.bairro, { chave: 'centro', nome: 'Centro' });
  assert.equal(contribuicaoDoPedido('ped-1', pedido({ isTest: true }), META), null);
});

test('produto sem id agrupa pelo nome, cliente sem id pelo nome e bairro sem acento', () => {
  const contribuicao = contribuicaoDoPedido('ped-2', pedido({
    clientId: undefined,
    clientName: 'José Ávila',
    address: { bairro: 'São José' },
    productsCart: [{ quantity: 3, product: { name: 'Pão Francês', price: 1 } }],
  }), META);
  assert.deepEqual(Object.keys(contribuicao.produtos), ['name:pao frances']);
  assert.equal(contribuicao.cliente.chave, 'jose avila');
  assert.deepEqual(contribuicao.bairro, { chave: 'sao jose', nome: 'São José' });
});

// ----- Firestore de mentira com transacao -----

const DELETE = { __delete: true };
const FieldValue = {
  increment: (n) => ({ __increment: n }),
  delete: () => DELETE,
  serverTimestamp: () => ({ __serverTimestamp: true }),
};

function mesclar(atual, novo) {
  const resultado = { ...(atual || {}) };
  Object.entries(novo).forEach(([chave, valor]) => {
    if (valor === DELETE) delete resultado[chave];
    else if (valor && valor.__increment !== undefined) resultado[chave] = (Number(resultado[chave]) || 0) + valor.__increment;
    else if (valor && typeof valor === 'object' && !Array.isArray(valor) && !valor.__serverTimestamp) resultado[chave] = mesclar(resultado[chave], valor);
    else resultado[chave] = valor;
  });
  return resultado;
}

function firestoreFalso(inicial = {}) {
  const docs = new Map(Object.entries(inicial));
  const registro = { docs, marcas: [], leiturasDeProduto: 0 };
  const referencia = (caminho) => ({
    caminho,
    id: caminho.split('/').at(-1),
    collection: (nome) => ({ doc: (id) => referencia(`${caminho}/${nome}/${id}`) }),
  });
  const snapshot = (ref) => {
    if (ref.caminho.includes('/Products/')) registro.leiturasDeProduto += 1;
    const dados = docs.get(ref.caminho);
    return { id: ref.id, exists: Boolean(dados), data: () => dados, get: (campo) => dados?.[campo] };
  };
  const db = {
    collection: (nome) => ({ doc: (id) => {
      const ref = referencia(`${nome}/${id}`);
      return {
        ...ref,
        collection: (sub) => ({
          doc: (subId) => {
            const filho = referencia(`${nome}/${id}/${sub}/${subId}`);
            if (sub === 'Stats') {
              return { ...filho, async set(dados) { registro.marcas.push({ caminho: filho.caminho, dados }); } };
            }
            return filho;
          },
        }),
      };
    } }),
    async getAll(...refs) { return refs.map(snapshot); },
    async runTransaction(funcao) {
      const escritas = [];
      const transacao = {
        async get(ref) { return snapshot(ref); },
        set(ref, dados, opcoes) { escritas.push(() => docs.set(ref.caminho, opcoes?.merge ? mesclar(docs.get(ref.caminho), dados) : mesclar({}, dados))); },
        delete(ref) { escritas.push(() => docs.delete(ref.caminho)); },
      };
      const resultado = await funcao(transacao);
      escritas.forEach((escrita) => escrita());
      return resultado;
    },
  };
  return { db, registro };
}

const PRODUTOS = {
  'estabelecimentos/loja-1/Products/p-arroz': { name: 'Arroz', categoriesIds: ['cereais'] },
  'estabelecimentos/loja-1/Products/p-feijao': { name: 'Feijao', categoriesIds: ['cereais'] },
  'estabelecimentos/loja-1/ProductCategories/cereais': { name: 'CEREAIS' },
  'estabelecimentos/loja-2/Products/p-arroz': { name: 'Arroz', categoriesIds: ['cereais'] },
  'estabelecimentos/loja-2/Products/p-feijao': { name: 'Feijao', categoriesIds: ['cereais'] },
  'estabelecimentos/loja-2/ProductCategories/cereais': { name: 'CEREAIS' },
};
const lojaDe = (dados) => dados.companyId || null;
const mes = (registro, loja, id) => registro.docs.get(`estabelecimentos/${loja}/ResumoVendas/${id}`);
const contribuicao = (registro, loja, id) => registro.docs.get(`estabelecimentos/${loja}/ResumoVendasContribuicoes/${id}`);
const atualizar = (db, antes, depois) => atualizarResumoDeVendas({ db, FieldValue, antes, depois, pedidoId: 'ped-1', lojaDe });

test('venda nova entra no mes, guarda a contribuicao e soma vendas no marcador', async () => {
  const { db, registro } = firestoreFalso(PRODUTOS);
  const resultado = await atualizar(db, null, pedido());
  assert.deepEqual(resultado, { acao: 'gravou', lojas: ['loja-1'] });
  const doc = mes(registro, 'loja-1', '2026-09');
  assert.deepEqual(doc.dias['10'].app, { pedidos: 1, price: 30, frete: 5, total: 35 });
  assert.deepEqual(doc.horas.h12.app, { pedidos: 1, price: 30, frete: 5, total: 35 });
  assert.deepEqual(doc.semanaHora.d4h12, { pedidos: 1, price: 30, total: 35 });
  assert.deepEqual(doc.produtos['p-arroz'], { nome: 'Arroz', qtd: 2, valor: 20 });
  assert.deepEqual(doc.categorias.cereais, { nome: 'CEREAIS', qtd: 3, valor: 30 });
  assert.deepEqual(doc.clientes['cli-1'], { nome: 'Ana', pedidos: 1, valor: 30 });
  assert.deepEqual(doc.bairros.centro, { nome: 'Centro', pedidos: 1 });
  assert.equal(contribuicao(registro, 'loja-1', 'ped-1').mes, '2026-09');
  assert.deepEqual(registro.marcas.map((m) => [m.caminho, Object.keys(m.dados).sort()]), [
    ['estabelecimentos/loja-1/Stats/marcador', ['vendas', 'vendasEm', 'versaoMarcador']],
  ]);
});

test('pedido que nao e venda antes nem depois nao le nem grava', async () => {
  const { db, registro } = firestoreFalso(PRODUTOS);
  const pendente = pedido({ currentPurchaseStatus: 'PurchaseStatus.pending' });
  assert.deepEqual(await atualizar(db, pendente, { ...pendente, isTest: true }), { acao: 'nada', lojas: [] });
  assert.equal(registro.leiturasDeProduto, 0);
  assert.equal(registro.docs.size, Object.keys(PRODUTOS).length);
});

test('gravacao que nao muda a contribuicao nao grava, e nao rele produtos', async () => {
  const { db, registro } = firestoreFalso(PRODUTOS);
  await atualizar(db, null, pedido());
  const leituras = registro.leiturasDeProduto;
  registro.marcas = [];
  const resultado = await atualizar(db, pedido(), pedido({ conferenciaEntrega: { ultimaResposta: 'entregue' } }));
  assert.deepEqual(resultado, { acao: 'nada', lojas: [] });
  assert.equal(registro.leiturasDeProduto, leituras, 'produto ja visto vem da contribuicao');
  assert.equal(registro.marcas.length, 0);
});

test('troca de valor tira a contribuicao antiga e poe a nova', async () => {
  const { db, registro } = firestoreFalso(PRODUTOS);
  await atualizar(db, null, pedido());
  await atualizar(db, pedido(), pedido({ price: 50, total: 55 }));
  const doc = mes(registro, 'loja-1', '2026-09');
  assert.deepEqual(doc.dias['10'].app, { pedidos: 1, price: 50, frete: 5, total: 55 });
  assert.deepEqual(doc.clientes['cli-1'], { nome: 'Ana', pedidos: 1, valor: 50 });
});

test('venda que vira cancelada sai do resumo e apaga a contribuicao', async () => {
  const { db, registro } = firestoreFalso(PRODUTOS);
  await atualizar(db, null, pedido());
  const resultado = await atualizar(db, pedido(), pedido({ currentPurchaseStatus: 'PurchaseStatus.canceled' }));
  assert.equal(resultado.acao, 'removeu');
  const doc = mes(registro, 'loja-1', '2026-09');
  assert.deepEqual(doc.dias['10'].app, { pedidos: 0, price: 0, frete: 0, total: 0 });
  assert.deepEqual(doc.produtos['p-arroz'], { nome: 'Arroz', qtd: 0, valor: 0 }, 'ranking subtrai e fica com zero');
  assert.equal(doc.bairros.centro.pedidos, 0);
  assert.equal(contribuicao(registro, 'loja-1', 'ped-1'), undefined);
});

test('venda que vira teste sai do resumo', async () => {
  const { db, registro } = firestoreFalso(PRODUTOS);
  await atualizar(db, null, pedido());
  await atualizar(db, pedido(), pedido({ isTest: true }));
  assert.equal(mes(registro, 'loja-1', '2026-09').dias['10'].app.pedidos, 0);
  assert.equal(contribuicao(registro, 'loja-1', 'ped-1'), undefined);
});

test('venda que muda de mes sai do mes antigo e entra no novo', async () => {
  const { db, registro } = firestoreFalso(PRODUTOS);
  await atualizar(db, null, pedido());
  await atualizar(db, pedido(), pedido({ paidAt: ts('2026-10-02T14:00:00Z') }));
  assert.equal(mes(registro, 'loja-1', '2026-09').dias['10'].app.pedidos, 0);
  assert.deepEqual(mes(registro, 'loja-1', '2026-10').dias['02'].app, { pedidos: 1, price: 30, frete: 5, total: 35 });
  assert.equal(contribuicao(registro, 'loja-1', 'ped-1').mes, '2026-10');
});

test('venda apagada sai do resumo', async () => {
  const { db, registro } = firestoreFalso(PRODUTOS);
  await atualizar(db, null, pedido());
  const resultado = await atualizar(db, pedido(), null);
  assert.deepEqual(resultado, { acao: 'removeu', lojas: ['loja-1'] });
  assert.equal(mes(registro, 'loja-1', '2026-09').clientes['cli-1'].pedidos, 0);
  assert.equal(contribuicao(registro, 'loja-1', 'ped-1'), undefined);
});

test('venda que muda de loja sai da loja antiga e entra na nova', async () => {
  const { db, registro } = firestoreFalso(PRODUTOS);
  await atualizar(db, null, pedido());
  registro.marcas = [];
  const resultado = await atualizar(db, pedido(), pedido({ companyId: 'loja-2' }));
  assert.deepEqual(resultado.lojas.sort(), ['loja-1', 'loja-2']);
  assert.equal(mes(registro, 'loja-1', '2026-09').dias['10'].app.pedidos, 0);
  assert.equal(contribuicao(registro, 'loja-1', 'ped-1'), undefined);
  assert.equal(mes(registro, 'loja-2', '2026-09').dias['10'].app.pedidos, 1);
  assert.ok(contribuicao(registro, 'loja-2', 'ped-1'));
  assert.deepEqual(registro.marcas.map((m) => m.caminho).sort(), ['estabelecimentos/loja-1/Stats/marcador', 'estabelecimentos/loja-2/Stats/marcador']);
});

test('ranking soma vendas de pedidos diferentes e subtrai a que sai', async () => {
  const { db, registro } = firestoreFalso(PRODUTOS);
  const outro = pedido({ clientId: 'cli-2', clientName: 'Bia', productsCart: [{ id: 'p-arroz', quantity: 5, product: { name: 'Arroz', price: 10 } }] });
  await atualizarResumoDeVendas({ db, FieldValue, antes: null, depois: pedido(), pedidoId: 'ped-1', lojaDe });
  await atualizarResumoDeVendas({ db, FieldValue, antes: null, depois: outro, pedidoId: 'ped-2', lojaDe });
  let doc = mes(registro, 'loja-1', '2026-09');
  assert.equal(doc.produtos['p-arroz'].qtd, 7);
  assert.equal(doc.categorias.cereais.qtd, 8);
  assert.equal(doc.bairros.centro.pedidos, 2);
  await atualizarResumoDeVendas({ db, FieldValue, antes: outro, depois: null, pedidoId: 'ped-2', lojaDe });
  doc = mes(registro, 'loja-1', '2026-09');
  assert.equal(doc.produtos['p-arroz'].qtd, 2);
  assert.equal(doc.clientes['cli-2'].pedidos, 0);
  assert.equal(doc.clientes['cli-1'].pedidos, 1);
});

test('montarMeses do script da a mesma soma que o gatilho', async () => {
  const { db, registro } = firestoreFalso(PRODUTOS);
  await atualizar(db, null, pedido());
  const pelaFuncao = mes(registro, 'loja-1', '2026-09');
  const peloScript = montarMeses([contribuicaoDoPedido('ped-1', pedido(), META)]).get('2026-09');
  const { versaoResumo, atualizadoEm, ...semMarcas } = pelaFuncao;
  assert.deepEqual(semMarcas, peloScript);
});
