import assert from 'node:assert/strict';
import test from 'node:test';
import { AdministradoresDaPlataforma } from '../src/application/admin/AdministradoresDaPlataforma.js';
import { Franquias, mascarar } from '../src/application/admin/Franquias.js';
import { LojaNoAdmin } from '../src/application/admin/LojaNoAdmin.js';
import { PedidosDeLoja } from '../src/application/admin/PedidosDeLoja.js';
import { pedidoDoPainel } from '../src/application/admin/DadosDoAdmin.js';
import { FirestoreEstablishmentAccessRepository } from '../src/infra/firebase/FirestoreEstablishmentAccessRepository.js';
import { AuthEmMemoria } from './apoio/authEmMemoria.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

const HORA = () => new Date('2026-10-13T12:00:00Z');

function bancoComPedido(status = 'em_analise') {
  const banco = new FirestoreEmMemoria({
    'Users/uid-dono': { id: 'uid-dono', userAuthId: 'uid-dono', userType: 'UserType.empresa' },
  });
  banco.docs.set('estabelecimentos/loja-nova', {
    name: 'Bom Preço', cnpj: '11222333000181', cnpjConferido: true, phone: '27998765432', responsibleName: 'Ana Paula',
    address: { city: 'Vitória', uf: 'ES' }, isActive: false, status, userReference: banco.doc('Users/uid-dono'),
  });
  const auth = new AuthEmMemoria([{ uid: 'uid-dono', email: 'ana@bp.com.br', customClaims: { groupId: 'antigo', outra: 1 } }]);
  return { banco, auth };
}

test('pedidos: lista abertos e separa os parados antes do e-mail', async () => {
  const { banco, auth } = bancoComPedido();
  banco.docs.set('estabelecimentos/parado', { name: 'Parado', status: 'aguardando_email' });
  banco.docs.set('estabelecimentos/antiga', { name: 'Antiga' });
  const pedidos = new PedidosDeLoja({ firestore: banco, auth, serverTimestamp: HORA });
  assert.deepEqual((await pedidos.listar('abertos')).map((item) => item.id), ['loja-nova']);
  assert.deepEqual((await pedidos.listar('parados')).map((item) => item.id), ['parado']);
  const [linha] = await pedidos.listar('abertos');
  assert.equal(linha.cidade, 'Vitória');
  assert.equal(linha.cnpjConferido, true);
  assert.equal(linha.responsavel.celular, '27998765432');
});

test('aprovar: status, quem e quando, claim adminOf da loja; nao liga a loja no app', async () => {
  const { banco, auth } = bancoComPedido();
  const pedidos = new PedidosDeLoja({ firestore: banco, auth, serverTimestamp: HORA });
  const resultado = await pedidos.aprovar('loja-nova', { uid: 'uid-admin' });
  const loja = banco.dados('estabelecimentos/loja-nova');
  assert.equal(loja.status, 'aprovada');
  assert.equal(loja.aprovadoPor, 'uid-admin');
  assert.ok(loja.aprovadoEm);
  assert.equal(loja.isActive, false);
  assert.deepEqual((await auth.getUser('uid-dono')).customClaims, { outra: 1, adminOf: 'loja-nova' });
  assert.deepEqual(resultado.claimsAntigas, { groupId: 'antigo', outra: 1 });
  await assert.rejects(pedidos.aprovar('loja-nova', {}), (erro) => erro.code === 'pedido_nao_esta_aberto');
});

test('recusar exige motivo; em conversa vai e volta', async () => {
  const { banco, auth } = bancoComPedido();
  const pedidos = new PedidosDeLoja({ firestore: banco, auth, serverTimestamp: HORA });
  await assert.rejects(pedidos.recusar('loja-nova', '  ', {}), (erro) => erro.code === 'pedido_motivo_obrigatorio');
  assert.equal((await pedidos.marcarEmConversa('loja-nova', true)).status, 'em_conversa');
  assert.equal((await pedidos.marcarEmConversa('loja-nova', false)).status, 'em_analise');
  const recusado = await pedidos.recusar('loja-nova', 'CNPJ de outra atividade', { uid: 'uid-admin' });
  assert.equal(recusado.status, 'recusada');
  assert.equal(recusado.motivoRecusa, 'CNPJ de outra atividade');
});

test('loja aprovada do cadastro novo: o painel acha pela claim e por userReference', async () => {
  const { banco, auth } = bancoComPedido('aprovada');
  const acesso = new FirestoreEstablishmentAccessRepository({ firestore: banco });
  const conta = await acesso.findAccountByClaims({ uid: 'uid-dono', adminOf: 'loja-nova' });
  assert.equal(conta.establishmentId, 'loja-nova');
  assert.equal(conta.hasEstablishment, true);
  assert.equal(conta.establishmentDocument.status, 'aprovada');
  const admin = new LojaNoAdmin({ firestore: banco, auth, accessRepository: acesso });
  const [dono] = await admin.contas('loja-nova');
  assert.equal(dono.papel, 'dono');
  assert.equal(dono.entra, true);
});

test('contas da loja: dono com claim para loja inexistente nao entra; Corrigir acesso com previa', async () => {
  // Caso do Vidal: Users.id e o id do proprio Users, a claim aponta para ele e a loja real liga por userReference.
  const banco = new FirestoreEmMemoria({
    'Users/doc-users': { id: 'doc-users', userAuthId: 'uid-vidal', userType: 'UserType.empresa' },
    'estabelecimentos/doc-users/AdminUsers/uid-vidal': { active: true, groupId: 'g1' },
    'estabelecimentos/doc-users/PermissionGroups/g1': { isAdmin: true },
  });
  banco.docs.set('estabelecimentos/loja-real', { name: 'Loja Real', userReference: banco.doc('Users/doc-users') });
  const auth = new AuthEmMemoria([{ uid: 'uid-vidal', email: 'vidal@teste', customClaims: { adminOf: 'doc-users', groupId: 'g1' } }]);
  const admin = new LojaNoAdmin({ firestore: banco, auth, accessRepository: new FirestoreEstablishmentAccessRepository({ firestore: banco }), serverTimestamp: HORA });
  const [conta] = await admin.contas('loja-real');
  assert.equal(conta.entra, false);
  assert.match(conta.motivo, /adminOf aponta para uma loja que não existe/);

  const previa = await admin.previaDoAcesso('loja-real', 'uid-vidal');
  assert.deepEqual(previa.claimsNovas, { adminOf: 'loja-real' });
  assert.deepEqual((await auth.getUser('uid-vidal')).customClaims, { adminOf: 'doc-users', groupId: 'g1' });
  const feito = await admin.corrigirAcesso('loja-real', 'uid-vidal');
  assert.deepEqual(feito.claimsAntigas, { adminOf: 'doc-users', groupId: 'g1' });
  assert.equal(feito.entraDepois, true);
});

test('editar com previa, ligar no app e excluir so loja vazia com o nome', async () => {
  const banco = new FirestoreEmMemoria({
    'estabelecimentos/loja-1': { name: 'Loja Um', phone: '2733334444', address: { city: 'Serra', uf: 'ES' }, isActive: true },
    'estabelecimentos/loja-2': { name: 'Loja Dois' },
    'estabelecimentos/loja-2/Products/p1': { name: 'Arroz' },
    'estabelecimentos/loja-3': { nomeEstabelecimento: 'Loja Tres' },
    'estabelecimentos/loja-3/DailyStats/01-10-2026': { viewsCount: 3 },
  });
  const admin = new LojaNoAdmin({ firestore: banco, auth: new AuthEmMemoria(), accessRepository: null, serverTimestamp: HORA });
  const previa = await admin.previaDaEdicao('loja-1', { name: 'Loja Um', phone: '(27) 99999-0000' });
  assert.deepEqual(previa.diferencas, [{ campo: 'phone', antes: '2733334444', depois: '27999990000' }]);
  assert.equal(banco.dados('estabelecimentos/loja-1').phone, '2733334444');
  await admin.editar('loja-1', { phone: '(27) 99999-0000', address: { city: 'Vitória', uf: 'es' } });
  assert.equal(banco.dados('estabelecimentos/loja-1').phone, '27999990000');
  assert.equal(banco.dados('estabelecimentos/loja-1').address.uf, 'ES');
  await assert.rejects(admin.editar('loja-1', { name: 'Loja 🛒' }), (erro) => erro.code === 'cadastro_nome_invalido');

  assert.equal((await admin.ativarNoApp('loja-1', false)).ativa, false);
  assert.equal(banco.dados('estabelecimentos/loja-1').isActive, false);

  assert.equal((await admin.previaDaExclusao('loja-2')).podeExcluir, false);
  await assert.rejects(admin.excluir('loja-2', 'Loja Dois'), (erro) => erro.code === 'loja_com_pedidos_ou_produtos');
  await assert.rejects(admin.excluir('loja-3', 'Outro nome'), (erro) => erro.code === 'loja_confirmacao_nome');
  const excluida = await admin.excluir('loja-3', 'Loja Tres');
  assert.equal(excluida.excluida, true);
  assert.equal(banco.dados('estabelecimentos/loja-3'), undefined);
  assert.equal(banco.dados('estabelecimentos/loja-3/DailyStats/01-10-2026'), undefined);
});

test('aparencia: cor #RRGGBB e offerColor; agendamento contratado e desligar o contrato desliga a loja', async () => {
  const banco = new FirestoreEmMemoria({ 'estabelecimentos/loja-1': { name: 'Loja', scheduling: { contracted: true, enabled: true } } });
  const admin = new LojaNoAdmin({ firestore: banco, auth: new AuthEmMemoria(), accessRepository: null, serverTimestamp: HORA });
  await assert.rejects(admin.salvarAparencia('loja-1', { offerColor: 'amarelo' }), (erro) => erro.code === 'aparencia_cor_invalida');
  const aparencia = await admin.salvarAparencia('loja-1', { offerColor: '#fff4d1', primaryColor: '#1F22E6' });
  assert.equal(aparencia.offerColor, '#FFF4D1');
  assert.equal(aparencia.offerColorPadrao, '#FFF4D1');
  const agendamento = await admin.contratarAgendamento('loja-1', false);
  assert.deepEqual({ contracted: agendamento.contracted, enabled: agendamento.enabled }, { contracted: false, enabled: false });
});

test('franquias: so nome, franqueado e cidade; tipo da conta e banco ficam so para leitura e mascarados', async () => {
  const banco = new FirestoreEmMemoria({
    'franquias/f1': {
      nomeFranquia: 'Vitória', nomeFranqueado: 'Fulano', cidadeValue: 'Vitória', cpf: '52998224725', conta: '123456', agencia: '0001', tipo: 'conta_corrente',
      recebedorData: { id: 're_abcdef123456', status: 'active' },
    },
    'estabelecimentos/l1': { franquiaId: 'f1' },
  });
  const franquias = new Franquias({ firestore: banco });
  const [linha] = await franquias.listar();
  assert.equal(linha.lojas, 1);
  assert.equal(linha.soLeitura.cpf, '•••••••••25');
  assert.equal(linha.soLeitura.conta, '••••56');
  assert.equal(JSON.stringify(linha).includes('52998224725'), false);
  await assert.rejects(franquias.editar('f1', { tipo: 'conta_poupanca' }), (erro) => erro.code === 'franquia_campo_so_leitura');
  await assert.rejects(franquias.editar('f1', { conta: '999' }), (erro) => erro.code === 'franquia_campo_so_leitura');
  const editada = await franquias.editar('f1', { nomeFranqueado: 'Beltrano' });
  assert.deepEqual(editada.antes, { nomeFranqueado: 'Fulano' });
  assert.equal(banco.dados('franquias/f1').nomeFranqueado, 'Beltrano');
  assert.equal(banco.dados('franquias/f1').tipo, 'conta_corrente');
  assert.equal(mascarar(''), null);
});

test('administradores: so as contas do Thay criam e tiram; remover nao apaga a conta', async () => {
  const banco = new FirestoreEmMemoria({ 'usersAdmin/uid-outro': { nome: 'Outro', email: 'outro@x', isAdmin: true } });
  const auth = new AuthEmMemoria([{ uid: 'uid-outro', email: 'outro@x', customClaims: { isAdmin: true } }]);
  const admins = new AdministradoresDaPlataforma({ firestore: banco, auth, uidsQueCriam: ['uid-thay'] });
  await assert.rejects(admins.criar({ nome: 'Novo', email: 'novo@x.com', senha: '12345678' }, { uid: 'uid-outro' }), (erro) => erro.code === 'admin_so_thay');
  const criado = await admins.criar({ nome: 'Novo', email: 'novo@x.com', senha: '12345678' }, { uid: 'uid-thay' });
  assert.equal(criado.contaNova, true);
  assert.equal(banco.dados(`usersAdmin/${criado.uid}`).isAdmin, true);
  assert.deepEqual((await auth.getUser(criado.uid)).customClaims, { isAdmin: true });
  await assert.rejects(admins.removerAcesso('uid-thay', { uid: 'uid-thay' }), (erro) => erro.code === 'admin_remover_a_si');
  await admins.removerAcesso('uid-outro', { uid: 'uid-thay' });
  assert.equal(banco.dados('usersAdmin/uid-outro').isAdmin, false);
  assert.ok(auth.contas.has('uid-outro'));
  assert.deepEqual((await auth.getUser('uid-outro')).customClaims, {});
  const { podeGerenciar, admins: lista } = await admins.listar({ uid: 'uid-outro' });
  assert.equal(podeGerenciar, false);
  assert.equal(lista.find((item) => item.uid === 'uid-outro').ativo, false);
});

test('painel de experiencia pelo Core: pedido no formato das contas do painel', () => {
  const documento = {
    id: 'p1',
    data: () => ({
      createdAt: new Date('2026-10-01T10:00:00Z'),
      companyReference: { id: 'loja-1' },
      currentPurchaseStatus: 'PurchaseStatus.completed',
      total: '52.5',
      origem: 'agente_ia',
      statusList: [
        { purchaseStatus: 'PurchaseStatus.pending', createdAt: new Date('2026-10-01T10:00:00Z') },
        { purchaseStatus: 'PurchaseStatus.accepted', createdAt: new Date('2026-10-01T10:05:00Z') },
      ],
    }),
  };
  const pedido = pedidoDoPainel(documento);
  assert.equal(pedido.company, 'loja-1');
  assert.equal(pedido.status, 'completed');
  assert.equal(pedido.total, 52.5);
  assert.equal(pedido.agent, true);
  assert.equal(pedido.tAccepted, '2026-10-01T10:05:00.000Z');
});
