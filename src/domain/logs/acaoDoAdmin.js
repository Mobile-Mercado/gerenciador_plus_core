// Cola do Thay B57-13k, item 35: "nada que o Admin faz fica visivel para o gerente ou para o dono
// da loja, nem nos Logs nem em outra tela". As linhas do Log da equipe (AcoesEquipe) e os registros
// de lote (historicoProdutos_N) feitos pelo admin da plataforma ficam escondidos da loja na leitura.
// Nada e apagado nem alterado no banco.
//
// Cola B57-13o, item 35: o criterio e a ORIGEM da acao, nao a conta.
// - Registro com marca de origem (campo `autor`, gravado pelo Core): so some o feito pelas telas do
//   Admin (autor.tipo 'adminDaPlataforma', cabecalho X-Loja-Alvo). Painel da loja (contaDaLoja ou
//   funcionario) aparece, mesmo que a conta tambem seja Admin.
// - Acao do App Gerenciador (origem 'app') aparece sempre.
// - Registro antigo, sem marca de origem: a regra por conta de b79d25c (`quem` igual ao e-mail ou ao
//   uid de uma conta de usersAdmin), porque nao ha no proprio registro como saber de onde veio.
// A conta principal da loja nunca entra como Admin na regra por conta.
// Rotinas do Core (promocao vencida, `quem` vazio) e o integrador nao sao Admin.

export const AUTOR_ADMIN = 'adminDaPlataforma';

const normalizar = (valor) => String(valor ?? '').trim().toLowerCase();

// `contas`: Set com e-mails e uids das contas de usersAdmin, em minusculas.
export function contasDoAdminParaALoja(contas, contaDaLoja = null) {
  const resultado = new Set(contas || []);
  [contaDaLoja?.uid, contaDaLoja?.email].map(normalizar).filter(Boolean).forEach((valor) => resultado.delete(valor));
  return resultado;
}

export function ehDoAdmin(registro, contas) {
  if (!registro || typeof registro !== 'object') return false;
  if (registro.autor && typeof registro.autor === 'object') return registro.autor.tipo === AUTOR_ADMIN;
  if (registro.origem === 'app') return false;
  const quem = normalizar(registro.quem);
  return Boolean(quem) && Boolean(contas?.has(quem));
}

export function contasDeUsersAdmin(documentos = []) {
  const contas = new Set();
  documentos.forEach(({ id, data }) => {
    if (id) contas.add(normalizar(id));
    if (data?.email) contas.add(normalizar(data.email));
  });
  return contas;
}
