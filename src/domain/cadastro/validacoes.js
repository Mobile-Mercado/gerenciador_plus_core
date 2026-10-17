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

// "Sistema ERP da loja": nome da lista da especificacao, "outro" ou "nao_sei", mais o texto
// digitado (ate 120 caracteres). Busca sem resultado grava o texto.
export const ERPS = Object.freeze([
  'Acesse ERP', 'ACS ERP', 'Alterdata', 'Apolo', 'Arius', 'Artsystem', 'Auditor ERP', 'Bling', 'Bluesoft', 'BytePDV',
  'Cads ERP', 'CES', 'CH Sistemas', 'CISS', 'Consinco', 'Criare ERP', 'Criasoft', 'Cronos ERP', 'Devi', 'Dlinks ERP',
  'GCF', 'Getway', 'Guarani Sistemas', 'GZ Sistemas', 'Hiper ERP', 'Infor', 'Intersolid', 'Linear', 'Linx Empório',
  'Linx Emsys', 'Logtec Sistemas', 'Logus', 'Lumi', 'Millenium', 'Mobne', 'Omie', 'Prosystem', 'Protheus', 'Rech ERP',
  'RMS', 'RP Info', 'Sankhya', 'SAP', 'SCE Sistemas', 'SCV Sistemas', 'SD Sistemas', 'Senior', 'SGE ERP', 'Softcom',
  'Solidcon', 'Sysmo', 'SysPDV', 'Telecon', 'Uniplus', 'Varejo Fácil', 'Visual Software', 'Vix Soluções', 'VR Software',
  'VSM', 'Winthor',
]);
export const ERP_OUTRO = 'outro';
export const ERP_NAO_SEI = 'nao_sei';

export function validarErp(valor) {
  const escolhido = textoLimpo(valor?.escolhido);
  const texto = textoLimpo(valor?.texto);
  const naLista = ERPS.find((nome) => nome === escolhido);
  if (!naLista && escolhido !== ERP_OUTRO && escolhido !== ERP_NAO_SEI) {
    throw recusa('erp', 'Escolha o sistema ERP da loja na lista, "Outro" ou "Não sei".');
  }
  if (texto.length > 120 || EMOJI.test(texto) || HTML.test(texto)) {
    throw recusa('erp', 'O nome do ERP pode ter até 120 caracteres, sem emoji.');
  }
  return { escolhido: naLista || escolhido, texto: texto || null };
}

const UFS = new Set(['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI',
  'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO']);

function textoDoEndereco(campo, valor, { maximo, obrigatorio = false, rotulo }) {
  const texto = textoLimpo(valor);
  if (!texto) {
    if (obrigatorio) throw recusa(campo, `Preencha ${rotulo}.`);
    return null;
  }
  if (texto.length > maximo || EMOJI.test(texto) || HTML.test(texto)) {
    throw recusa(campo, `Confira ${rotulo}: até ${maximo} caracteres, sem emoji.`);
  }
  return texto;
}

function coordenada(campo, valor, limite) {
  const numero = typeof valor === 'number' ? valor : Number.NaN;
  if (!Number.isFinite(numero) || Math.abs(numero) > limite) {
    throw recusa(campo, 'Marque a loja no mapa antes de continuar.');
  }
  return numero;
}

// Endereco que o lojista confirmou no mapa (passo 3 e folha do endereco). No pedido o numero
// e o pino sao obrigatorios; no rascunho do passo 3 o numero ainda pode faltar.
export function validarEndereco(valor = {}, { completo = true } = {}) {
  const cep = somenteDigitos(valor.cep);
  if (cep && cep.length !== 8) throw recusa('cep', 'CEP inválido. Confira os 8 números.');
  const uf = textoLimpo(valor.uf).toUpperCase();
  if (!UFS.has(uf)) throw recusa('uf', 'Confira a UF do endereço.');
  return {
    cep: cep || null,
    rua: textoDoEndereco('rua', valor.rua, { maximo: 120, obrigatorio: true, rotulo: 'a rua' }),
    numero: textoDoEndereco('numero', valor.numero, { maximo: 20, obrigatorio: completo, rotulo: 'o número' }),
    complemento: textoDoEndereco('complemento', valor.complemento, { maximo: 80, rotulo: 'o complemento' }),
    bairro: textoDoEndereco('bairro', valor.bairro, { maximo: 80, rotulo: 'o bairro' }),
    cidade: textoDoEndereco('cidade', valor.cidade, { maximo: 80, obrigatorio: true, rotulo: 'a cidade' }),
    uf,
    referencia: textoDoEndereco('referencia', valor.referencia, { maximo: 120, rotulo: 'a referência' }),
    lat: coordenada('lat', valor.lat, 90),
    lng: coordenada('lng', valor.lng, 180),
  };
}

// Cidade do acesso que o app manda na abertura (aproximada). Sem cidade, volta null; UF fora da
// lista vira null. Nunca e endereco de rede.
export function validarCidadeAcesso(valor) {
  if (!valor || typeof valor !== 'object') return null;
  const cidade = textoLimpo(valor.cidade);
  if (!cidade) return null;
  if (cidade.length > 80 || EMOJI.test(cidade) || HTML.test(cidade)) throw recusa('cidade', 'Cidade do acesso inválida.');
  const uf = textoLimpo(valor.uf).toUpperCase();
  return { cidade, uf: UFS.has(uf) ? uf : null };
}

// Id aleatorio que o app gera na primeira abertura e guarda no aparelho. Liga eventos,
// rascunhos e o pedido da mesma instalacao.
const INSTALACAO = /^[A-Za-z0-9_-]{8,100}$/;

export function validarInstalacaoId(valor) {
  const id = String(valor ?? '').trim();
  if (!INSTALACAO.test(id)) throw recusa('instalacao', 'Atualize o app para continuar o cadastro.');
  return id;
}

// Hora que o aparelho informou (texto ISO ou milissegundos). Fica como Date, ou null quando falta.
export function validarHoraDoAparelho(valor, campo = 'hora') {
  if (valor === undefined || valor === null || valor === '') return null;
  const data = new Date(typeof valor === 'number' ? valor : String(valor));
  if (Number.isNaN(data.getTime())) throw recusa(campo, 'Hora do aparelho inválida.');
  return data;
}

function textoDaReceita(valor, maximo) {
  const texto = textoLimpo(valor);
  if (!texto || HTML.test(texto)) return null;
  return texto.slice(0, maximo);
}

// Retorno da Receita que o app guardou no passo 2 (o mesmo da consulta POST /loja/cnpj).
// So texto curto, sem HTML; o que nao e do formato fica de fora.
function receitaDoRascunho(valor = {}) {
  const endereco = valor?.endereco || {};
  const simNao = (item) => (typeof item === 'boolean' ? item : null);
  return {
    cnpjConferido: simNao(valor?.cnpjConferido),
    encontrado: simNao(valor?.encontrado),
    ativa: simNao(valor?.ativa),
    situacao: textoDaReceita(valor?.situacao, 60),
    razaoSocial: textoDaReceita(valor?.razaoSocial, 200),
    nomeFantasia: textoDaReceita(valor?.nomeFantasia, 200),
    endereco: {
      street: textoDaReceita(endereco.street, 200),
      number: textoDaReceita(endereco.number, 40),
      complement: textoDaReceita(endereco.complement, 200),
      neighborhood: textoDaReceita(endereco.neighborhood, 200),
      city: textoDaReceita(endereco.city, 120),
      uf: textoDaReceita(endereco.uf, 2)?.toUpperCase() || null,
      zipCode: somenteDigitos(endereco.zipCode).slice(0, 8) || null,
    },
  };
}

export const CAMPOS_DE_SENHA = Object.freeze(['senha', 'repitaSenha', 'senhaConfirmacao', 'password']);

// Rascunho de cada passo do cadastro (jornada). Nunca leva senha. O passo 1 so vale com o
// aceite dos termos; os passos 2 e 3 sao conferidos contra o passo 1 gravado por quem chama.
export function validarRascunho(passo, dados = {}) {
  if (CAMPOS_DE_SENHA.some((campo) => dados && Object.prototype.hasOwnProperty.call(dados, campo))) {
    throw recusa('rascunho', 'O rascunho do cadastro não leva senha.');
  }
  if (passo === 1) {
    if (dados?.aceiteTermos?.aceito !== true) {
      throw recusa('termos', 'Aceite os termos e a política de privacidade para continuar.');
    }
    return {
      nome: validarNomeResponsavel(dados.nome),
      celular: validarCelular(dados.celular),
      email: validarEmail(dados.email),
      erp: validarErp(dados.erp),
      aceiteTermos: { aceito: true, horaDoAparelho: validarHoraDoAparelho(dados.aceiteTermos.em, 'termos') },
    };
  }
  if (passo === 2) {
    return { cnpj: validarCnpj(dados.cnpj), receita: receitaDoRascunho(dados.receita) };
  }
  if (passo === 3) {
    return { endereco: validarEndereco(dados.endereco, { completo: false }) };
  }
  throw recusa('passo', 'Passo do cadastro inválido.');
}

// Tudo do pedido de cadastro, na ordem das telas do app. Sem CPF (decisao do Thay de 17/10/2026:
// nada exige CPF do dono; se vier no corpo, e ignorado), sem RG e sem data de nascimento.
// `nome` e o "Nome real que esta na fachada" (mesma regra do nome da loja).
export function validarPedidoDeCadastro(entrada = {}) {
  return {
    cnpj: validarCnpj(entrada.cnpj),
    nome: validarNomeNoApp(entrada.nome),
    responsavel: {
      nome: validarNomeResponsavel(entrada.responsavel?.nome),
      celular: validarCelular(entrada.responsavel?.celular),
      email: validarEmail(entrada.responsavel?.email),
    },
    erp: validarErp(entrada.erp),
    endereco: validarEndereco(entrada.endereco, { completo: true }),
    instalacaoId: entrada.instalacaoId == null || entrada.instalacaoId === '' ? null : validarInstalacaoId(entrada.instalacaoId),
    senha: validarSenha(entrada.senha),
  };
}
