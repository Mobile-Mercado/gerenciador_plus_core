const admin = require('firebase-admin');
const {
  loadAgentConversationData,
  summarizeConversations,
  writeAgentConversationsSummary,
} = require('../agenteConversas');
const { testAccountIdsFor } = require('../productImageFileCheck');

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function usage() {
  return [
    'Uso:',
    '  node scripts/summarizeAgentConversations.js --establishment ID [--top 20]',
    '  node scripts/summarizeAgentConversations.js --establishment ID --apply',
    '',
    'Sem --apply, so le e imprime o resumo. Com --apply, grava em',
    'estabelecimentos/{id}/Stats/agenteConversas.',
    'O resumo guarda so termos e contagens: nenhum texto de mensagem ou dado de cliente.',
  ].join('\n');
}

async function main() {
  const establishmentId = argument('establishment');
  const apply = process.argv.includes('--apply');
  const top = Math.max(1, Number(argument('top')) || 20);
  const projectId = argument('project') || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  if (!establishmentId) throw new Error(usage());

  admin.initializeApp(projectId ? { projectId } : undefined);
  const db = admin.firestore();
  const storeRef = db.collection('estabelecimentos').doc(establishmentId);
  if (!(await storeRef.get()).exists) throw new Error(`Loja ${establishmentId} nao encontrada.`);

  const startedAt = Date.now();
  const data = await loadAgentConversationData({
    db,
    storeRef,
    documentIdPath: admin.firestore.FieldPath.documentId(),
    testAccountIdsFor,
  });
  const loadedIn = Date.now() - startedAt;
  const summary = summarizeConversations(data);
  if (apply) {
    await writeAgentConversationsSummary({
      storeRef,
      summary,
      generatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  const { termos, familias, naoAgrupados, ...totals } = summary;
  console.log(JSON.stringify({
    modo: apply ? 'gravacao' : 'somente-leitura',
    establishmentId,
    ...totals,
    termosDistintos: termos.length,
    familiasDistintas: familias.length,
    naoAgrupadosDistintos: naoAgrupados.length,
    familias: familias.slice(0, top),
    naoAgrupados: naoAgrupados.slice(0, top),
    lidos: data.counts,
    bytesDoDocumento: Buffer.byteLength(JSON.stringify(summary)),
    leituraSegundos: Math.round(loadedIn / 100) / 10,
    duracaoSegundos: Math.round((Date.now() - startedAt) / 100) / 10,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
