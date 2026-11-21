// Nome do ERP da loja (Cola 71, item 3), com a mesma regra da nuvem que grava o Log do ERP
// (old-web-integrador-por-loja, functions/src/services/products/log-do-erp.ts, chaveDoErp e
// nomeDoErp):
// - chave: a do painel no documento da loja (integradorConfigs.erpKey ou erpKey) e, sem ela, a do
//   sinal de vida (estabelecimentos/{loja}/IntegrationStatus/current.erpKey);
// - nome: so chave conhecida vira nome (linear_v1 -> "Linear"); chave ausente ou desconhecida, null.
// O web usa o nome no motivo fora_do_erp ("fora do Linear"); sem nome, o motivo nao aparece.

export const NOMES_DOS_ERPS = Object.freeze({ linear_v1: 'Linear' });

function objeto(valor) {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

function texto(valor) {
  return typeof valor === 'string' && valor.trim().length > 0 ? valor : null;
}

export function chaveDoErp(loja, status) {
  const daLoja = objeto(loja)
    ? (texto(objeto(loja.integradorConfigs) ? loja.integradorConfigs.erpKey : null) ?? texto(loja.erpKey))
    : null;
  if (daLoja !== null) return daLoja.trim();
  const doStatus = objeto(status) ? texto(status.erpKey) : null;
  return doStatus === null ? null : doStatus.trim();
}

export function nomeDoErp(chave) {
  if (typeof chave !== 'string') return null;
  const limpa = chave.trim();
  return Object.prototype.hasOwnProperty.call(NOMES_DOS_ERPS, limpa) ? NOMES_DOS_ERPS[limpa] : null;
}

export function nomeDoErpDaLoja(loja, status) {
  return nomeDoErp(chaveDoErp(loja, status));
}
