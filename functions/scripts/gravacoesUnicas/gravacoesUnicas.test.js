// Partes puras das gravacoes unicas da versao 55 (cola RP-76). A gravacao e o desfazer de cada
// tarefa foram testados no emulador do Firestore (relatorio da RP-76).
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AUSENTE, caminhoDeCampo, camposDoUpdate, criarFirestore, iguais, lerValor, ritmoDaGravacao, valorNoCaminho, valorRest,
} = require('./firestoreRest');
const { planoDaGravacao } = require('./comum');
const { mudancasDosCupons } = require('./tarefas/cupons');

test('ritmo da gravacao: padrao 400 sem pausa; numero fora da faixa para antes de gravar', () => {
  assert.deepEqual(ritmoDaGravacao(), { porChamada: 400, pausaMs: 0 });
  assert.deepEqual(ritmoDaGravacao({ porChamada: '50', pausaMs: '5000' }), { porChamada: 50, pausaMs: 5000 });
  ['0', '501', '2.5', 'abc', '-1'].forEach((valor) => {
    assert.throws(() => ritmoDaGravacao({ porChamada: valor }), /--por-chamada.*Nada foi gravado/);
  });
  ['-1', '1.5', 'x', '600001'].forEach((valor) => {
    assert.throws(() => ritmoDaGravacao({ pausaMs: valor }), /--pausa-ms.*Nada foi gravado/);
  });
  assert.match(planoDaGravacao(376, { porChamada: 50, pausaMs: 5000 }), /376 documentos em 8 chamada\(s\) de ate 50, pausa de 5000 ms entre elas \(35 s/);
  assert.match(planoDaGravacao(376, { porChamada: 400, pausaMs: 0 }), /em 1 chamada\(s\)/);
});

test('gravar em lotes: 5 escritas de 2 em 2 viram 3 chamadas, com a pausa so entre elas', async () => {
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
  const fetchOriginal = globalThis.fetch;
  const chamadas = [];
  globalThis.fetch = async (url, { body }) => {
    const { writes } = JSON.parse(body);
    chamadas.push({ url, quando: Date.now(), tamanho: writes.length });
    return { ok: true, text: async () => JSON.stringify({ status: writes.map(() => ({})) }) };
  };
  try {
    const firestore = criarFirestore({ projeto: 'demo-teste', permitirGravacao: true, porChamada: 2, pausaMs: 40 });
    const vistas = [];
    const escritas = [1, 2, 3, 4, 5].map((n) => ({ caminho: `Coupons/c${n}`, valores: { tipo: valorRest('todos') } }));
    const inicio = Date.now();
    const resultado = await firestore.gravar(escritas, { aoTerminarChamada: (passo) => vistas.push(passo) });
    assert.deepEqual(chamadas.map((chamada) => chamada.tamanho), [2, 2, 1]);
    assert.ok(chamadas.every((chamada) => chamada.url.endsWith(':batchWrite')));
    assert.ok(chamadas[0].quando - inicio < 30, 'a primeira chamada nao espera');
    assert.ok(chamadas[1].quando - chamadas[0].quando >= 35 && chamadas[2].quando - chamadas[1].quando >= 35, 'pausa entre as chamadas');
    assert.deepEqual(vistas.map(({ chamada, chamadas: total, gravados }) => [chamada, total, gravados]), [[1, 3, 2], [2, 3, 4], [3, 3, 5]]);
    assert.equal(resultado.length, 5);
    assert.ok(resultado.every((item) => item.ok));
  } finally {
    globalThis.fetch = fetchOriginal;
    delete process.env.FIRESTORE_EMULATOR_HOST;
  }
});

const documento = (id, campos) => ({ caminho: `Coupons/${id}`, id, campos, updateTime: '2026-10-29T00:00:00Z' });

test('valores REST: ida e volta, inteiro como integerValue, ordem dos mapas nao importa', () => {
  assert.deepEqual(valorRest(1), { integerValue: '1' });
  assert.deepEqual(valorRest(1.5), { doubleValue: 1.5 });
  assert.deepEqual(lerValor(valorRest({ a: [1, 'x', null, true] })), { a: [1, 'x', null, true] });
  assert.ok(iguais(valorRest({ a: 1, b: 2 }), valorRest({ b: 2, a: 1 })));
  assert.ok(!iguais(valorRest('1'), valorRest(1)));
  assert.ok(iguais(undefined, AUSENTE));
  assert.ok(iguais({ mapValue: {} }, valorRest({})));
  assert.ok(iguais({ arrayValue: {} }, valorRest([])));
  assert.ok(!iguais({ mapValue: {} }, valorRest({ a: 1 })));
});

test('campo ausente fica so na mascara (apaga); caminho com caractere especial vai entre crases', () => {
  assert.deepEqual(camposDoUpdate({ tipo: AUSENTE, 'a.b': valorRest('x') }), { a: { mapValue: { fields: { b: { stringValue: 'x' } } } } });
  assert.equal(caminhoDeCampo('featureFlags.debito'), 'featureFlags.debito');
  assert.equal(caminhoDeCampo('mapa.item-1'), 'mapa.`item-1`');
  assert.equal(valorNoCaminho({ a: valorRest({ b: 'x' }) }, 'a.b').stringValue, 'x');
  assert.equal(valorNoCaminho({}, 'a.b'), undefined);
});

test('previa nunca grava: gravar() lanca sem a chave', async () => {
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
  try {
    const firestore = criarFirestore({ projeto: 'demo-teste' });
    await assert.rejects(() => firestore.gravar([{ caminho: 'Coupons/x', valores: { tipo: valorRest('todos') } }]), /bloqueada/);
  } finally {
    delete process.env.FIRESTORE_EMULATOR_HOST;
  }
});

test('cupons: sem tipo (ausente, nulo ou vazio) ganha todos; com tipo ou com cliente fica de fora', () => {
  const { mudancas, avisos } = mudancasDosCupons([
    documento('semTipo', {}),
    documento('nulo', { tipo: { nullValue: null } }),
    documento('vazio', { tipo: { stringValue: '' } }),
    documento('todos', { tipo: { stringValue: 'todos' } }),
    documento('cliente', { tipo: { stringValue: 'cliente' } }),
    documento('antigo', { targetClientId: { stringValue: 'u1' } }),
    documento('destinatario', { destinatario: valorRest({ userAuthId: 'a1' }) }),
  ]);
  assert.deepEqual(mudancas.map((mudanca) => mudanca.caminho), ['Coupons/semTipo', 'Coupons/nulo', 'Coupons/vazio']);
  assert.deepEqual(mudancas[0].antes, { tipo: AUSENTE });
  assert.deepEqual(mudancas[1].antes, { tipo: { nullValue: null } });
  assert.deepEqual(mudancas[0].depois, { tipo: { stringValue: 'todos' } });
  assert.equal(avisos.length, 2);
});

const { mudancasDoCartao } = require('./tarefas/cartaoGs');

test('cartao da G&S: so o nome que fala em debito muda, no array e na subcolecao', () => {
  const item = (id, name) => valorRest({ id, name, isActive: true, order: 1, icon: null });
  const loja = {
    caminho: 'estabelecimentos/GkFYWdOBKD1vbzYoem9K', updateTime: 't',
    campos: { paymentMethods: { arrayValue: { values: [item('cartao', 'Cartão de crédito/débito'), item('pix', 'Pix')] } } },
  };
  const formas = [
    { caminho: `${loja.caminho}/paymentMethods/cartao`, id: 'cartao', campos: { name: valorRest('Cartão de crédito/débito') } },
    { caminho: `${loja.caminho}/paymentMethods/pix`, id: 'pix', campos: { name: valorRest('PIX') } },
  ];
  const mudancas = mudancasDoCartao(loja, formas);
  assert.equal(mudancas.length, 2);
  assert.deepEqual(lerValor(mudancas[0].depois.paymentMethods), [
    { id: 'cartao', name: 'Cartão de crédito', isActive: true, order: 1, icon: null },
    { id: 'pix', name: 'Pix', isActive: true, order: 1, icon: null },
  ]);
  assert.equal(mudancas[1].caminho, `${loja.caminho}/paymentMethods/cartao`);
  assert.deepEqual(mudancas[1].depois, { name: { stringValue: 'Cartão de crédito' } });
  const jaCerta = { ...loja, campos: { paymentMethods: { arrayValue: { values: [item('credito', 'Cartão de crédito')] } } } };
  assert.equal(mudancasDoCartao(jaCerta, []).length, 0);
});

const { jaNaVersao, mudancaDoPedido, podeSerRecalculado } = require('./tarefas/gruposDosPedidos');

test('grupos dos pedidos: pula o ja classificado; copia guarda os tres campos (ausente marcado)', () => {
  assert.ok(jaNaVersao({ gruposVersao: 1, resumoPorGrupo: { mercearia: 0 } }));
  assert.ok(!jaNaVersao({ gruposVersao: 1 }));
  assert.ok(!jaNaVersao({ gruposVersao: 0, resumoPorGrupo: {} }));
  const mudanca = mudancaDoPedido(
    { caminho: 'PurchaseRequests/p', updateTime: 't', campos: { gruposVersao: valorRest(0) } },
    { gruposDosItens: { i1: 'mercearia' }, resumoPorGrupo: { mercearia: 2.5 }, gruposVersao: 1 },
  );
  assert.deepEqual(mudanca.antes, { gruposDosItens: AUSENTE, resumoPorGrupo: AUSENTE, gruposVersao: { integerValue: '0' } });
  assert.deepEqual(lerValor(mudanca.depois.resumoPorGrupo), { mercearia: 2.5 });
  assert.deepEqual(mudanca.depois.gruposVersao, { integerValue: '1' });
});

test('grupos dos pedidos: conta o pedido que o onPurchaseSeparated da v55 pode refazer', () => {
  const item = { product: { price: 1 }, quantity: 1 };
  assert.ok(podeSerRecalculado({ currentPurchaseStatus: 'PurchaseStatus.completed', discountValue: 2, productsCart: [item] }));
  assert.ok(podeSerRecalculado({ currentPurchaseStatus: 'PurchaseStatus.completed', productsCart: [{ ...item, separated: { hasRemoved: true } }] }));
  assert.ok(!podeSerRecalculado({ currentPurchaseStatus: 'PurchaseStatus.completed', productsCart: [item] }));
  assert.ok(!podeSerRecalculado({ currentPurchaseStatus: 'PurchaseStatus.canceled', discountValue: 2, productsCart: [item] }));
});

const { mudancasDoLote } = require('./tarefas/unidadesGs');

test('unidades da G&S: cada lote pega so os seus e grava so unitType', () => {
  const produto = (id, campos) => ({ caminho: `estabelecimentos/G/Products/${id}`, id, updateTime: 't', campos: Object.fromEntries(Object.entries(campos).map(([k, v]) => [k, valorRest(v)])) });
  const documentos = [
    produto('lt', { unitType: 'LT', unityType: 'LT', unitQuantity: 24 }),
    produto('kgPacote', { unitType: 'KG', unityType: 'un', unitQuantity: 4 }),
    produto('kg', { unitType: 'KG', unityType: 'un', unitQuantity: 1 }),
    produto('pc1', { unitType: 'PC' }), produto('pc2', { unitType: 'Pc' }), produto('pc3', { unitType: 'pc' }),
    produto('peca', { unitType: 'Peça' }), produto('un', { unitType: 'UN' }), produto('semTipo', { unityType: 'LT' }),
  ];
  const ids = (lote) => mudancasDoLote(lote, documentos).mudancas.map((mudanca) => mudanca.caminho.split('/').pop());
  assert.deepEqual(ids('lata'), ['lt']);
  assert.deepEqual(ids('kg-pacote'), ['kgPacote']);
  assert.deepEqual(ids('pc'), ['pc1', 'pc2', 'pc3']);
  const { mudancas, aindaEmLt } = mudancasDoLote('lata', documentos);
  assert.equal(aindaEmLt, 1);
  assert.deepEqual(Object.keys(mudancas[0].depois), ['unitType']);
  assert.deepEqual(mudancas[0].antes, { unitType: { stringValue: 'LT' } });
  assert.deepEqual(mudancas[0].depois, { unitType: { stringValue: 'ProductUnitType.lata' } });
  assert.deepEqual(mudancasDoLote('pc', documentos).mudancas[0].depois, { unitType: { stringValue: 'ProductUnitType.unidade' } });
});
