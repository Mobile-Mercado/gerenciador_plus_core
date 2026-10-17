import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cnpjValido, cpfValido, ERPS, validarCelular, validarEmail, validarEndereco, validarErp, validarInstalacaoId, validarNomeNoApp,
  validarNomeResponsavel, validarPedidoDeCadastro, validarSenha,
} from '../src/domain/cadastro/validacoes.js';

// CNPJ e CPF de exemplo com digito verificador correto (gerados para teste).
export const CNPJ_OK = '11222333000181';
export const CPF_OK = '52998224725';

function recusa(fn, codigo) {
  assert.throws(fn, (erro) => erro.code === codigo && erro.statusCode === 400);
}

test('CNPJ: digito verificador confere e repetido e recusado', () => {
  assert.equal(cnpjValido(CNPJ_OK), true);
  assert.equal(cnpjValido('11.222.333/0001-81'), true);
  assert.equal(cnpjValido('11222333000182'), false);
  assert.equal(cnpjValido('11111111111111'), false);
  assert.equal(cnpjValido('1122233300018'), false);
});

test('CPF: digito verificador confere e repetido e recusado', () => {
  assert.equal(cpfValido(CPF_OK), true);
  assert.equal(cpfValido('529.982.247-25'), true);
  assert.equal(cpfValido('52998224724'), false);
  assert.equal(cpfValido('00000000000'), false);
});

test('nome no app: trim, 2 a 40, uma palavra e numeros; recusa emoji e HTML', () => {
  assert.equal(validarNomeNoApp('  Bom   Preço  '), 'Bom Preço');
  assert.equal(validarNomeNoApp('Mercado24'), 'Mercado24');
  assert.equal(validarNomeNoApp('BP'), 'BP');
  recusa(() => validarNomeNoApp('B'), 'cadastro_nome_invalido');
  recusa(() => validarNomeNoApp('x'.repeat(41)), 'cadastro_nome_invalido');
  recusa(() => validarNomeNoApp('Bom Preço 🛒'), 'cadastro_nome_invalido');
  recusa(() => validarNomeNoApp('<b>Bom</b>'), 'cadastro_nome_invalido');
});

test('responsavel: nome so com letras; celular com 11 digitos; e-mail; senha de 8 ou mais', () => {
  assert.equal(validarNomeResponsavel(' Ana  Paula '), 'Ana Paula');
  recusa(() => validarNomeResponsavel('Ana123'), 'cadastro_responsavel_invalido');
  assert.equal(validarCelular('(27) 99876-5432'), '27998765432');
  recusa(() => validarCelular('(27) 3333-4444'), 'cadastro_celular_invalido');
  recusa(() => validarCelular('2799876543'), 'cadastro_celular_invalido');
  assert.equal(validarEmail(' Ana@BomPreco.com.br '), 'ana@bompreco.com.br');
  recusa(() => validarEmail('ana@bompreco'), 'cadastro_email_invalido');
  assert.equal(validarSenha('12345678'), '12345678');
  recusa(() => validarSenha('1234567'), 'cadastro_senha_invalido');
});

const ENDERECO = {
  cep: '29015-000', rua: 'Rua Sete', numero: '410', bairro: 'Centro', cidade: 'Vitória', uf: 'es', lat: -20.3, lng: -40.3,
};

test('pedido completo: sem RG e sem data de nascimento; CPF opcional', () => {
  const entrada = {
    cnpj: '11.222.333/0001-81',
    nome: 'Bom Preço',
    responsavel: { nome: 'Ana Paula', cpf: '529.982.247-25', celular: '27998765432', email: 'ana@bp.com.br' },
    erp: { escolhido: 'Linear' },
    endereco: ENDERECO,
    senha: 'senha-forte',
    rg: '123',
    dataNascimento: '1990-01-01',
  };
  const pedido = validarPedidoDeCadastro(entrada);
  assert.deepEqual(Object.keys(pedido.responsavel).sort(), ['celular', 'cpf', 'email', 'nome']);
  assert.equal(pedido.cnpj, CNPJ_OK);
  assert.equal(pedido.instalacaoId, null);
  recusa(() => validarPedidoDeCadastro({ ...entrada, cnpj: '11222333000182' }), 'cadastro_cnpj_invalido');
  recusa(() => validarPedidoDeCadastro({ ...entrada, responsavel: { ...entrada.responsavel, cpf: '52998224724' } }), 'cadastro_cpf_invalido');
  // Sem CPF, ou com o campo vazio, o pedido passa.
  assert.equal(validarPedidoDeCadastro({ ...entrada, responsavel: { ...entrada.responsavel, cpf: undefined } }).responsavel.cpf, null);
  assert.equal(validarPedidoDeCadastro({ ...entrada, responsavel: { ...entrada.responsavel, cpf: '' } }).responsavel.cpf, null);
});

test('ERP: nome da lista, "outro" ou "nao_sei", texto ate 120 caracteres', () => {
  assert.deepEqual(validarErp({ escolhido: 'Varejo Fácil' }), { escolhido: 'Varejo Fácil', texto: null });
  assert.deepEqual(validarErp({ escolhido: 'outro', texto: '  Sistema da casa ' }), { escolhido: 'outro', texto: 'Sistema da casa' });
  assert.deepEqual(validarErp({ escolhido: 'nao_sei' }), { escolhido: 'nao_sei', texto: null });
  assert.equal(ERPS.length, 60);
  recusa(() => validarErp({ escolhido: 'linear' }), 'cadastro_erp_invalido');
  recusa(() => validarErp({}), 'cadastro_erp_invalido');
  recusa(() => validarErp({ escolhido: 'outro', texto: 'x'.repeat(121) }), 'cadastro_erp_invalido');
});

test('endereco: numero e pino obrigatorios no pedido; tipos e tamanhos; UF da lista', () => {
  const endereco = validarEndereco(ENDERECO);
  assert.equal(endereco.cep, '29015000');
  assert.equal(endereco.uf, 'ES');
  assert.equal(endereco.complemento, null);
  recusa(() => validarEndereco({ ...ENDERECO, numero: ' ' }), 'cadastro_numero_invalido');
  assert.equal(validarEndereco({ ...ENDERECO, numero: '' }, { completo: false }).numero, null);
  recusa(() => validarEndereco({ ...ENDERECO, cep: '2901' }), 'cadastro_cep_invalido');
  recusa(() => validarEndereco({ ...ENDERECO, uf: 'XX' }), 'cadastro_uf_invalido');
  recusa(() => validarEndereco({ ...ENDERECO, rua: 'x'.repeat(121) }), 'cadastro_rua_invalido');
  recusa(() => validarEndereco({ ...ENDERECO, lat: '-20.3' }), 'cadastro_lat_invalido');
  recusa(() => validarEndereco({ ...ENDERECO, lng: 200 }), 'cadastro_lng_invalido');
});

test('instalacaoId: 8 a 100 letras, numeros, - ou _', () => {
  assert.equal(validarInstalacaoId('a1b2c3d4-e5'), 'a1b2c3d4-e5');
  recusa(() => validarInstalacaoId('curto'), 'cadastro_instalacao_invalido');
  recusa(() => validarInstalacaoId('com espaco 123'), 'cadastro_instalacao_invalido');
});
