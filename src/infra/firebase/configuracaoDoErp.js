// Leitura da configuracao do ERP da loja (Cola 71, item 3): o documento da loja e o sinal de vida
// (IntegrationStatus/current), numa leitura so (getAll), como a nuvem do Log do ERP. Devolve so os
// campos da chave do ERP; o caso de uso tira o nome (application/produtos/nomeDoErp.js).
function soChave(dados) {
  if (!dados) return null;
  const configs = dados.integradorConfigs;
  return {
    integradorConfigs: typeof configs === 'object' && configs !== null ? { erpKey: configs.erpKey ?? null } : null,
    erpKey: dados.erpKey ?? null,
  };
}

export async function lerConfiguracaoDoErp(firestore, lojaId) {
  const loja = firestore.collection('estabelecimentos').doc(lojaId);
  const [docDaLoja, status] = await firestore.getAll(loja, loja.collection('IntegrationStatus').doc('current'));
  return {
    loja: docDaLoja.exists ? soChave(docDaLoja.data() || {}) : null,
    status: status.exists ? { erpKey: status.data()?.erpKey ?? null } : null,
  };
}
