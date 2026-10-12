import { chaveDoNome } from './formatarNome.js';

// Mercearia e Todos sao achadas pelo nome no app e no painel: nao mudam de nome, nao
// desligam, nao arquivam e nao travam, na lista padrao e nas lojas (decisao do Thay de
// 12/10/2026). Conferidas pelo id e pelo nome.
const IDS = new Set(['mercearia', 'todos']);
const NOMES = new Set(['mercearia', 'todos']);

export function categoriaProtegida({ id, nome } = {}) {
  return IDS.has(String(id || '')) || NOMES.has(chaveDoNome(nome));
}
