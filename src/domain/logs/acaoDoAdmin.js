// Cola do Thay B57-13k, item 35: "nada que o Admin faz fica visivel para o gerente ou para o dono
// da loja, nem nos Logs nem em outra tela". As linhas do Log da equipe (AcoesEquipe) e os registros
// de lote (historicoProdutos_N) feitos pelo admin da plataforma ficam escondidos da loja na leitura.
// Nada e apagado nem alterado no banco.
//
// Linha do Admin:
// - gravada pelo Core desde esta cola com autor.tipo 'adminDaPlataforma' (admin agindo na loja pelo
//   cabecalho X-Loja-Alvo);
// - ou, nas linhas antigas, com `quem` igual ao e-mail ou ao uid de uma conta de usersAdmin.
// A conta principal da loja nunca entra como Admin, mesmo que o e-mail dela esteja em usersAdmin.
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
  if (registro.autor?.tipo === AUTOR_ADMIN) return true;
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
