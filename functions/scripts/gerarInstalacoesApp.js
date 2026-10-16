const fs = require('node:fs');
const zlib = require('node:zlib');
const admin = require('firebase-admin');
const { getStorage } = require('firebase-admin/storage');
const { configuredEstablishmentIds } = require('../productImageFileCheck');
const {
  APPS_POR_WHITELABEL, INSTALACOES_DOCUMENT, appsDaLoja, atualizarInstalacoes, clienteDaApple,
} = require('../instalacoesApp');

// Carga de todo o historico de estabelecimentos/{loja}/Stats/instalacoesApp. Sem --gravar, so le e
// imprime. Gravar so depois de autorizado.
//
// Variaveis de ambiente (nenhum valor vai para o repositorio nem e impresso):
//   PLAY_REPORTS_BUCKET   bucket de relatorios da Google Play (pubsite_prod_...), lido com a credencial
//                         padrao (gcloud auth application-default login com acesso ao bucket)
//   APPLE_ISSUER_ID, APPLE_KEY_ID   chave de leitura dos relatorios da Apple
//   APPLE_P8_SECRET       nome do segredo no Secret Manager com o .p8 (ex.: APPLE_RELATORIOS_LEITURA_P8),
//                         lido em memoria com a credencial padrao; ou APPLE_P8_PATH, caminho do .p8
// Sem as variaveis de uma loja de apps, aquela plataforma fica de fora e o script avisa.
const IMAGE_CHECK_CONFIG_PATH = 'CoreJobs/verifyProductImageFiles';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function usage() {
  return [
    'Uso:',
    '  node scripts/gerarInstalacoesApp.js [--loja ID] [--gravar] [--project ID]',
    '',
    `Sem --loja, usa as lojas de ${IMAGE_CHECK_CONFIG_PATH}. O app de cada loja vem do whitelabelId dela.`,
    'Sem --gravar, so le: meses lidos, totais por plataforma, instalados agora e dadosAte.',
    `Com --gravar, grava estabelecimentos/{loja}/Stats/${INSTALACOES_DOCUMENT} com todo o historico.`,
  ].join('\n');
}

function somaDe(dias, plataforma, campo) {
  return Object.values(dias).reduce((soma, entrada) => soma + Number(entrada[plataforma]?.[campo] || 0), 0);
}

// Chave .p8 da Apple: do Secret Manager (em memoria, nunca em disco) ou de um arquivo local.
async function chaveDaApple(projectId) {
  if (process.env.APPLE_P8_SECRET) {
    const { GoogleAuth } = require('google-auth-library');
    const cliente = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient();
    const nome = `projects/${projectId}/secrets/${process.env.APPLE_P8_SECRET}/versions/latest`;
    const { data } = await cliente.request({ url: `https://secretmanager.googleapis.com/v1/${nome}:access` });
    return Buffer.from(data.payload.data, 'base64').toString('utf8');
  }
  return process.env.APPLE_P8_PATH ? fs.readFileSync(process.env.APPLE_P8_PATH, 'utf8') : null;
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

  console.log('Apps por whitelabelId (functions/instalacoesApp.js):');
  Object.entries(APPS_POR_WHITELABEL).forEach(([whitelabelId, apps]) => {
    console.log(`  ${whitelabelId}: ${apps.nome} | Android ${apps.android} | iOS ${apps.ios}`);
  });

  const bucketName = process.env.PLAY_REPORTS_BUCKET;
  const bucket = bucketName ? getStorage().bucket(bucketName) : null;
  if (!bucket) console.log('\nSem PLAY_REPORTS_BUCKET: Android fica de fora.');
  const { APPLE_ISSUER_ID: issuerId, APPLE_KEY_ID: keyId } = process.env;
  const chaveP8 = await chaveDaApple(projectId);
  const apple = issuerId && keyId && chaveP8
    ? {
      cliente: clienteDaApple({ chaveP8, issuerId, keyId }),
      baixar: async (url) => Buffer.from(await (await fetch(url)).arrayBuffer()),
      gunzip: (conteudo) => zlib.gunzipSync(conteudo),
    }
    : null;
  if (!apple) console.log('Sem APPLE_ISSUER_ID, APPLE_KEY_ID e a chave (APPLE_P8_SECRET ou APPLE_P8_PATH): iPhone fica de fora.');

  const lojas = argument('loja') ? [argument('loja')] : configuredEstablishmentIds((await db.doc(IMAGE_CHECK_CONFIG_PATH).get()).data());
  for (const lojaId of lojas) {
    // eslint-disable-next-line no-await-in-loop
    const loja = await db.collection('estabelecimentos').doc(lojaId).get();
    const apps = loja.exists ? appsDaLoja(loja.get('whitelabelId')) : null;
    console.log(`\nLoja ${lojaId}${apps ? ` (${apps.nome})` : ''}`);
    if (!apps) {
      console.log('  sem app publicado para o whitelabelId desta loja');
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const resultado = await atualizarInstalacoes({
        db, FieldValue: admin.firestore.FieldValue, lojaId, apps, bucket, apple, meses: null, gravar,
      });
      const { documento } = resultado;
      if (resultado.android) {
        const dimensoes = [...new Set(resultado.android.arquivos.map((arquivo) => arquivo.dimensao))].join(', ') || '-';
        console.log(`  Android: ${resultado.android.meses.length} meses lidos | dimensao ${dimensoes} | codificacao ${resultado.android.codificacoes.join(', ') || '-'}`);
        console.log(`    baixaram ${somaDe(documento.dias, 'android', 'baixaram')} | desinstalaram ${somaDe(documento.dias, 'android', 'desinstalaram')} | instalados agora ${documento.instaladosAgora.android} | total ${documento.totalInstalacoes.android} | dadosAte ${documento.dadosAte.android || '-'}`);
      }
      if (resultado.ios) {
        console.log(`  iPhone: app ${resultado.ios.appId || 'nao achado pelo bundle'} | ${resultado.ios.instancias || 0} instancias diarias`);
        console.log(`    baixaram ${somaDe(documento.dias, 'ios', 'baixaram')} | desinstalaram ${somaDe(documento.dias, 'ios', 'desinstalaram')} | instalados agora ${documento.instaladosAgora.ios} | total ${documento.totalInstalacoes.ios} | dadosAte ${documento.dadosAte.ios || '-'}`);
      }
      if (gravar) console.log(`  gravado estabelecimentos/${lojaId}/Stats/${INSTALACOES_DOCUMENT}`);
    } catch (error) {
      console.log(`  falhou: ${error.message}`);
    }
  }
  if (!gravar) console.log('\nSimulacao: nada foi gravado. Use --gravar para gravar (so depois de autorizado).');
}

main().catch((error) => {
  console.error('[gerarInstalacoesApp] Falha', error.message);
  process.exitCode = 1;
});
