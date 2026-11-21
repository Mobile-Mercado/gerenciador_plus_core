const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ORIGEM,
  promocaoVencidaForaDoErp,
  removerPromocoesVencidasDaLoja,
} = require('./promocaoVencida');

// Cola 65, item 3.8. Falham com o codigo de antes: promocaoVencida.js e a rotina nao existiam.

const AGORA = new Date('2026-11-21T03:05:00.000Z'); // 00:05 em Sao Paulo
const ONTEM = Date.parse('2026-11-21T02:59:59.000Z');
const AMANHA = Date.parse('2026-11-22T02:59:59.000Z');

// Timestamp de mentira com toMillis, como o do firebase-admin.
const carimbo = (ms) => ({ toMillis: () => ms, ms });
const Timestamp = { fromMillis: carimbo };
const FieldValue = { serverTimestamp: () => ({ servidor: true }) };

function bancoFalso(produtos, { aoLerNaTransacao = null } = {}) {
  const docs = new Map(Object.entries(produtos).map(([id, dados]) => [`estabelecimentos/zg/Products/${id}`, { ...dados }]));
  const acoes = [];
  let proximo = 0;
  const ref = (caminho) => ({
    id: caminho.split('/').at(-1),
    path: caminho,
    collection: (nome) => colecao(`${caminho}/${nome}`),
  });
  const colecao = (caminho) => ({
    doc: (id) => {
      proximo += 1;
      return ref(`${caminho}/${id || `novo-${proximo}`}`);
    },
    where: (campo, op, valor) => {
      assert.equal(campo, 'promotionEndAt');
      assert.equal(op, '<');
      return {
        get: async () => ({
          docs: [...docs.entries()]
            .filter(([chave, dados]) => chave.startsWith(`${caminho}/`) && dados.promotionEndAt && dados.promotionEndAt.toMillis() < valor.toMillis())
            .map(([chave, dados]) => ({ id: chave.split('/').at(-1), ref: ref(chave), data: () => ({ ...dados }) })),
        }),
      };
    },
  });
  const db = {
    collection: (nome) => colecao(nome),
    runTransaction: async (corpo) => {
      const escritas = [];
      const transacao = {
        get: async (alvo) => {
          if (aoLerNaTransacao) aoLerNaTransacao(alvo, docs);
          const dados = docs.get(alvo.path);
          return { exists: dados !== undefined, data: () => ({ ...dados }) };
        },
        update: (alvo, dados) => escritas.push(() => Object.assign(docs.get(alvo.path), dados)),
        create: (alvo, dados) => escritas.push(() => acoes.push({ caminho: alvo.path, ...dados })),
      };
      const resultado = await corpo(transacao);
      escritas.forEach((escrever) => escrever());
      return resultado;
    },
  };
  return { db, docs, acoes, produto: (id) => docs.get(`estabelecimentos/zg/Products/${id}`) };
}

const promocao = (extra = {}) => ({
  name: 'Produto',
  currentPrice: 10,
  promotionalPrice: 7.5,
  promotionStartAt: carimbo(ONTEM - 86400000),
  promotionEndAt: carimbo(ONTEM),
  ...extra,
});

test('3.8: so a promocao vencida que nao veio do ERP entra', () => {
  const agora = AGORA.getTime();
  assert.equal(promocaoVencidaForaDoErp(promocao(), agora), true, 'sem promotionSource (como as de hoje na Zero Grau)');
  assert.equal(promocaoVencidaForaDoErp(promocao({ promotionSource: null }), agora), true);
  assert.equal(promocaoVencidaForaDoErp(promocao({ promotionSource: 'erp' }), agora), false, 'ERP fica');
  assert.equal(promocaoVencidaForaDoErp(promocao({ promotionSource: ' ERP ' }), agora), false);
  assert.equal(promocaoVencidaForaDoErp(promocao({ promotionEndAt: carimbo(AMANHA) }), agora), false, 'ainda vale');
  assert.equal(promocaoVencidaForaDoErp(promocao({ promotionEndAt: null }), agora), false, 'sem fim');
  assert.equal(promocaoVencidaForaDoErp(promocao({ promotionalPrice: null }), agora), false, 'sem preco promocional');
  assert.equal(promocaoVencidaForaDoErp(promocao({ promotionEndAt: { seconds: ONTEM / 1000 } }), agora), true);
});

test('3.8: a rotina tira a promocao vencida, mantem a do ERP e a que vale, e registra no Log', async () => {
  const banco = bancoFalso({
    vencida: promocao({ name: 'Vencida' }),
    doErp: promocao({ promotionSource: 'erp' }),
    valendo: promocao({ promotionEndAt: carimbo(AMANHA) }),
    semPreco: promocao({ promotionalPrice: null }),
  });
  const resultado = await removerPromocoesVencidasDaLoja({ db: banco.db, FieldValue, Timestamp, lojaId: 'zg', agora: AGORA });
  assert.deepEqual(resultado, { vencidas: 1, removidas: 1, falhas: 0 });

  const vencida = banco.produto('vencida');
  assert.equal(vencida.promotionalPrice, null);
  assert.equal(vencida.promotionStartAt, null);
  assert.equal(vencida.promotionEndAt, null);
  assert.equal(vencida.promotionSource, null);
  assert.deepEqual(vencida.updatedAt, { servidor: true });
  assert.equal(vencida.currentPrice, 10, 'o preco normal nao muda');
  assert.equal(banco.produto('doErp').promotionalPrice, 7.5);
  assert.equal(banco.produto('valendo').promotionalPrice, 7.5);
  assert.equal(banco.produto('semPreco').promotionEndAt.toMillis(), ONTEM);

  assert.equal(banco.acoes.length, 1);
  const [acao] = banco.acoes;
  assert.match(acao.caminho, /^estabelecimentos\/zg\/AcoesEquipe\//);
  assert.equal(acao.origem, ORIGEM);
  assert.equal(acao.origem, 'removerPromocaoVencidaNightly');
  assert.equal(acao.acao, 'produto.editar');
  assert.equal(acao.tela, 'produtos');
  assert.equal(acao.quem, '');
  assert.deepEqual(acao.em, { servidor: true });
  assert.deepEqual(acao.alvo, { tipo: 'produto', id: 'vencida', rotulo: 'Vencida' });
  // promotionSource ausente nao muda (null e ausente sao iguais): fica fora do antes e do depois.
  assert.deepEqual(Object.keys(acao.antes).sort(), ['promotionEndAt', 'promotionStartAt', 'promotionalPrice']);
  assert.equal(acao.antes.promotionalPrice, 7.5);
  assert.equal(acao.antes.promotionEndAt.toMillis(), ONTEM);
  assert.deepEqual(acao.depois, { promotionalPrice: null, promotionStartAt: null, promotionEndAt: null });
});

test('3.8: se a promocao mudou entre a consulta e a gravacao, nada e gravado', async () => {
  const banco = bancoFalso({ vencida: promocao() }, {
    // O lojista renovou a promocao enquanto a rotina rodava.
    aoLerNaTransacao: (_alvo, docs) => { docs.get('estabelecimentos/zg/Products/vencida').promotionEndAt = carimbo(AMANHA); },
  });
  const resultado = await removerPromocoesVencidasDaLoja({ db: banco.db, FieldValue, Timestamp, lojaId: 'zg', agora: AGORA });
  assert.deepEqual(resultado, { vencidas: 1, removidas: 0, falhas: 0 });
  assert.equal(banco.produto('vencida').promotionalPrice, 7.5);
  assert.equal(banco.acoes.length, 0);
});

test('3.8: index.js agenda a rotina na madrugada de Sao Paulo, sem colidir com as outras', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  assert.match(index, /exports\.removerPromocaoVencidaNightly = onSchedule\(\s+\{\s+schedule: '5 0 \* \* \*',\s+timeZone: 'America\/Sao_Paulo'/);
  const horarios = [...index.matchAll(/schedule: '([^']+)'/g)].map((achado) => achado[1]);
  assert.equal(horarios.filter((horario) => horario === '5 0 * * *').length, 1);
  assert.ok(index.includes('removerPromocoesVencidasDaLoja({'));
});
