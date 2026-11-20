// Cola do Thay B57-03 (18/11), item A1, e B57-03b (19/11): "Confirmar celular" no cadastro de loja
// do App Gerenciador. O app confere o codigo do SMS pelo login por numero do Firebase, sai desse
// login (apagado, se o numero nao tinha conta) e manda o token ao Core, que so confere o token e
// guarda a confirmacao. O pedido de loja criado depois leva celularConfirmado, e o Admin mostra.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CadastroDeLoja, COLECAO_CELULARES_CONFIRMADOS } from '../src/application/cadastro/CadastroDeLoja.js';
import { PedidosDeLoja } from '../src/application/admin/PedidosDeLoja.js';
import { LimiteDeTentativas } from '../src/application/cadastro/LimiteDeTentativas.js';
import { lerEmpresa } from '../src/infra/cnpj/BrasilApiCnpj.js';
import { AuthEmMemoria } from './apoio/authEmMemoria.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

const RECEITA = lerEmpresa({
  descricao_situacao_cadastral: 'ATIVA',
  razao_social: 'MERCADO BOM PRECO LTDA',
  descricao_tipo_de_logradouro: 'RUA',
  logradouro: 'SETE DE SETEMBRO',
  numero: '410',
  bairro: 'CENTRO',
  municipio: 'VITORIA',
  uf: 'ES',
  cep: '29015000',
});

const HORA = new Date('2026-11-19T15:00:00Z');

function pedido(mudancas = {}) {
  return {
    cnpj: '11.222.333/0001-81',
    nome: 'Bom Preço',
    responsavel: { nome: 'Ana Paula', celular: '(27) 99876-5432', email: 'ana@bompreco.com.br' },
    erp: { escolhido: 'Linear', texto: null },
    endereco: {
      cep: '29015-000', rua: 'Rua Sete de Setembro', numero: '410', complemento: null, bairro: 'Centro',
      cidade: 'Vitória', uf: 'ES', referencia: null, lat: -20.3194, lng: -40.3378,
    },
    instalacaoId: 'inst-abc-12345',
    senha: 'senha-forte',
    ...mudancas,
  };
}

function montar() {
  const banco = new FirestoreEmMemoria({});
  const auth = new AuthEmMemoria();
  const cadastro = new CadastroDeLoja({
    firestore: banco,
    auth,
    consultaCnpj: { consultar: async () => RECEITA },
    limites: new LimiteDeTentativas({ firestore: banco, clock: () => 1_000_000, paraData: (ms) => new Date(ms) }),
    serverTimestamp: () => HORA,
    pontoNoMapa: (latitude, longitude) => ({ latitude, longitude }),
  });
  return { banco, auth, cadastro };
}

function tokenDeNumero(auth, nome, numero) {
  auth.tokens.set(nome, { uid: 'uid-do-numero', phone_number: numero, firebase: { sign_in_provider: 'phone' } });
  return nome;
}

async function recusa(promessa, codigo) {
  await assert.rejects(promessa, (erro) => erro.code === codigo);
}

test('A1: token do login por numero com o mesmo celular guarda a confirmacao, sem mexer em conta', async () => {
  const { banco, auth, cadastro } = montar();
  const idToken = tokenDeNumero(auth, 'token-ok', '+5527998765432');

  assert.deepEqual(
    await cadastro.confirmarCelular({ instalacaoId: 'inst-abc-12345', celular: '(27) 99876-5432', idToken }),
    { celularConfirmado: true },
  );
  assert.deepEqual(banco.dados(`${COLECAO_CELULARES_CONFIRMADOS}/inst-abc-12345`), { celular: '27998765432', confirmadoEm: HORA });
  assert.equal(auth.contas.size, 0, 'nao cria conta');
  assert.deepEqual(auth.apagadas, [], 'nao apaga conta');
});

test('A1: recusa token invalido, de outro numero ou que nao e do login por numero', async () => {
  const { banco, auth, cadastro } = montar();
  const base = { instalacaoId: 'inst-1', celular: '(27) 99876-5432' };
  await recusa(cadastro.confirmarCelular({ ...base, idToken: 'nao-existe' }), 'celular_token_invalido');
  await recusa(cadastro.confirmarCelular({ ...base, idToken: tokenDeNumero(auth, 'outro', '+5527911112222') }), 'celular_nao_confere');
  auth.tokens.set('email', { uid: 'u', phone_number: '+5527998765432', firebase: { sign_in_provider: 'password' } });
  await recusa(cadastro.confirmarCelular({ ...base, idToken: 'email' }), 'celular_nao_confere');
  assert.equal(banco.dados(`${COLECAO_CELULARES_CONFIRMADOS}/inst-1`), undefined);
});

test('A1: o pedido criado leva celularConfirmado; com outro celular ou sem confirmacao, false', async () => {
  const { banco, auth, cadastro } = montar();
  await cadastro.confirmarCelular({ instalacaoId: 'inst-abc-12345', celular: '27998765432', idToken: tokenDeNumero(auth, 't', '+5527998765432') });

  const confirmado = await cadastro.criar(pedido());
  const gravado = banco.dados(`pedidosDeLoja/${confirmado.pedidoId}`);
  assert.equal(gravado.celularConfirmado, true);
  assert.deepEqual(gravado.celularConfirmadoEm, HORA);

  const trocou = await cadastro.criar(pedido({
    cnpj: '45.997.418/0001-53',
    responsavel: { nome: 'Ana Paula', celular: '(27) 99111-2222', email: 'outra@bompreco.com.br' },
  }));
  assert.equal(banco.dados(`pedidosDeLoja/${trocou.pedidoId}`).celularConfirmado, false, 'trocou o numero depois');

  const semConfirmar = await cadastro.criar(pedido({
    cnpj: '11.444.777/0001-61',
    instalacaoId: 'inst-outra',
    responsavel: { nome: 'Ana Paula', celular: '(27) 99876-5432', email: 'terceira@bompreco.com.br' },
  }));
  const semDados = banco.dados(`pedidosDeLoja/${semConfirmar.pedidoId}`);
  assert.equal(semDados.celularConfirmado, false);
  assert.equal(semDados.celularConfirmadoEm, null);

  // O Admin mostra o celular confirmado no pedido de loja.
  // Novos, ainda esperando o e-mail: a lista "parados".
  const linhas = await new PedidosDeLoja({ firestore: banco, auth }).listar('parados');
  const porId = Object.fromEntries(linhas.map((linha) => [linha.pedidoId, linha.celularConfirmado]));
  assert.equal(porId[confirmado.pedidoId], true);
  assert.equal(porId[semConfirmar.pedidoId], false);
});
