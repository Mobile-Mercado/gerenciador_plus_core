const admin = require('firebase-admin');
const { CAMPO, rodarProvedoresDeLogin } = require('../provedoresDeLogin');

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function usage() {
  return [
    'Uso:',
    '  node scripts/syncLoginProviders.js [--project ID]',
    '',
    'Atalho de execucao da rotina syncLoginProvidersNightly, sem esperar a 1h: copia o',
    'provedor de login de cada conta do Authentication para Users.{provedoresDeLogin}.',
    'As tres funcoes passadas sao as mesmas da rotina agendada; nenhuma regra mora aqui.',
  ].join('\n');
}

async function main() {
  if (process.argv.includes('--help')) throw new Error(usage());
  const projectId = argument('project') || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;

  admin.initializeApp(projectId ? { projectId } : undefined);
  const db = admin.firestore();

  const startedAt = Date.now();
  const resumo = await rodarProvedoresDeLogin({
    listarContas: async ({ pageToken, maximo }) => {
      const pagina = await admin.auth().listUsers(maximo, pageToken);
      return { contas: pagina.users, pageToken: pagina.pageToken };
    },
    // Uma leitura por documento de Users, uma vez por passada.
    lerUsuarios: async () => {
      const snapshot = await db.collection('Users').select('userAuthId', CAMPO).get();
      return snapshot.docs;
    },
    gravar: ({ id, provedores }) => db
      .collection('Users')
      .doc(id)
      .set({ [CAMPO]: provedores }, { merge: true }),
  });

  console.log(JSON.stringify({ ...resumo, segundos: Math.round((Date.now() - startedAt) / 1000) }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
