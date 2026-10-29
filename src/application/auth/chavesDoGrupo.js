// Grupo de permissao antigo no painel novo (RP-62, E.8, contrato K8).
//
// O painel novo tem tres chaves que o antigo nao tinha. Um grupo antigo ganha so a chave nova cuja
// tela equivalente ele ja via na web antiga (web_gerenciador 7ec5557); o resto fica desligado. A
// conta e feita aqui, na leitura: nada e gravado no PermissionGroups.
//
// O que a web antiga exigia (src/App.jsx, src/components/ProtectedRoute.jsx, src/utils/permissoes.js,
// src/components/Navbar.jsx):
// - dashboard.view (Inicio) <- a Home "/", sem `tela` no ProtectedRoute e fora do TELA_POR_ROTA da
//   Navbar: todo grupo via (vendas da semana em R$ e o funil). Todo grupo antigo ganha.
// - logs.view (Logs) <- "/logs" ("Logs do integrador"), com tela="settings": quem tinha settings.view.
// - finance.view (Financeiro) <- nenhuma tela da web antiga (nao havia Financeiro, A receber nem
//   Faturamento). Nenhum grupo antigo ganha.
export const CHAVES_DO_PAINEL_NOVO = Object.freeze(['dashboard.view', 'finance.view', 'logs.view']);

// Grupo novo: salvo pelo painel novo (marca `painelNovo: true`, gravada pelas callables
// createPermissionGroup e updatePermissionGroup do mobile_firebase_api quando o painel novo pede) ou
// que ja tem alguma das chaves novas. Os outros sao antigos.
export function grupoEhAntigo(grupo) {
  if (!grupo || grupo.isAdmin === true || grupo.painelNovo === true) return false;
  const chaves = Array.isArray(grupo.permissions) ? grupo.permissions : [];
  return !chaves.some((chave) => CHAVES_DO_PAINEL_NOVO.includes(chave));
}

// Chaves novas que o grupo antigo ganha: dashboard.view sempre; logs.view com settings.view.
export function chavesHerdadas(grupo) {
  if (!grupoEhAntigo(grupo)) return [];
  const chaves = Array.isArray(grupo.permissions) ? grupo.permissions : [];
  return ['dashboard.view', ...(chaves.includes('settings.view') ? ['logs.view'] : [])];
}

// Chaves que valem na sessao e nas barreiras do Core: as gravadas mais as herdadas.
export function chavesDoGrupo(grupo) {
  const chaves = Array.isArray(grupo?.permissions) ? grupo.permissions : [];
  return [...chaves, ...chavesHerdadas(grupo)];
}
