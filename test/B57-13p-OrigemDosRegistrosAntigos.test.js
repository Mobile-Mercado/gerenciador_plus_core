import assert from 'node:assert/strict';
import test from 'node:test';
import { HistoricoDoProduto } from '../src/application/produtos/HistoricoDoProduto.js';
import { FirestoreEstablishmentAccessRepository } from '../src/infra/firebase/FirestoreEstablishmentAccessRepository.js';
import { FirestoreHistoricoDoProdutoRepository } from '../src/infra/firebase/FirestoreHistoricoDoProdutoRepository.js';
import { FirestoreManagerDataGateway } from '../src/infra/firebase/FirestoreManagerDataGateway.js';
import { ManagerDataAccessPolicy } from '../src/infra/firebase/ManagerDataAccessPolicy.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Cola do Thay B57-13p, item 35: registros antigos do Log da equipe (AcoesEquipe), sem marca de origem.
// A origem exata vem do registro que o Admin deixa na loja desde 13/10 (AdminAuditLogs, action
// 'admin_plataforma', details.caminhos): acao que consta nele some; as outras aparecem, mesmo de conta
// Admin. Planilhas antigas (linhas da importacao) e lotes continuam pela regra por conta.
const ACOES = 'estabelecimentos/loja-1/AcoesEquipe';
const em = (minuto) => new Date(Date.UTC(2026, 9, 20, 12, minuto));
const produto = { tipo: 'produto', id: 'arroz', rotulo: 'Arroz' };

function montar() {
  const firestore = new FirestoreEmMemoria({
    'Users/doc-dono': { id: 'loja-1', userAuthId: 'uid-dono', email: 'conta@loja.test', name: 'Zero Grau' },
    'usersAdmin/uid-admin': { email: 'admin@plataforma.test', isAdmin: true },
    // Painel da loja, conta que tambem e Admin: aparece.
    [`${ACOES}/painel`]: { em: em(1), quem: 'admin@plataforma.test', tela: 'produtos', acao: 'produto.editar', alvo: produto, origem: 'manual' },
    // Tela do Admin (consta no registro do Admin), de conta que ja saiu de usersAdmin: some.
    [`${ACOES}/tela-do-admin`]: { em: em(2), quem: 'ex-admin@plataforma.test', tela: 'implantacao', acao: 'produto.editar', alvo: produto, origem: 'implantacao' },
    // Planilha antiga importada por conta Admin: regra por conta, some.
    [`${ACOES}/planilha-admin`]: { em: em(3), quem: 'admin@plataforma.test', tela: 'implantacao', acao: 'produto.criar', alvo: produto, origem: 'implantacao' },
    // Planilha antiga importada pela loja: aparece.
    [`${ACOES}/planilha-loja`]: { em: em(4), quem: 'conta@loja.test', tela: 'implantacao', acao: 'produto.criar', alvo: produto, origem: 'implantacao' },
    'estabelecimentos/loja-1/AdminAuditLogs/r1': {
      action: 'admin_plataforma',
      performedBy: 'uid-ex-admin',
      details: { rota: '/api/data/mutate', caminhos: [`${ACOES}/tela-do-admin`, 'estabelecimentos/loja-1/Products/arroz'] },
    },
    // Registro de outra acao do Admin (sem caminhos) e de outra loja nao contam.
    'estabelecimentos/loja-1/AdminAuditLogs/r2': { action: 'admin_plataforma', details: { acao: 'app_do_cliente' } },
    'estabelecimentos/loja-2/AdminAuditLogs/r3': { action: 'admin_plataforma', details: { caminhos: [`${ACOES}/painel`] } },
  });
  firestore.docs.set('estabelecimentos/loja-1', { name: 'Zero Grau', userReference: firestore.doc('Users/doc-dono') });
  return {
    firestore,
    gateway: new FirestoreManagerDataGateway({ firestore, policy: new ManagerDataAccessPolicy({ firestore }) }),
    acesso: new FirestoreEstablishmentAccessRepository({ firestore }),
  };
}

const consulta = { kind: 'query', source: { kind: 'collection', path: ACOES }, constraints: [{ kind: 'orderBy', field: 'em', direction: 'desc' }] };

test('B57-13p item 35: registro antigo do painel da loja feito por conta Admin aparece; o que consta no registro do Admin some', async () => {
  const { gateway, acesso } = montar();
  const dono = await acesso.findAccountByClaims({ uid: 'uid-dono' });
  const vistas = (await gateway.getDocuments({ actor: dono, target: consulta })).docs.map((documento) => documento.id);
  assert.deepEqual(vistas, ['planilha-loja', 'painel']);
});

test('B57-13p item 35: o historico do produto segue a mesma regra', async () => {
  const { firestore, acesso } = montar();
  const dono = await acesso.findAccountByClaims({ uid: 'uid-dono' });
  const historico = new HistoricoDoProduto({ repositorio: new FirestoreHistoricoDoProdutoRepository({ firestore }) });
  const resposta = await historico.listar({ ator: dono, produtoId: 'arroz' });
  assert.deepEqual(resposta.linhas.map((linha) => linha.id), ['planilha-loja', 'painel']);
});
