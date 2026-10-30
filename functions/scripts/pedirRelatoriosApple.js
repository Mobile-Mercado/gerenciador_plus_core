const fs = require('node:fs');
const { clienteDaApple } = require('../instalacoesApp');

// Pedido dos relatorios de analise da Apple (rodar uma vez, na maquina local): para cada app da conta,
// um pedido ONGOING (relatorios diarios daqui para a frente) e um ONE_TIME_SNAPSHOT (o historico).
// Usa a chave Admin temporaria: caminho do .p8 em APPLE_ADMIN_P8_PATH, com APPLE_ISSUER_ID e
// APPLE_KEY_ID. A chave nunca vai para o repositorio e nunca e impressa. Depois de rodar, revogar a chave.
//
// Sem --confirmar, so lista os apps e os pedidos que ja existem (nada e criado).

const TIPOS = ['ONGOING', 'ONE_TIME_SNAPSHOT'];

async function main() {
  const { APPLE_ADMIN_P8_PATH: caminho, APPLE_ISSUER_ID: issuerId, APPLE_KEY_ID: keyId } = process.env;
  if (!caminho || !issuerId || !keyId) {
    console.error('Defina APPLE_ADMIN_P8_PATH, APPLE_ISSUER_ID e APPLE_KEY_ID (a chave Admin temporaria).');
    process.exitCode = 1;
    return;
  }
  const confirmar = process.argv.includes('--confirmar');
  const cliente = clienteDaApple({ chaveP8: fs.readFileSync(caminho, 'utf8'), issuerId, keyId });
  const apps = await cliente.todos('/v1/apps?fields[apps]=name,bundleId&limit=200');
  for (const app of apps) {
    const { name, bundleId } = app.attributes || {};
    console.log(`\n${name} | ${bundleId} | app ${app.id}`);
    // eslint-disable-next-line no-await-in-loop
    const existentes = await cliente.todos(`/v1/apps/${app.id}/analyticsReportRequests`);
    for (const tipo of TIPOS) {
      const existente = existentes.find((pedido) => pedido.attributes?.accessType === tipo && !pedido.attributes?.stoppedDueToInactivity);
      if (existente) {
        console.log(`  ${tipo}: ja existe, pedido ${existente.id}`);
        continue;
      }
      if (!confirmar) {
        console.log(`  ${tipo}: nao existe (use --confirmar para criar)`);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const criado = await cliente.pedir('/v1/analyticsReportRequests', {
        method: 'POST',
        corpo: {
          data: {
            type: 'analyticsReportRequests',
            attributes: { accessType: tipo },
            relationships: { app: { data: { type: 'apps', id: app.id } } },
          },
        },
      });
      console.log(`  ${tipo}: criado, pedido ${criado.data?.id}`);
    }
  }
  console.log(confirmar
    ? '\nPedidos feitos. Revogue agora a chave Admin temporaria no App Store Connect.'
    : '\nSimulacao: nada foi criado. Use --confirmar para criar os pedidos que faltam.');
}

main().catch((error) => {
  console.error('[pedirRelatoriosApple] Falha', error.message);
  process.exitCode = 1;
});
