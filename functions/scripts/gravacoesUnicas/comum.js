// Partes comuns da gravacao e do desfazer: argumentos, a chave de gravar e as copias.
const fs = require('node:fs');
const path = require('node:path');
const { PROJETO_PRODUCAO, ehAusente, lerValor } = require('./firestoreRest');

const argumento = (nome) => {
  const indice = process.argv.indexOf(`--${nome}`);
  return indice >= 0 ? process.argv[indice + 1] : null;
};
const temChave = (nome) => process.argv.includes(`--${nome}`);

// Pasta das copias: fora do git e de pasta sincronizada (cola RP-76). O padrao e a do ambiente
// local, ao lado dos repositorios.
const PASTA_DAS_COPIAS = path.resolve(__dirname, '../../../../ambiente-local-rp44/seguranca-v55/gravacoes-unicas');

// A chave de gravar: --gravar sozinho nao grava. Precisa de --confirmar com o id do projeto em
// uso, digitado (no dia, so com o ok do Thay).
function modoDeGravacao(projeto) {
  const gravar = temChave('gravar');
  if (!gravar) return false;
  if (argumento('confirmar') !== projeto) {
    throw new Error(`Para gravar, repita o projeto: --gravar --confirmar ${projeto}. Nada foi gravado.`);
  }
  return true;
}

const projetoEmUso = () => argumento('projeto') || PROJETO_PRODUCAO;
const carimbo = () => new Date().toISOString().replace(/[:.]/g, '-');

function salvarJson(pasta, nome, conteudo) {
  fs.mkdirSync(pasta, { recursive: true });
  const arquivo = path.join(pasta, nome);
  fs.writeFileSync(arquivo, `${JSON.stringify(conteudo, null, 2)}\n`);
  return arquivo;
}

// Pedido so aparece como contagem na tela (cola RP-76): loja e produto podem ter o id impresso.
const ehPedido = (caminho) => caminho.startsWith('PurchaseRequests/');

// Valor REST (ou ausente) legivel na previa.
const legivel = (valor) => (valor === undefined || ehAusente(valor) ? '(ausente)' : JSON.stringify(lerValor(valor)));

function mostrarMudancas(mudancas, { detalhe = true } = {}) {
  const pedidos = mudancas.filter((mudanca) => ehPedido(mudanca.caminho)).length;
  if (pedidos) console.log(`pedidos: ${pedidos} (so a contagem; os ids ficam na copia)`);
  mudancas.filter((mudanca) => !ehPedido(mudanca.caminho)).forEach((mudanca) => {
    console.log(`- ${mudanca.caminho}${mudanca.rotulo ? ` (${mudanca.rotulo})` : ''}`);
    if (!detalhe) return;
    Object.keys(mudanca.depois).forEach((campo) => {
      console.log(`    ${campo}: ${legivel(mudanca.antes[campo])} -> ${legivel(mudanca.depois[campo])}`);
    });
  });
}

module.exports = {
  PASTA_DAS_COPIAS,
  argumento,
  carimbo,
  ehPedido,
  legivel,
  modoDeGravacao,
  mostrarMudancas,
  projetoEmUso,
  salvarJson,
  temChave,
};
