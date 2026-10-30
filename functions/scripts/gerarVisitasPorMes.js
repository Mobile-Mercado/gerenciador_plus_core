const admin = require('firebase-admin');
const { configuredEstablishmentIds } = require('../productImageFileCheck');
const { VISITAS_POR_MES_DOCUMENT, somarVisitasPorMes } = require('../visitasPorMes');

// Carga inicial de estabelecimentos/{loja}/Stats/visitasPorMes: le todo o DailyStats da loja uma vez.
// Sem --gravar, so le e imprime. Gravar so depois de autorizado.
const IMAGE_CHECK_CONFIG_PATH = 'CoreJobs/verifyProductImageFiles';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function usage() {
  return [
    'Uso:',
    '  node scripts/gerarVisitasPorMes.js [--loja ID] [--gravar] [--project ID]',
    '',
    `Sem --loja, usa as lojas de ${IMAGE_CHECK_CONFIG_PATH} (as mesmas da rotina visitasPorMesNightly).`,
    'Sem --gravar, so le: documentos lidos, meses, visitas do app e do agente e quantos dias nao tem createdAt.',
    `Com --gravar, grava estabelecimentos/{loja}/Stats/${VISITAS_POR_MES_DOCUMENT} (todos os meses).`,
  ].join('\n');
}

async function lojasDaRotina(db) {
  const config = await db.doc(IMAGE_CHECK_CONFIG_PATH).get();
  return configuredEstablishmentIds(config.data());
}

async function main() {
  if (process.argv.includes('--ajuda')) {
    console.log(usage());
    return;
  }
  const gravar = process.argv.includes('--gravar');
  const projectId = argument('project') || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  admin.initializeApp(projectId ? { projectId } : undefined);
  const db = admin.firestore();
  const lojas = argument('loja') ? [argument('loja')] : await lojasDaRotina(db);
  if (!lojas.length) {
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  for (const lojaId of lojas) {
    const loja = db.collection('estabelecimentos').doc(lojaId);
    // eslint-disable-next-line no-await-in-loop
    const snapshot = await loja.collection('DailyStats').get();
    const soma = somarVisitasPorMes(snapshot.docs.map((documento) => ({ id: documento.id, dados: documento.data() })));
    const meses = Object.keys(soma.meses).sort();
    const app = meses.reduce((total, mes) => total + soma.meses[mes].app, 0);
    const agente = meses.reduce((total, mes) => total + soma.meses[mes].agente, 0);
    console.log(`Loja ${lojaId}`);
    console.log(`  documentos lidos: ${soma.lidos} (fora do formato DD-MM-AAAA: ${soma.foraDoFormato})`);
    console.log(`  meses: ${meses.length}${meses.length ? ` (${meses[0]} a ${meses[meses.length - 1]})` : ''}`);
    console.log(`  visitas do app: ${app} | visitas do agente: ${agente}`);
    console.log(`  dias sem createdAt: ${soma.semCreatedAt} (a tela filtra os 30 dias por createdAt; esses ficam de fora dela)`);
    console.log(`  atualizadoAte: ${soma.ultimoDia || '-'}`);
    if (gravar) {
      // eslint-disable-next-line no-await-in-loop
      await loja.collection('Stats').doc(VISITAS_POR_MES_DOCUMENT).set({
        meses: soma.meses,
        ...(soma.ultimoDia ? { atualizadoAte: soma.ultimoDia } : {}),
        atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`  gravado estabelecimentos/${lojaId}/Stats/${VISITAS_POR_MES_DOCUMENT}`);
    }
  }
  if (!gravar) console.log('\nSimulacao: nada foi gravado. Use --gravar para gravar (so depois de autorizado).');
}

main().catch((error) => {
  console.error('[gerarVisitasPorMes] Falha', error.message);
  process.exitCode = 1;
});
