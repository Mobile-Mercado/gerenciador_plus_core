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
//
// Cola B57-13p, item 35: nas acoes do Log da equipe (AcoesEquipe) uma a uma, o registro antigo tem
// origem exata: o Admin deixa na loja, desde 13/10/2026, o registro AdminAuditLogs (action
// 'admin_plataforma') com os documentos que gravou (details.caminhos). Acao que consta nele some; as
// outras aparecem, mesmo de conta Admin. Antes de 13/10 o Admin nao agia nas lojas pelo painel (o
// cabecalho X-Loja-Alvo nasceu nesse dia), entao o registro de antes aparece. As linhas da planilha
// (gravadas pelo Core, fora desse registro) e os lotes (historicoProdutos_N) seguem a regra por conta.
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

// Linha da importacao por planilha (ImportProductsFromCsvUseCase.linhaDoLog).
export function ehLinhaDePlanilha(registro) {
  return registro?.tela === 'implantacao' && registro?.origem === 'implantacao' && registro?.alvo?.tipo === 'produto';
}

// Uma acao do Log da equipe (AcoesEquipe). `caminho`: o do documento; `caminhosDoAdmin`: os
// documentos que o Admin gravou na loja (AdminAuditLogs); `contas`: as de usersAdmin.
export function ehAcaoDoAdmin(registro, { caminho = '', caminhosDoAdmin = null, contas = null } = {}) {
  if (!registro || typeof registro !== 'object') return false;
  if (registro.autor && typeof registro.autor === 'object') return registro.autor.tipo === AUTOR_ADMIN;
  if (registro.origem === 'app') return false;
  if (caminho && caminhosDoAdmin?.has(caminho)) return true;
  return ehLinhaDePlanilha(registro) && ehDoAdmin(registro, contas);
}

// Documentos de AcoesEquipe da loja que constam no registro do Admin na loja.
export function caminhosDoAdminNasAcoes(registrosDoAdmin = [], lojaId = '') {
  const prefixo = `estabelecimentos/${lojaId}/AcoesEquipe/`;
  const caminhos = new Set();
  registrosDoAdmin.forEach((registro) => {
    if (registro?.action !== 'admin_plataforma') return;
    (Array.isArray(registro.details?.caminhos) ? registro.details.caminhos : [])
      .filter((caminho) => typeof caminho === 'string' && caminho.startsWith(prefixo))
      .forEach((caminho) => caminhos.add(caminho));
  });
  return caminhos;
}

export function contasDeUsersAdmin(documentos = []) {
  const contas = new Set();
  documentos.forEach(({ id, data }) => {
    if (id) contas.add(normalizar(id));
    if (data?.email) contas.add(normalizar(data.email));
  });
  return contas;
}
