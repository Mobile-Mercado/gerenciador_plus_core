const test = require('node:test');
const assert = require('node:assert/strict');
const {
  catalogDictionary,
  familyOf,
  messageType,
  normalizeTerm,
  summarizeAgentOrders,
  summarizeConversations,
} = require('./agenteConversas');

const dictionary = catalogDictionary([
  'Leite Integral Italac 1L',
  'Leite Condensado Moça 395g',
  'Detergente Ypê Neutro 500ml',
  'Arroz Branco Tipo 1 5kg',
]);

function at(iso) {
  return { toDate: () => new Date(iso) };
}

test('builds the catalog dictionary from words with 3+ letters, singular and without accents', () => {
  assert.ok(dictionary.has('leite'));
  assert.ok(dictionary.has('condensado'));
  assert.ok(dictionary.has('moca'));
  assert.ok(dictionary.has('detergente'));
  assert.ok(dictionary.has('tipo'));
  assert.ok(dictionary.has('ype'));
  assert.ok(!dictionary.has('1l'));
  assert.ok(!dictionary.has('395g'));
});

test('pao, sal and gas get their family once the catalog has them', () => {
  const withShortWords = catalogDictionary(['Pão Francês kg', 'Sal Refinado Cisne 1kg', 'Gás de Cozinha P13']);
  assert.equal(familyOf(normalizeTerm('pão'), withShortWords), 'pao');
  assert.equal(familyOf(normalizeTerm('sal'), withShortWords), 'sal');
  assert.equal(familyOf(normalizeTerm('gás'), withShortWords), 'gas');
});

test('conversation words are never family and never enter the ungrouped list', () => {
  const withCom = catalogDictionary(['Whisky com Energético', 'Energético Monster 473ml', 'Pão de Queijo Bom Dia']);
  assert.equal(familyOf(normalizeTerm('wisky com energetico'), withCom), 'energetico');
  assert.equal(familyOf(normalizeTerm('boa noite gostaria'), withCom), '');
  assert.equal(familyOf(normalizeTerm('quero pao'), withCom), 'pao');
  const summary = summarizeConversations({
    dictionary: withCom,
    conversations: [{
      data: { userId: 'u', startedAt: at('2026-09-01T10:00:00Z') },
      messages: ['boa noite gostaria', 'ver pedido', 'preco', 'teste', 'quiboa', 'wisky com energetico']
        .map((content, index) => ({ role: 'user', content, timestamp: at(`2026-09-01T10:0${index}:00Z`) })),
    }],
  });
  assert.deepEqual(summary.naoAgrupados, [{ termo: 'quiboa', vezes: 1 }]);
  assert.deepEqual(summary.familias.map(({ familia }) => familia), ['energetico']);
});

test('numbers are never family and never enter the ungrouped list', () => {
  assert.equal(familyOf('300 grama leite', dictionary), 'leite');
  assert.equal(familyOf('300 grama di', dictionary), '');
  assert.equal(familyOf('2l', dictionary), '');
  const summary = summarizeConversations({
    dictionary,
    conversations: [{
      data: { userId: 'u', startedAt: at('2026-09-01T10:00:00Z') },
      messages: [
        { role: 'user', content: '2l', timestamp: at('2026-09-01T10:00:00Z') },
        { role: 'user', content: 'quiboa', timestamp: at('2026-09-01T10:01:00Z') },
      ],
    }],
  });
  assert.deepEqual(summary.naoAgrupados, [{ termo: 'quiboa', vezes: 1 }]);
  assert.ok(summary.termos.some(({ termo }) => termo === '2l'));
});

test('Leite, leite and leites share the family leite', () => {
  for (const text of ['Leite', 'leite', 'leites']) {
    const term = normalizeTerm(text);
    assert.equal(term, 'leite');
    assert.equal(familyOf(term, dictionary), 'leite');
  }
});

test('leite condensado keeps the phrase as term and leite as family', () => {
  const term = normalizeTerm('leite condensado');
  assert.equal(term, 'leite condensado');
  assert.equal(familyOf(term, dictionary), 'leite');
});

test('a single word outside the catalog has no family', () => {
  const term = normalizeTerm('quiboa');
  assert.equal(term, 'quiboa');
  assert.equal(familyOf(term, dictionary), '');
});

test('normalization drops accents, punctuation, simple plural and small words, keeping 3 words', () => {
  assert.equal(normalizeTerm('Pão de Açúcar!!'), 'pao acucar');
  assert.equal(normalizeTerm('um pacote de biscoitos recheados de chocolate'), 'pacote biscoito recheado');
  assert.equal(normalizeTerm('gás'), 'gas');
});

test('with no catalog word, a long term takes its first word and a short one has no family', () => {
  assert.equal(familyOf('sabao coco ralado', dictionary), 'sabao');
  assert.equal(familyOf('sabao coco', dictionary), '');
  assert.equal(familyOf('tem quiboa', dictionary), '');
});

test('packaging and measure words are never the family', () => {
  const withBox = catalogDictionary(['Cerveja Heineken Lata 350ml', 'Caixa de Fósforo', 'Água Mineral 20L', 'Galão Água 20L']);
  assert.equal(familyOf(normalizeTerm('caixa de cerveja'), withBox), 'cerveja');
  assert.equal(familyOf(normalizeTerm('agua 20 l'), withBox), 'agua');
  assert.equal(familyOf(normalizeTerm('galão de água'), withBox), 'agua');
  assert.equal(familyOf(normalizeTerm('2 latas cerveja'), withBox), 'cerveja');
  assert.equal(familyOf(normalizeTerm('caixa'), withBox), '');
});

test('message types follow the order dados, conversa, botao, produto, outro', () => {
  assert.equal(messageType('Finalizar pedido', dictionary), 'botao');
  assert.equal(messageType('Bom dia', dictionary), 'conversa');
  assert.equal(messageType('ok obrigado', dictionary), 'conversa');
  assert.equal(messageType('tem detergente?', dictionary), 'produto');
  assert.equal(familyOf(normalizeTerm('tem detergente?'), dictionary), 'detergente');
  assert.equal(messageType('2 kg de feijão', dictionary), 'produto');
  assert.equal(messageType('quanto custa?', dictionary), 'produto');
  assert.equal(messageType('meu nome é Maria', dictionary), 'dados');
  assert.equal(messageType('(62) 99999-1234', dictionary), 'dados');
  assert.equal(messageType('Rua 10 quadra 5 lote 3', dictionary), 'dados');
  assert.equal(messageType('vou pagar no pix', dictionary), 'dados');
  assert.equal(messageType('75123-456', dictionary), 'dados');
  assert.equal(messageType('isso aqui nao era bem o que eu queria', dictionary), 'outro');
});

test('a short request outside the catalog is a product request with no family', () => {
  assert.equal(messageType('quiboa', dictionary), 'produto');
  assert.equal(messageType('pinho sol', dictionary), 'produto');
  assert.equal(familyOf(normalizeTerm('quiboa'), dictionary), '');
  assert.equal(familyOf(normalizeTerm('pinho sol'), dictionary), '');
});

test('a short message never becomes a term while the agent collects data or when it is the client name', () => {
  assert.equal(messageType('Joana', dictionary, { flowState: 'collecting_name' }), 'dados');
  assert.equal(messageType('quiboa', dictionary, { flowState: 'collecting_cpf_onboarding' }), 'dados');
  assert.equal(messageType('Joana', dictionary, { clientNameWords: new Set(['joana', 'silva']) }), 'dados');
  assert.equal(messageType('Joana', dictionary, { flowState: 'browsing' }), 'produto');
});

test('the summary counts conversations and terms without keeping any message text', () => {
  const conversations = [
    {
      data: {
        userId: 'u1', clienteNome: 'Fulana de Tal', status: 'abandonada', pedidoGerado: false,
        carrinhoFinal: [], startedAt: at('2026-08-10T15:00:00Z'), updatedAt: at('2026-08-10T15:10:00Z'),
      },
      messages: [
        { role: 'user', content: 'Bom dia', timestamp: at('2026-08-10T15:00:00Z') },
        { role: 'assistant', content: 'Oi!', timestamp: at('2026-08-10T15:00:05Z') },
        { role: 'user', content: 'leites', timestamp: at('2026-08-10T15:01:00Z') },
        { role: 'assistant', content: 'Temos estes', produtosCardIds: ['p1'], timestamp: at('2026-08-10T15:01:05Z') },
        { role: 'user', content: 'meu nome é Fulana, rua 3', timestamp: at('2026-08-10T15:02:00Z') },
        // Pedido curto fora do catalogo: vira termo sem familia.
        { role: 'user', content: 'quiboa', timestamp: at('2026-08-10T15:03:00Z') },
        { role: 'assistant', content: 'Nao encontrei', produtosCardIds: [], timestamp: at('2026-08-10T15:03:05Z') },
        // Resposta ao pedido de nome: dado, nunca termo.
        { role: 'user', content: 'Fulana', flowStateAntes: 'collecting_name', timestamp: at('2026-08-10T15:04:00Z') },
      ],
    },
    {
      data: {
        userId: 'u2', status: 'ativa', pedidoGerado: false, carrinhoFinal: [{ id: 'p1' }],
        startedAt: at('2026-09-02T12:00:00Z'), updatedAt: at('2026-09-02T12:30:00Z'),
      },
      messages: [
        { role: 'user', content: 'Leite', timestamp: at('2026-09-02T12:00:00Z') },
        { role: 'assistant', content: 'Aqui', produtosCardIds: ['p1'], timestamp: at('2026-09-02T12:00:05Z') },
        { role: 'user', content: 'Finalizar pedido', timestamp: at('2026-09-02T12:05:00Z') },
      ],
    },
  ];

  const summary = summarizeConversations({ conversations, dictionary });

  assert.equal(summary.conversas, 2);
  assert.equal(summary.clientes, 2);
  assert.equal(summary.abandonadas, 1);
  assert.equal(summary.ativas, 1);
  assert.equal(summary.comPedidoMarcado, 0);
  assert.equal(summary.mensagensCliente, 7);
  assert.equal(summary.pedidosDeProduto, 3);
  assert.equal(summary.botoesDoFluxo, 1);
  assert.deepEqual(summary.periodoInicio, new Date('2026-08-10T15:00:00Z'));
  assert.deepEqual(summary.periodoFim, new Date('2026-09-02T12:30:00Z'));

  const leite = summary.termos.find((term) => term.termo === 'leite');
  assert.equal(leite.vezes, 2);
  assert.equal(leite.familia, 'leite');
  assert.equal(leite.comProduto, 2);
  assert.equal(leite.semProduto, 0);
  assert.equal(leite.semCarrinho, 1);
  assert.deepEqual(leite.primeira, new Date('2026-08-10T15:01:00Z'));
  assert.deepEqual(leite.ultima, new Date('2026-09-02T12:00:00Z'));

  assert.deepEqual(summary.familias, [{ familia: 'leite', vezes: 2, variantes: [{ termo: 'leite', vezes: 2 }] }]);
  assert.deepEqual(summary.naoAgrupados, [{ termo: 'quiboa', vezes: 1 }]);
  assert.ok(!summary.termos.some((term) => term.termo === 'fulana'));
  assert.deepEqual(summary.porMes, [
    { mes: '2026-08', conversas: 1, abandonadas: 1, pedidosDeProduto: 2, clientes: 1 },
    { mes: '2026-09', conversas: 1, abandonadas: 0, pedidosDeProduto: 1, clientes: 1 },
  ]);

  const stored = JSON.stringify(summary);
  assert.ok(!stored.includes('Fulana'));
  assert.ok(!stored.includes('rua'));
  assert.ok(!stored.includes('Bom dia'));
});

test('orders: marked by agent origin, probable within 2 hours of a conversation, tests left out', () => {
  const conversations = [
    { data: { userId: 'c1', startedAt: at('2026-09-01T10:00:00Z') } },
    { data: { userId: 'c2', startedAt: at('2026-09-01T10:00:00Z') } },
  ];
  const order = (fields) => ({ createdAt: at('2026-09-01T11:00:00Z'), currentPurchaseStatus: 'PurchaseStatus.completed', ...fields });
  const orders = [
    order({ clientId: 'x', source: 'agent' }),
    order({ clientId: 'x', origem: 'agente_ia', isTest: true }),
    order({ clientId: 'c1' }),
    order({ clientId: 'c1', currentPurchaseStatus: 'PurchaseStatus.accepted' }),
    order({ clientId: 'c1', createdAt: at('2026-09-01T12:30:00Z') }),
    order({ clientId: 'c1', createdAt: at('2026-09-01T09:00:00Z') }),
    order({ clientId: 'c2' }),
    order({ clientId: 'c3' }),
  ];

  assert.deepEqual(
    summarizeAgentOrders(orders, conversations, { testAccountIds: new Set(['c2']) }),
    { marcados: 1, provaveis: 2, provaveisConcluidos: 1 },
  );
});
