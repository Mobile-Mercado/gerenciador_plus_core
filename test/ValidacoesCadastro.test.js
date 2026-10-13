import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cnpjValido, cpfValido, validarCelular, validarEmail, validarNomeNoApp, validarNomeResponsavel, validarPedidoDeCadastro, validarSenha,
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

test('pedido completo: sem RG e sem data de nascimento', () => {
  const pedido = validarPedidoDeCadastro({
    cnpj: '11.222.333/0001-81',
    nome: 'Bom Preço',
    responsavel: { nome: 'Ana Paula', cpf: '529.982.247-25', celular: '27998765432', email: 'ana@bp.com.br' },
    senha: 'senha-forte',
    rg: '123',
    dataNascimento: '1990-01-01',
  });
  assert.deepEqual(Object.keys(pedido.responsavel).sort(), ['celular', 'cpf', 'email', 'nome']);
  assert.equal(pedido.cnpj, CNPJ_OK);
  recusa(() => validarPedidoDeCadastro({ ...pedido, cnpj: '11222333000182' }), 'cadastro_cnpj_invalido');
  recusa(() => validarPedidoDeCadastro({ ...pedido, responsavel: { ...pedido.responsavel, cpf: '52998224724' } }), 'cadastro_cpf_invalido');
});
