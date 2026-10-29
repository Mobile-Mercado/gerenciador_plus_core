// Carga unica do grupo do Resumo do mes nos pedidos antigos (contrato da versao 55, item 7;
// carga autorizada pelo Thay em 21/10/2026). Por padrao so mostra a previa: quantos pedidos e
// itens cairiam em cada grupo e quanto somariam, sem gravar nada. Gravar so com --gravar.
//
//   node scripts/gerarResumoDoMes.js                 previa, sem gravar
//   node scripts/gerarResumoDoMes.js --gravar        grava gruposDosItens, resumoPorGrupo e gruposVersao
//   --loja ID                                       so os pedidos de uma loja
//
// Para o dia da publicacao (cola RP-76), use scripts/gravacoesUnicas/gravar.js --tarefa
// grupos-dos-pedidos: a mesma conta, com copia do antes, conferencia pelo updateTime e desfazer.
//
// Usa as credenciais do ambiente (GOOGLE_APPLICATION_CREDENTIALS ou gcloud). Nao imprime nome,
// telefone, endereco nem itens: so contagens e somas por grupo.
const admin = require('firebase-admin');
const { GRUPOS, GRUPOS_VERSAO, carregarMeta, classificarPedido } = require('../resumoDoMes');

const PROJETO = 'appmobileprod-19505';
const argumento = (nome) => {
  const indice = process.argv.indexOf(`--${nome}`);
  return indice >= 0 ? process.argv[indice + 1] : null;
};

async function principal() {
  const gravar = process.argv.includes('--gravar');
  const lojaId = argumento('loja');
  admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || PROJETO });
  const db = admin.firestore();
  let consulta = db.collection('PurchaseRequests');
  if (lojaId) consulta = consulta.where('companyReference', '==', db.collection('estabelecimentos').doc(lojaId));
  const pedidos = (await consulta.get()).docs;

  const totais = Object.fromEntries(GRUPOS.map((grupo) => [grupo, { itens: 0, valor: 0 }]));
  let jaNaVersao = 0;
  let semItens = 0;
  const gravacoes = [];
  for (const pedido of pedidos) {
    const dados = pedido.data() || {};
    if (dados.gruposVersao === GRUPOS_VERSAO && dados.resumoPorGrupo) { jaNaVersao += 1; continue; }
    if (!Array.isArray(dados.productsCart) || !dados.productsCart.length) semItens += 1;
    const classificacao = classificarPedido(dados, await carregarMeta({ db, pedido: dados }));
    Object.values(classificacao.gruposDosItens).forEach((grupo) => { totais[grupo].itens += 1; });
    Object.entries(classificacao.resumoPorGrupo).forEach(([grupo, valor]) => { totais[grupo].valor += valor; });
    gravacoes.push({ ref: pedido.ref, classificacao });
  }

  console.log(`${gravar ? 'GRAVANDO' : 'PREVIA, sem gravar'}${lojaId ? ` | loja ${lojaId}` : ''}`);
  console.log(`pedidos lidos: ${pedidos.length} | ja na versao ${GRUPOS_VERSAO}: ${jaNaVersao} | a classificar: ${gravacoes.length} | sem itens: ${semItens}`);
  const itensTotais = Object.values(totais).reduce((soma, { itens }) => soma + itens, 0) || 1;
  GRUPOS.forEach((grupo) => {
    const { itens, valor } = totais[grupo];
    console.log(`${grupo.padEnd(26)} itens ${String(itens).padStart(5)} (${((itens / itensTotais) * 100).toFixed(1)}%)  valor R$ ${valor.toFixed(2)}`);
  });

  if (!gravar) return;
  for (let inicio = 0; inicio < gravacoes.length; inicio += 400) {
    const lote = db.batch();
    gravacoes.slice(inicio, inicio + 400).forEach(({ ref, classificacao }) => lote.update(ref, classificacao));
    await lote.commit();
  }
  console.log(`gravados: ${gravacoes.length} pedidos`);
}

principal().catch((erro) => {
  console.error('Falha na carga do Resumo do mes:', erro.message);
  process.exitCode = 1;
});
