import assert from 'node:assert/strict';
import test from 'node:test';
import { HistoricoDoProduto } from '../src/application/produtos/HistoricoDoProduto.js';
import { FirestoreHistoricoDoProdutoRepository } from '../src/infra/firebase/FirestoreHistoricoDoProdutoRepository.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';
import { AuthEmMemoria } from './apoio/authEmMemoria.js';

// Cola 71, item 2 (5.4): o dono da loja fora da Equipe (estabelecimentos/{loja}/AdminUsers) aparece
// no "Quem" do Historico com o nome do cadastro: o Users apontado em
// estabelecimentos/{loja}.userReference, campo name (cadastro antigo: nome). Sem nome, o e-mail.
// Nunca o uid, e nenhum outro dado do dono. Falha com o codigo de antes (o dono saia com o e-mail).
// Dados de exemplo.

const LOJA = 'loja-1';
const OUTRA = 'loja-2';
const UID_DONO = 'uidDono0000000000000000001';
const UID_DONO_OUTRA = 'uidDonoOutra000000000000002';
const UID_FUNC = 'uidFunc0000000000000000003';

const linha = (id, quem, minuto, loja = LOJA) => [`estabelecimentos/${loja}/AcoesEquipe/${id}`, {
  em: new Date(Date.UTC(2026, 10, 20, 12, minuto)), quem, tela: 'produtos', acao: 'produto.editar',
  alvo: { tipo: 'produto', id: 'p1', rotulo: 'Batata' }, antes: { name: 'a' }, depois: { name: 'b' }, origem: 'manual',
}];

function banco({ dono = {}, referencia = { id: 'dono-doc', path: 'Users/dono-doc' }, equipe = [] } = {}) {
  return new FirestoreEmMemoria(Object.fromEntries([
    [`estabelecimentos/${LOJA}`, { name: 'Loja 1', userReference: referencia }],
    [`estabelecimentos/${OUTRA}`, { name: 'Loja 2', userReference: { id: 'dono-outra', path: 'Users/dono-outra' } }],
    ['Users/dono-doc', { userAuthId: UID_DONO, email: 'dono@loja.com', name: 'Carlos Dono', cpf: 'CPF-DONO', phone: 'TEL-DONO', ...dono }],
    // Dono de outra loja: nao e dono desta, segue a regra de antes (e-mail).
    ['Users/dono-outra', { userAuthId: UID_DONO_OUTRA, email: 'outro-dono@loja.com', name: 'Dono De Outra' }],
    ['Users/func-doc', { userAuthId: UID_FUNC, email: 'func@loja.com', name: 'Nome No Users' }],
    ...equipe,
    linha('l1', UID_DONO, 1),
    linha('l2', 'dono@loja.com', 2),
    linha('l3', 'DONO@Loja.com', 3),
    linha('l4', UID_DONO_OUTRA, 4),
    linha('l5', UID_FUNC, 5),
  ]));
}

const ator = { establishmentId: LOJA, hasEstablishment: true };

async function quens(firestore) {
  const historico = new HistoricoDoProduto({ repositorio: new FirestoreHistoricoDoProdutoRepository({ firestore, auth: new AuthEmMemoria([]) }) });
  const resultado = await historico.listar({ ator, produtoId: 'p1' });
  return { resultado, porId: Object.fromEntries(resultado.linhas.map((l) => [l.id, l.quem])) };
}

test('Cola 71, item 2: dono fora da Equipe com o nome do cadastro (Users.name), pelo uid ou pelo e-mail', async () => {
  const { resultado, porId } = await quens(banco());
  assert.deepEqual(porId, {
    l1: 'Carlos Dono', // uid do dono
    l2: 'Carlos Dono', // e-mail do dono
    l3: 'Carlos Dono', // e-mail com maiusculas
    l4: 'outro-dono@loja.com', // dono de outra loja: nao e dono desta
    l5: 'func@loja.com', // conta que nao e o dono nem da Equipe: e-mail, como antes
  });
  const corpo = JSON.stringify(resultado);
  for (const proibido of ['uid', 'CPF-DONO', 'TEL-DONO', '"dono@loja.com"', 'DONO@', 'dono-doc', 'Users/']) {
    assert.ok(!corpo.includes(proibido), `nao sai: ${proibido}`);
  }
});

test('Cola 71, item 2: cadastro antigo (Users.nome) e, sem nome, o e-mail; nunca o uid', async () => {
  let r = await quens(banco({ dono: { name: undefined, nome: 'Dona Antiga' } }));
  assert.equal(r.porId.l1, 'Dona Antiga');
  assert.equal(r.porId.l2, 'Dona Antiga');
  r = await quens(banco({ dono: { name: '   ', nome: '' } }));
  assert.equal(r.porId.l1, 'dono@loja.com');
  assert.equal(r.porId.l2, 'dono@loja.com');
  r = await quens(banco({ dono: { name: '', email: '' } }));
  assert.equal(r.porId.l1, ''); // sem nome e sem e-mail: vazio, nunca o uid
  assert.ok(!JSON.stringify(r.resultado).includes('uid'));
});

test('Cola 71, item 2: quem esta na Equipe continua com o nome da Equipe', async () => {
  const { porId } = await quens(banco({
    equipe: [[`estabelecimentos/${LOJA}/AdminUsers/${UID_DONO}`, { firstName: 'Carlos', lastName: 'Na Equipe', email: 'dono@loja.com' }]],
  }));
  assert.equal(porId.l1, 'Carlos Na Equipe');
  assert.equal(porId.l2, 'Carlos Na Equipe');
});

test('Cola 71, item 2: loja sem userReference, referencia fora de Users ou leitura que falha: regra de antes', async () => {
  for (const referencia of [null, { id: 'dono-doc', path: 'Outra/dono-doc' }, 'Users/inexistente']) {
    const { porId } = await quens(banco({ referencia }));
    assert.equal(porId.l1, 'dono@loja.com');
    assert.equal(porId.l2, 'dono@loja.com');
  }
  // Referencia em texto tambem vale.
  assert.equal((await quens(banco({ referencia: 'Users/dono-doc' }))).porId.l1, 'Carlos Dono');
  const repositorio = new FirestoreHistoricoDoProdutoRepository({ firestore: banco(), auth: new AuthEmMemoria([]) });
  repositorio.donoDaLoja = async () => { throw new Error('falhou'); };
  const resultado = await new HistoricoDoProduto({ repositorio }).listar({ ator, produtoId: 'p1' });
  assert.equal(resultado.linhas.find((l) => l.id === 'l1').quem, 'dono@loja.com');
});

test('Cola 71, item 2: o dono e lido uma vez so por pedido', async () => {
  const repositorio = new FirestoreHistoricoDoProdutoRepository({ firestore: banco(), auth: new AuthEmMemoria([]) });
  const original = repositorio.donoDaLoja.bind(repositorio);
  let leituras = 0;
  repositorio.donoDaLoja = async (...args) => { leituras += 1; return original(...args); };
  await new HistoricoDoProduto({ repositorio }).listar({ ator, produtoId: 'p1' });
  assert.equal(leituras, 1);
});
