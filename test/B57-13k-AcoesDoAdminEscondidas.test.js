import assert from 'node:assert/strict';
import test from 'node:test';
import { HistoricoDoProduto } from '../src/application/produtos/HistoricoDoProduto.js';
import { contaDoAdminNaLoja } from '../src/http/middlewares/lojaAlvoDoAdmin.js';
import { FirestoreEstablishmentAccessRepository } from '../src/infra/firebase/FirestoreEstablishmentAccessRepository.js';
import { FirestoreHistoricoDoProdutoRepository } from '../src/infra/firebase/FirestoreHistoricoDoProdutoRepository.js';
import { FirestoreManagerDataGateway } from '../src/infra/firebase/FirestoreManagerDataGateway.js';
import { ManagerDataAccessPolicy } from '../src/infra/firebase/ManagerDataAccessPolicy.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Cola do Thay B57-13k, item 35: "nada que o Admin faz fica visivel para o gerente ou para o dono da
// loja, nem nos Logs nem em outra tela". A leitura da loja esconde as linhas do Admin; nada e apagado.
const ACOES = 'estabelecimentos/loja-1/AcoesEquipe';
const HISTORICO = 'estabelecimentos/loja-1/implantacaoGrenciador/historicoProdutos_1';
const em = (minuto) => new Date(Date.UTC(2026, 10, 24, 12, minuto));
const produto = { tipo: 'produto', id: 'arroz', rotulo: 'Arroz' };

function montar() {
  const firestore = new FirestoreEmMemoria({
    'Users/doc-dono': { id: 'loja-1', userAuthId: 'uid-dono', email: 'conta@loja.test', name: 'Zero Grau' },
    // Conta do Thay como Admin; a conta da loja tambem em usersAdmin (nunca vira Admin na loja dela).
    'usersAdmin/uid-admin': { email: 'Admin@Plataforma.test', isAdmin: true },
    'usersAdmin/uid-dono': { email: 'conta@loja.test', isAdmin: true },
    'estabelecimentos/loja-1/AdminUsers/f-joao': { firstName: 'João', email: 'joao@loja.test', active: true },
    [`${ACOES}/a1`]: { em: em(1), quem: 'joao@loja.test', acao: 'produto.editar', alvo: produto, origem: 'manual' },
    [`${ACOES}/a2`]: { em: em(2), quem: 'admin@plataforma.test', acao: 'produto.editar', alvo: produto, origem: 'manual' },
    [`${ACOES}/a3`]: { em: em(3), quem: 'admin@plataforma.test', acao: 'produto.editar', alvo: produto, origem: 'implantacao', autor: { tipo: 'adminDaPlataforma' } },
    [`${ACOES}/a4`]: { em: em(4), quem: 'conta@loja.test', acao: 'pedido.aceitar', alvo: { tipo: 'pedido', id: 'p1' }, origem: 'manual' },
    [`${ACOES}/a5`]: { em: em(5), quem: '', acao: 'produto.promocaoVencida', alvo: produto, origem: 'promocaoVencida' },
    [`${ACOES}/a6`]: { em: em(6), quem: 'uid-admin', acao: 'produto.editar', alvo: produto, origem: 'implantacao' },
    [HISTORICO]: {
      pagina: 1,
      registros: [
        { produtoId: 'p1', quem: 'joao@loja.test', acao: 'tags' },
        { produtoId: 'p2', quem: 'admin@plataforma.test', acao: 'prateleira' },
        { produtoId: 'p3', quem: 'conta@loja.test', acao: 'nome' },
      ],
    },
  });
  firestore.docs.set('estabelecimentos/loja-1', { name: 'Zero Grau', userReference: firestore.doc('Users/doc-dono') });
  const gateway = new FirestoreManagerDataGateway({ firestore, policy: new ManagerDataAccessPolicy({ firestore }) });
  return { firestore, gateway, acesso: new FirestoreEstablishmentAccessRepository({ firestore }) };
}

const consulta = (limite) => ({
  kind: 'query',
  source: { kind: 'collection', path: ACOES },
  constraints: [{ kind: 'orderBy', field: 'em', direction: 'desc' }, { kind: 'limit', value: limite }],
});
const ids = (resultado) => resultado.docs.map((documento) => documento.id);

test('B57-13k item 35: a acao do Admin nao aparece nos Logs da loja; a do funcionario, a da conta da loja e a rotina continuam', async () => {
  const { gateway, acesso } = montar();
  const dono = await acesso.findAccountByClaims({ uid: 'uid-dono' });
  assert.deepEqual(ids(await gateway.getDocuments({ actor: dono, target: consulta(10) })), ['a5', 'a4', 'a1']);
  // A pagina de 2 vem cheia, pulando as do Admin (a paginacao do painel continua).
  assert.deepEqual(ids(await gateway.getDocuments({ actor: dono, target: consulta(2) })), ['a5', 'a4']);
  // O Admin, agindo na loja, ve tudo.
  const admin = contaDoAdminNaLoja('uid-admin', 'loja-1');
  assert.deepEqual(ids(await gateway.getDocuments({ actor: admin, target: consulta(10) })), ['a6', 'a5', 'a4', 'a3', 'a2', 'a1']);
});

test('B57-13k item 35: o lote do Admin some do historico da loja e continua gravado quando a loja acrescenta', async () => {
  const { firestore, gateway, acesso } = montar();
  const dono = await acesso.findAccountByClaims({ uid: 'uid-dono' });
  const lido = await gateway.getDocument({ actor: dono, target: { kind: 'document', path: HISTORICO } });
  assert.deepEqual(lido.data.registros.map((registro) => registro.produtoId), ['p1', 'p3']);
  // O painel regrava a pagina com o que leu e o registro novo.
  await gateway.mutate({
    actor: dono,
    request: {
      operation: 'set',
      target: { path: HISTORICO },
      options: { merge: true },
      data: { pagina: 1, registros: [{ produtoId: 'p1', quem: 'joao@loja.test', acao: 'tags' }, { produtoId: 'p3', quem: 'conta@loja.test', acao: 'nome' }, { produtoId: 'p4', quem: 'conta@loja.test', acao: 'tags' }] },
    },
  });
  assert.deepEqual(firestore.docs.get(HISTORICO).registros.map((registro) => registro.produtoId), ['p1', 'p2', 'p3', 'p4'], 'o do Admin nao foi apagado');
});

test('B57-13k item 35: a acao nova do Admin na loja e gravada com o autor do Admin', async () => {
  const { firestore, gateway } = montar();
  await gateway.mutate({
    actor: contaDoAdminNaLoja('uid-admin', 'loja-1'),
    request: { operation: 'set', target: { path: `${ACOES}/nova` }, data: { quem: 'admin@plataforma.test', acao: 'produto.editar', alvo: produto } },
  });
  assert.equal(firestore.docs.get(`${ACOES}/nova`).autor.tipo, 'adminDaPlataforma');
});

test('B57-13k item 35: o historico do produto da loja nao mostra a acao do Admin', async () => {
  const { firestore, acesso } = montar();
  const dono = await acesso.findAccountByClaims({ uid: 'uid-dono' });
  const historico = new HistoricoDoProduto({ repositorio: new FirestoreHistoricoDoProdutoRepository({ firestore }) });
  const resposta = await historico.listar({ ator: dono, produtoId: 'arroz' });
  assert.deepEqual(resposta.linhas.map((linha) => linha.id), ['a5', 'a1']);
});
