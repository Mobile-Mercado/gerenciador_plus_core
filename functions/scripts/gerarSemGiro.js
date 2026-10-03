const admin = require('firebase-admin');
const { SEM_GIRO_DOCUMENT, atualizarSemGiro } = require('../semGiro');

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function usage() {
  return [
    'Uso:',
    '  node scripts/gerarSemGiro.js --loja ID [--gravar] [--project ID]',
    '',
    'Sem --gravar, so le: mostra a lista Sem giro, o total e o tamanho do documento.',
    `Com --gravar, grava estabelecimentos/{loja}/Stats/${SEM_GIRO_DOCUMENT}.`,
  ].join('\n');
}

async function main() {
  const lojaId = argument('loja');
  if (!lojaId) {
    console.error(usage());
    process.exitCode = 1;
    return;
  }
  const gravar = process.argv.includes('--gravar');
  const projectId = argument('project') || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  admin.initializeApp(projectId ? { projectId } : undefined);
  const db = admin.firestore();

  const resultado = await atualizarSemGiro({ db, FieldValue: admin.firestore.FieldValue, lojaId, gravar });
  const { catalogo, ...documento } = resultado;
  console.log(`Loja ${lojaId}: catalogo ${catalogo} produtos fora da lixeira, meses ${documento.meses.join(' e ')}`);
  console.log(`sem giro: ${documento.total} produtos; a tabela mostra ${documento.produtos.length}`);
  documento.produtos.forEach((produto, indice) => console.log(`${indice + 1}. ${produto.nome} | ${produto.estoque} | ${produto.id}`));
  console.log(`tamanho do documento: ${Buffer.byteLength(JSON.stringify(documento))} bytes`);
  console.log(gravar
    ? `\nGravado estabelecimentos/${lojaId}/Stats/${SEM_GIRO_DOCUMENT}.`
    : '\nSimulacao: nada foi gravado. Use --gravar para gravar o documento.');
}

main().catch((error) => {
  console.error('[gerarSemGiro] Falha', error.message);
  process.exitCode = 1;
});
