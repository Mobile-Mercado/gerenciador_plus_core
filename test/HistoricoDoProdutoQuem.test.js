import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { HistoricoDoProduto, tipoDoQuem } from '../src/application/produtos/HistoricoDoProduto.js';
import { FirestoreHistoricoDoProdutoRepository } from '../src/infra/firebase/FirestoreHistoricoDoProdutoRepository.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';
import { AuthEmMemoria } from './apoio/authEmMemoria.js';

// Cola 70, item 8 (5.4): "Quem" do Historico do produto mostra o nome da pessoa cadastrada na
// Equipe da loja (estabelecimentos/{loja}/AdminUsers); sem cadastro, o e-mail; nunca o uid. O Core
// resolve na rota, e so o nome sai da Equipe. Dados de exemplo.

const LOJA = 'loja-1';
const OUTRA = 'loja-2';
const linha = (id, quem, origem = 'manual', minuto = 0) => [`estabelecimentos/${LOJA}/AcoesEquipe/${id}`, {
  em: new Date(Date.UTC(2026, 10, 20, 12, minuto)), quem, tela: 'produtos', acao: 'produto.editar',
  alvo: { tipo: 'produto', id: 'p1', rotulo: 'Batata' }, antes: { name: 'a' }, depois: { name: 'b' }, origem,
}];

function banco() {
  return new FirestoreEmMemoria(Object.fromEntries([
    [`estabelecimentos/${LOJA}`, { name: 'Loja 1' }],
    // Equipe da loja: uma pessoa com uid e e-mail, outra so achada pelo e-mail gravado.
    [`estabelecimentos/${LOJA}/AdminUsers/uidFernanda0000000000000001`, { firstName: 'Fernanda', lastName: 'Lima', email: 'fernanda@loja.com', cpf: 'CPF-FERNANDA', phone: 'TEL-FERNANDA', active: true }],
    [`estabelecimentos/${LOJA}/AdminUsers/uidThay00000000000000000002`, { firstName: 'Thay', lastName: '', email: 'thay@loja.com', cpf: 'CPF-THAY', active: false }],
    // Pessoa da Equipe de outra loja: nao vale aqui.
    [`estabelecimentos/${OUTRA}/AdminUsers/uidOutra000000000000000003`, { firstName: 'Outra', email: 'outra@loja.com' }],
    // Dono sem cadastro na Equipe: o e-mail vem do Users.
    ['Users/dono-doc', { userAuthId: 'uidDono0000000000000000004', email: 'dono@loja.com', name: 'Dono' }],
    linha('l1', 'uidFernanda0000000000000001', 'app', 1),
    linha('l2', 'thay@loja.com', 'manual', 2),
    linha('l3', 'uidDono0000000000000000004', 'manual', 3),
    linha('l4', 'uidAuth0000000000000000005', 'manual', 4),
    linha('l5', 'uidSemNada00000000000000006', 'manual', 5),
    linha('l6', 'semcadastro@loja.com', 'manual', 6),
    linha('l7', 'Linear', 'integrador', 7),
    linha('l8', '', 'removerPromocaoVencidaNightly', 8),
    linha('l9', 'uidOutra000000000000000003', 'manual', 9),
    linha('l10', 'Fernanda@Loja.com', 'manual', 10),
  ]));
}

const auth = () => new AuthEmMemoria([{ uid: 'uidAuth0000000000000000005', email: 'pelo-auth@loja.com' }]);

test('Cola 70, item 8: quem com o nome da Equipe, o e-mail sem cadastro e nunca o uid', async () => {
  const historico = new HistoricoDoProduto({ repositorio: new FirestoreHistoricoDoProdutoRepository({ firestore: banco(), auth: auth() }) });
  const resultado = await historico.listar({ ator: { establishmentId: LOJA, hasEstablishment: true }, produtoId: 'p1' });
  const porId = Object.fromEntries(resultado.linhas.map((l) => [l.id, l.quem]));
  assert.deepEqual(porId, {
    l1: 'Fernanda Lima', // uid na Equipe
    l2: 'Thay', // e-mail na Equipe (cadastro desativado continua com o nome)
    l3: 'dono@loja.com', // uid fora da Equipe: e-mail do Users
    l4: 'pelo-auth@loja.com', // uid fora da Equipe e do Users: e-mail do Auth
    l5: '', // uid sem e-mail em lugar nenhum: vazio, nunca o uid
    l6: 'semcadastro@loja.com', // e-mail sem cadastro
    l7: 'Linear', // ERP continua "Linear"
    l8: '', // rotina
    l9: '', // pessoa da Equipe de outra loja nao vale aqui; sem e-mail, vazio
    l10: 'Fernanda Lima', // e-mail gravado com maiusculas
  });
  const corpo = JSON.stringify(resultado);
  for (const proibido of ['uidFernanda', 'uidDono', 'uidAuth', 'uidSemNada', 'uidOutra', 'Outra', 'CPF-', 'TEL-', 'cpf', 'phone', 'active', 'thay@loja.com', 'fernanda@loja.com']) {
    assert.ok(!corpo.includes(proibido), `nao sai: ${proibido}`);
  }
});

test('Cola 70, item 8: sem Auth e com leitura que falha, o uid nao aparece', async () => {
  const firestore = banco();
  const repositorio = new FirestoreHistoricoDoProdutoRepository({ firestore });
  repositorio.emailDoUid = async () => { throw new Error('falhou'); };
  const historico = new HistoricoDoProduto({ repositorio });
  const resultado = await historico.listar({ ator: { establishmentId: LOJA, hasEstablishment: true }, produtoId: 'p1' });
  const porId = Object.fromEntries(resultado.linhas.map((l) => [l.id, l.quem]));
  assert.equal(porId.l1, 'Fernanda Lima');
  assert.equal(porId.l3, '');
  assert.equal(porId.l4, '');
  assert.equal(porId.l6, 'semcadastro@loja.com');
  assert.ok(!JSON.stringify(resultado).includes('uid'));
});

test('Cola 70, item 8: tipo do quem e o Auth ligado na rota', () => {
  assert.equal(tipoDoQuem('Linear', 'integrador').tipo, 'erp');
  assert.equal(tipoDoQuem('a@b.com', 'manual').tipo, 'email');
  assert.equal(tipoDoQuem('abc123', 'app').tipo, 'uid');
  assert.equal(tipoDoQuem('Maria Souza', 'manual').tipo, 'nome');
  assert.equal(tipoDoQuem('  ', 'manual').tipo, 'vazio');
  const servidor = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.ok(servidor.includes('new FirestoreHistoricoDoProdutoRepository({ firestore, auth: firebaseAuth })'));
});
