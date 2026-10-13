import { AppError } from '../errors/AppError.js';

// Validacoes do cadastro de loja pelo app gerenciador (rodada de 13/10/2026). Cada recusa
// sai com codigo proprio e mensagem que o app mostra como esta.

const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const HTML = /[<>]/;
// Letras (com acento), numeros, espaco e a pontuacao comum de nome de loja.
const NOME_LOJA = /^[\p{L}\p{N} .,'&()\-/]+$/u;
const NOME_PESSOA = /^[\p{L} .'\-]+$/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function recusa(campo, mensagem) {
  return new AppError(mensagem, { statusCode: 400, code: `cadastro_${campo}_invalido`, details: { campo } });
}

export function somenteDigitos(valor) {
  return String(valor ?? '').replace(/\D/g, '');
}

function digitoVerificador(digitos, pesos) {
  const soma = pesos.reduce((total, peso, indice) => total + Number(digitos[indice]) * peso, 0);
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

export function cnpjValido(valor) {
  const digitos = somenteDigitos(valor);
  if (digitos.length !== 14 || /^(\d)\1{13}$/.test(digitos)) return false;
  const primeiro = digitoVerificador(digitos, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const segundo = digitoVerificador(digitos, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return primeiro === Number(digitos[12]) && segundo === Number(digitos[13]);
}

export function cpfValido(valor) {
  const digitos = somenteDigitos(valor);
  if (digitos.length !== 11 || /^(\d)\1{10}$/.test(digitos)) return false;
  const verificar = (tamanho) => {
    const soma = digitos.slice(0, tamanho).split('')
      .reduce((total, digito, indice) => total + Number(digito) * (tamanho + 1 - indice), 0);
    return ((soma * 10) % 11) % 10 === Number(digitos[tamanho]);
  };
  return verificar(9) && verificar(10);
}

export function formatarCnpj(digitos) {
  return String(digitos).replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

function textoLimpo(valor) {
  return String(valor ?? '').replace(/\s+/g, ' ').trim();
}

export function validarCnpj(valor) {
  const digitos = somenteDigitos(valor);
  if (!cnpjValido(digitos)) throw recusa('cnpj', 'CNPJ inválido. Confira os 14 números.');
  return digitos;
}

// Nome da loja no app: 2 a 40 caracteres; aceita uma palavra so e numeros; sem emoji e sem HTML.
export function validarNomeNoApp(valor) {
  const nome = textoLimpo(valor);
  if (nome.length < 2 || nome.length > 40) {
    throw recusa('nome', 'O nome do supermercado no app precisa ter de 2 a 40 caracteres.');
  }
  if (EMOJI.test(nome)) throw recusa('nome', 'O nome do supermercado não pode ter emoji.');
  if (HTML.test(nome) || !NOME_LOJA.test(nome)) {
    throw recusa('nome', 'Use só letras, números e pontuação simples no nome do supermercado.');
  }
  return nome;
}

export function validarNomeResponsavel(valor) {
  const nome = textoLimpo(valor);
  if (nome.length < 2 || nome.length > 80 || EMOJI.test(nome) || HTML.test(nome) || !NOME_PESSOA.test(nome)) {
    throw recusa('responsavel', 'Escreva o nome do responsável só com letras.');
  }
  return nome;
}

export function validarCpf(valor) {
  const digitos = somenteDigitos(valor);
  if (!cpfValido(digitos)) throw recusa('cpf', 'CPF inválido. Confira os 11 números.');
  return digitos;
}

// Celular com DDD: 11 digitos, o terceiro e 9.
export function validarCelular(valor) {
  const digitos = somenteDigitos(valor);
  const ddd = Number(digitos.slice(0, 2));
  if (digitos.length !== 11 || ddd < 11 || ddd > 99 || digitos[2] !== '9') {
    throw recusa('celular', 'Celular inválido. Use o DDD e os 9 números, como (27) 99876-5432.');
  }
  return digitos;
}

export function validarEmail(valor) {
  const email = String(valor ?? '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email) || HTML.test(email)) {
    throw recusa('email', 'E-mail inválido.');
  }
  return email;
}

export function validarSenha(valor) {
  const senha = String(valor ?? '');
  if (senha.length < 8) throw recusa('senha', 'A senha precisa ter 8 caracteres ou mais.');
  if (senha.length > 128) throw recusa('senha', 'A senha pode ter no máximo 128 caracteres.');
  return senha;
}

// Tudo do pedido de cadastro, na ordem das telas do app. Sem RG e sem data de nascimento.
export function validarPedidoDeCadastro(entrada = {}) {
  return {
    cnpj: validarCnpj(entrada.cnpj),
    nome: validarNomeNoApp(entrada.nome),
    responsavel: {
      nome: validarNomeResponsavel(entrada.responsavel?.nome),
      cpf: validarCpf(entrada.responsavel?.cpf),
      celular: validarCelular(entrada.responsavel?.celular),
      email: validarEmail(entrada.responsavel?.email),
    },
    senha: validarSenha(entrada.senha),
  };
}
