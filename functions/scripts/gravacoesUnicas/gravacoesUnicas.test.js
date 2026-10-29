// Partes puras das gravacoes unicas da versao 55 (cola RP-76). A gravacao e o desfazer de cada
// tarefa foram testados no emulador do Firestore (relatorio da RP-76).
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AUSENTE, caminhoDeCampo, camposDoUpdate, criarFirestore, iguais, lerValor, valorNoCaminho, valorRest,
} = require('./firestoreRest');
const { mudancasDosCupons } = require('./tarefas/cupons');

const documento = (id, campos) => ({ caminho: `Coupons/${id}`, id, campos, updateTime: '2026-10-29T00:00:00Z' });

test('valores REST: ida e volta, inteiro como integerValue, ordem dos mapas nao importa', () => {
  assert.deepEqual(valorRest(1), { integerValue: '1' });
  assert.deepEqual(valorRest(1.5), { doubleValue: 1.5 });
  assert.deepEqual(lerValor(valorRest({ a: [1, 'x', null, true] })), { a: [1, 'x', null, true] });
  assert.ok(iguais(valorRest({ a: 1, b: 2 }), valorRest({ b: 2, a: 1 })));
  assert.ok(!iguais(valorRest('1'), valorRest(1)));
  assert.ok(iguais(undefined, AUSENTE));
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
