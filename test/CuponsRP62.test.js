import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { ManageCoupons, OBJETIVOS_PADRAO } from '../src/application/coupons/ManageCoupons.js';
import { FirestoreCouponRepository } from '../src/infra/firebase/FirestoreCouponRepository.js';
import { createCouponRoutes } from '../src/http/routes/couponRoutes.js';
import { errorHandler } from '../src/http/middlewares/errorHandler.js';
import { AppError } from '../src/domain/errors/AppError.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Cadastro de cupom da RP-62 (contrato K5), pela rota, com o repositorio de verdade sobre o banco
// em memoria.

const LOJA = 'loja-1';

const cupomValido = {
  objetivo: 'Atrair clientes novos',
  code: 'BEMVINDO',
  description: '10% na primeira compra',
  termsText: 'Uma vez por cliente.',
  firstPurchaseOnly: true,
  discount: { kind: 'percentage', value: 10 },
  startAt: '2026-10-28T00:00:00.000Z',
  endAt: '2026-11-30T23:59:59.000Z',
};

async function subirRota({ banco = new FirestoreEmMemoria({ [`estabelecimentos/${LOJA}`]: { name: 'Loja 1' } }), auth = { uid: 'uid-dono' }, conta = {}, chaves = null } = {}) {
  const manageCoupons = new ManageCoupons({
    couponRepository: new FirestoreCouponRepository({ firestore: banco }),
    accessRepository: { findAccountByUid: async () => null },
    clock: () => new Date('2026-10-28T17:32:00.000Z'),
  });
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = auth; next(); });
  app.use('/api/coupons', createCouponRoutes({
    manageCoupons,
    // Sem `chaves`, tudo passa; com elas, so a chave da lista.
    requirePermission: (chave) => (_request, _response, next) => next(
      !chaves || chaves.includes(chave) ? undefined : new AppError('sem', { statusCode: 403, code: 'permission_denied' }),
    ),
    accountForRequest: async () => ({ establishmentId: LOJA, hasEstablishment: true, ...conta }),
  }));
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}/api/coupons`;
  const chamar = async (caminho, { method = 'GET', body } = {}) => {
    const resposta = await fetch(`${base}${caminho}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: resposta.status, corpo: await resposta.json() };
  };
  return {
    banco,
    chamar,
    fechar: () => { servidor.closeAllConnections(); servidor.close(); },
  };
}

const docsDe = (banco, colecao) => [...banco.docs.keys()].filter((caminho) => caminho.startsWith(`${colecao}/`));

test('D.1: objetivo obrigatorio (1 a 40 letras) ao criar e ao editar, gravado so nos bastidores', async () => {
  const rota = await subirRota();
  try {
    const { objetivo, ...semObjetivo } = cupomValido;
    assert.equal((await rota.chamar('', { method: 'POST', body: semObjetivo })).status, 400);
    assert.equal((await rota.chamar('', { method: 'POST', body: { ...cupomValido, objetivo: '   ' } })).status, 400);
    assert.equal((await rota.chamar('', { method: 'POST', body: { ...cupomValido, objetivo: 'x'.repeat(41) } })).status, 400);
    assert.equal(docsDe(rota.banco, 'Coupons').length, 0, 'recusa nao grava');

    const criado = await rota.chamar('', { method: 'POST', body: { ...cupomValido, objetivo: `  ${'a'.repeat(40)}  ` } });
    assert.equal(criado.status, 201);
    const { id } = criado.corpo.data;
    assert.equal(criado.corpo.data.objetivo, 'a'.repeat(40));

    // O app do cliente le o Coupons/{id}: o objetivo nao vai la.
    const doCliente = rota.banco.dados(`Coupons/${id}`);
    assert.equal(doCliente.code, 'BEMVINDO');
    assert.ok(!('objetivo' in doCliente));
    assert.equal(rota.banco.dados(`CuponsBastidores/${id}`).objetivo, 'a'.repeat(40));

    // Editar: sem objetivo, recusa; com objetivo, troca nos bastidores e nada dele no Coupons.
    assert.equal((await rota.chamar(`/${id}`, { method: 'PATCH', body: { description: 'Outra' } })).status, 400);
    const editado = await rota.chamar(`/${id}`, { method: 'PATCH', body: { objetivo: 'Data comemorativa', description: 'Outra' } });
    assert.equal(editado.status, 200);
    assert.equal(rota.banco.dados(`CuponsBastidores/${id}`).objetivo, 'Data comemorativa');
    assert.equal(rota.banco.dados(`Coupons/${id}`).description, 'Outra');
    assert.ok(!('objetivo' in rota.banco.dados(`Coupons/${id}`)));
    // So o objetivo: o Coupons/{id} nao e regravado.
    const escritasAntes = rota.banco.escritas.length;
    assert.equal((await rota.chamar(`/${id}`, { method: 'PATCH', body: { objetivo: 'Vender produto parado' } })).status, 200);
    assert.deepEqual(rota.banco.escritas.slice(escritasAntes).map((escrita) => escrita.caminho), [`CuponsBastidores/${id}`]);

    // A lista e o GET de um cupom devolvem o objetivo.
    const lista = await rota.chamar('');
    assert.deepEqual(lista.corpo.data.map((cupom) => [cupom.id, cupom.objetivo]), [[id, 'Vender produto parado']]);
    const um = await rota.chamar(`/${id}`);
    assert.equal(um.status, 200);
    assert.equal(um.corpo.data.objetivo, 'Vender produto parado');
    assert.equal(um.corpo.data.code, 'BEMVINDO');
  } finally {
    rota.fechar();
  }
});

test('D.1: cupom antigo, sem bastidores, sai com objetivo null; cupom de outra loja nao abre', async () => {
  const banco = new FirestoreEmMemoria({
    [`estabelecimentos/${LOJA}`]: { name: 'Loja 1' },
    'Coupons/antigo': { code: 'ANTIGO', establishmentIds: [LOJA], active: true },
    'Coupons/alheio': { code: 'ALHEIO', establishmentIds: ['loja-2'], active: true },
  });
  const rota = await subirRota({ banco });
  try {
    const lista = await rota.chamar('');
    assert.deepEqual(lista.corpo.data.map((cupom) => [cupom.id, cupom.objetivo]), [['antigo', null]]);
    assert.equal((await rota.chamar('/antigo')).corpo.data.objetivo, null);
    assert.equal((await rota.chamar('/alheio')).status, 403);
    assert.equal((await rota.chamar('/nao-existe')).status, 404);
  } finally {
    rota.fechar();
  }
});

test('D.1: GET /api/coupons/objetivos devolve os cinco padrao e os da loja', async () => {
  const banco = new FirestoreEmMemoria({
    [`estabelecimentos/${LOJA}`]: { name: 'Loja 1' },
    [`estabelecimentos/${LOJA}/ObjetivosDeCupom/o1`]: { nome: 'Aniversário da loja' },
    'estabelecimentos/loja-2/ObjetivosDeCupom/o9': { nome: 'De outra loja' },
  });
  const rota = await subirRota({ banco });
  try {
    const resposta = await rota.chamar('/objetivos');
    assert.equal(resposta.status, 200);
    assert.deepEqual(resposta.corpo.data, {
      padrao: ['Atrair clientes novos', 'Trazer de volta quem sumiu', 'Aumentar o valor da compra', 'Vender produto parado', 'Data comemorativa'],
      daLoja: [{ id: 'o1', nome: 'Aniversário da loja' }],
    });
    assert.deepEqual(resposta.corpo.data.padrao, [...OBJETIVOS_PADRAO]);
  } finally {
    rota.fechar();
  }
});

test('D.1: excluir o cupom apaga tambem os bastidores', async () => {
  const rota = await subirRota();
  try {
    const { id } = (await rota.chamar('', { method: 'POST', body: cupomValido })).corpo.data;
    assert.equal((await rota.chamar(`/${id}`, { method: 'DELETE' })).status, 200);
    assert.equal(rota.banco.dados(`Coupons/${id}`), undefined);
    assert.equal(rota.banco.dados(`CuponsBastidores/${id}`), undefined);
  } finally {
    rota.fechar();
  }
});

test('D.2: "+ Novo objetivo" grava na loja (ate 40 letras), aparece na lista e vale no cupom', async () => {
  const rota = await subirRota();
  try {
    assert.equal((await rota.chamar('/objetivos', { method: 'POST', body: { nome: 'x'.repeat(41) } })).status, 400);
    assert.equal((await rota.chamar('/objetivos', { method: 'POST', body: { nome: '  ' } })).status, 400);
    assert.equal((await rota.chamar('/objetivos', { method: 'POST', body: {} })).status, 400);

    const novo = await rota.chamar('/objetivos', { method: 'POST', body: { nome: '  Aniversário da loja ' } });
    assert.equal(novo.status, 201);
    assert.deepEqual(Object.keys(novo.corpo.data).sort(), ['id', 'nome']);
    assert.equal(novo.corpo.data.nome, 'Aniversário da loja');
    const gravado = rota.banco.dados(`estabelecimentos/${LOJA}/ObjetivosDeCupom/${novo.corpo.data.id}`);
    assert.equal(gravado.nome, 'Aniversário da loja');
    assert.equal(gravado.criadoPorUid, 'uid-dono');

    // O mesmo nome de novo (sem acento, outra caixa) devolve o que ja existe.
    const repetido = await rota.chamar('/objetivos', { method: 'POST', body: { nome: 'aniversario DA loja' } });
    assert.deepEqual(repetido.corpo.data, novo.corpo.data);
    assert.equal(docsDe(rota.banco, `estabelecimentos/${LOJA}/ObjetivosDeCupom`).length, 1);

    const lista = await rota.chamar('/objetivos');
    assert.deepEqual(lista.corpo.data.daLoja, [novo.corpo.data]);

    const cupom = await rota.chamar('', { method: 'POST', body: { ...cupomValido, objetivo: novo.corpo.data.nome } });
    assert.equal(cupom.status, 201);
    assert.equal(rota.banco.dados(`CuponsBastidores/${cupom.corpo.data.id}`).objetivo, 'Aniversário da loja');
  } finally {
    rota.fechar();
  }
});

test('D.2: criar objetivo pede coupons.manage; ver os objetivos, nao', async () => {
  const rota = await subirRota({ chaves: ['coupons.view'] });
  try {
    assert.equal((await rota.chamar('/objetivos', { method: 'POST', body: { nome: 'Black Friday' } })).status, 403);
    assert.equal(docsDe(rota.banco, `estabelecimentos/${LOJA}/ObjetivosDeCupom`).length, 0);
    assert.equal((await rota.chamar('/objetivos')).status, 200);
  } finally {
    rota.fechar();
  }
});

test('D.3: sem regra marcada e sem texto, 400 cupom_sem_regra com a frase da cola; a duracao nao conta', async () => {
  const rota = await subirRota();
  try {
    const { firstPurchaseOnly, termsText, ...semRegra } = cupomValido;
    const recusas = [
      ['nada', {}],
      ['so a duracao', { endAt: '2026-12-31T23:59:59.000Z' }],
      ['texto em branco', { termsText: '   ' }],
      ['primeiro pedido desmarcado', { firstPurchaseOnly: false }],
      ['produto e categoria nao sao regra', { rules: [{ type: 'product', productIds: ['p1'] }, { type: 'category', categoryIds: ['c1'] }] }],
    ];
    for (const [caso, extra] of recusas) {
      const resposta = await rota.chamar('', { method: 'POST', body: { ...semRegra, ...extra } });
      assert.equal(resposta.status, 400, caso);
      assert.equal(resposta.corpo.error.code, 'cupom_sem_regra', caso);
      assert.equal(resposta.corpo.error.message, 'Marque pelo menos uma regra acima ou escreva as regras da promoção.', caso);
    }
    assert.equal(docsDe(rota.banco, 'Coupons').length, 0, 'recusa nao grava');

    const aceitos = [
      ['primeiro pedido', { firstPurchaseOnly: true }],
      ['valor minimo', { rules: [{ type: 'minValue', minValue: 50 }] }],
      ['faixa de quantidade', { rules: [{ type: 'quantityRange', minQuantity: 2, maxQuantity: null }] }],
      ['frete', { discount: null, rules: [{ type: 'freight', freeShipping: true }] }],
      ['so o texto', { termsText: 'Válido nas compras de sexta.' }],
    ];
    for (const [indice, [caso, extra]] of aceitos.entries()) {
      const resposta = await rota.chamar('', { method: 'POST', body: { ...semRegra, code: `REGRA${indice}`, ...extra } });
      assert.equal(resposta.status, 201, caso);
    }
  } finally {
    rota.fechar();
  }
});

test('D.3: na edicao, o PATCH que mexe nas regras nao deixa o cupom sem regra', async () => {
  const banco = new FirestoreEmMemoria({
    [`estabelecimentos/${LOJA}`]: { name: 'Loja 1' },
    'Coupons/c1': { code: 'PRIMEIRA', establishmentIds: [LOJA], active: true, firstPurchaseOnly: true, rules: [], termsText: null },
    'Coupons/antigo': { code: 'ANTIGO', establishmentIds: [LOJA], active: true, firstPurchaseOnly: false, rules: [] },
  });
  const rota = await subirRota({ banco });
  try {
    const objetivo = 'Atrair clientes novos';
    const tirarTudo = await rota.chamar('/c1', { method: 'PATCH', body: { objetivo, firstPurchaseOnly: false, rules: [], termsText: '' } });
    assert.equal(tirarTudo.status, 400);
    assert.equal(tirarTudo.corpo.error.code, 'cupom_sem_regra');
    assert.equal(rota.banco.dados('Coupons/c1').firstPurchaseOnly, true, 'recusa nao grava');
    assert.equal(rota.banco.dados('CuponsBastidores/c1'), undefined, 'recusa nao grava os bastidores');

    assert.equal((await rota.chamar('/c1', { method: 'PATCH', body: { objetivo, firstPurchaseOnly: false, rules: [{ type: 'minValue', minValue: 80 }] } })).status, 200);
    assert.equal((await rota.chamar('/c1', { method: 'PATCH', body: { objetivo, rules: [], termsText: 'Só no balcão.' } })).status, 200);
    // O PATCH que nao mexe nas regras (so o objetivo e a descricao) passa no cupom antigo sem regra.
    assert.equal((await rota.chamar('/antigo', { method: 'PATCH', body: { objetivo, description: 'Novo título' } })).status, 200);
  } finally {
    rota.fechar();
  }
});

test('D.4: ao criar, os bastidores guardam quem criou e quando; editar nao muda; a resposta traz so o nome', async () => {
  const banco = new FirestoreEmMemoria({
    [`estabelecimentos/${LOJA}`]: { name: 'Loja 1' },
    'Coupons/antigo': { code: 'ANTIGO', establishmentIds: [LOJA], active: true, firstPurchaseOnly: true },
  });
  const daAna = await subirRota({ banco, auth: { uid: 'uid-ana' }, conta: { nome: 'Ana Souza' } });
  const daBia = await subirRota({ banco, auth: { uid: 'uid-bia' }, conta: { nome: 'Bia Lima' } });
  try {
    const criado = await daAna.chamar('', { method: 'POST', body: { ...cupomValido, criadoPorNome: 'Outro', actorNome: 'Outro' } });
    assert.equal(criado.status, 201);
    const { id } = criado.corpo.data;
    assert.deepEqual(criado.corpo.data.criadoPor, { nome: 'Ana Souza' });
    assert.equal(criado.corpo.data.criadoEm, '2026-10-28T17:32:00.000Z');

    const bastidores = banco.dados(`CuponsBastidores/${id}`);
    assert.equal(bastidores.criadoPorUid, 'uid-ana');
    assert.equal(bastidores.criadoPorNome, 'Ana Souza');
    // Gravado como Timestamp (o banco em memoria guarda os segundos).
    assert.equal(new Date(bastidores.criadoEm._seconds * 1000).toISOString(), '2026-10-28T17:32:00.000Z');
    // Nada disso no documento que o app do cliente le.
    const doCliente = banco.dados(`Coupons/${id}`);
    ['objetivo', 'criadoPorUid', 'criadoPorNome', 'criadoEm', 'criadoPor'].forEach((campo) => assert.ok(!(campo in doCliente), campo));

    // A Bia edita: quem criou continua a Ana.
    assert.equal((await daBia.chamar(`/${id}`, { method: 'PATCH', body: { objetivo: 'Data comemorativa', description: 'Editado' } })).status, 200);
    const depois = banco.dados(`CuponsBastidores/${id}`);
    assert.equal(depois.criadoPorUid, 'uid-ana');
    assert.equal(depois.criadoPorNome, 'Ana Souza');
    assert.equal(depois.objetivo, 'Data comemorativa');

    const um = (await daBia.chamar(`/${id}`)).corpo.data;
    assert.deepEqual([um.criadoPor, um.criadoEm], [{ nome: 'Ana Souza' }, '2026-10-28T17:32:00.000Z']);
    const lista = (await daBia.chamar('')).corpo.data;
    const antigo = lista.find((cupom) => cupom.id === 'antigo');
    assert.deepEqual([antigo.criadoPor, antigo.criadoEm], [null, null], 'cupom sem o dado fica sem a linha');
    assert.ok(!JSON.stringify(lista).includes('uid-ana'), 'o uid de quem criou nao sai');

    // Editar um cupom antigo nao inventa quem criou.
    assert.equal((await daBia.chamar('/antigo', { method: 'PATCH', body: { objetivo: 'Data comemorativa', description: 'X' } })).status, 200);
    assert.deepEqual(banco.dados('CuponsBastidores/antigo'), { objetivo: 'Data comemorativa' });
    assert.equal((await daBia.chamar('/antigo')).corpo.data.criadoPor, null);
  } finally {
    daAna.fechar();
    daBia.fechar();
  }
});

test('D.4: sem nome na conta, vale o nome do token; sem nenhum, criadoPor null', async () => {
  const doToken = await subirRota({ auth: { uid: 'uid-1', name: 'Caio Prado' } });
  const semNome = await subirRota({ auth: { uid: 'uid-2' } });
  try {
    assert.deepEqual((await doToken.chamar('', { method: 'POST', body: cupomValido })).corpo.data.criadoPor, { nome: 'Caio Prado' });
    const criado = (await semNome.chamar('', { method: 'POST', body: cupomValido })).corpo.data;
    assert.equal(criado.criadoPor, null);
    assert.equal(criado.criadoEm, '2026-10-28T17:32:00.000Z');
  } finally {
    doToken.fechar();
    semNome.fechar();
  }
});

test('D.4: a conta da requisicao traz o nome do dono (Users) e do funcionario (AdminUsers)', async () => {
  const { createPermissionGuard } = await import('../src/http/middlewares/requirePermission.js');
  const contas = {
    dono: { establishmentId: LOJA, hasEstablishment: true, userDocument: { name: 'Dono da Loja', nome: null } },
    func: { establishmentId: LOJA, hasEstablishment: true, userDocument: { name: 'Ana Souza', nome: 'Ana Souza' }, permissions: { isAdmin: false, keys: [] } },
    semNome: { establishmentId: LOJA, hasEstablishment: true, userDocument: null },
  };
  const { accountForRequest } = createPermissionGuard({ accessRepository: { findAccountByClaims: async ({ uid }) => contas[uid] } });
  const nomeDe = async (uid) => (await accountForRequest({ headers: {}, auth: { uid } })).nome;
  assert.equal(await nomeDe('dono'), 'Dono da Loja');
  assert.equal(await nomeDe('func'), 'Ana Souza');
  assert.equal(await nomeDe('semNome'), null);
});
