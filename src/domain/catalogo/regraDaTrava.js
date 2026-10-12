// Regra unica da trava (decisao do Thay de 12/10/2026): a categoria esta travada numa loja
// quando esta travada na lista padrao (categoriasProdutos/{id}.travada) e nao tem liberacao
// para aquela loja (liberacoesCategorias/{lojaId}.liberadas.{id}). Vale para o "Ativar" do
// painel, para o ligar da categoria, para o categorizador, para a IA e para o CSV.
// A mesma funcao existe no painel (src/features/catalogo/regraDaTrava.js).

export function travadaNaLoja(categoriaId, { travadas, liberadas } = {}) {
  if (!categoriaId) return false;
  const doPadrao = travadas instanceof Set ? travadas : new Set(travadas || []);
  const daLoja = liberadas instanceof Set ? liberadas : new Set(liberadas || []);
  return doPadrao.has(categoriaId) && !daLoja.has(categoriaId);
}

export function travadasNaLoja({ travadas, liberadas } = {}) {
  const daLoja = liberadas instanceof Set ? liberadas : new Set(liberadas || []);
  return [...(travadas || [])].filter((id) => !daLoja.has(id));
}
