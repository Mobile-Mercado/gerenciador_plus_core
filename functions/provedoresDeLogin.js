// Como cada pessoa entrou na conta: Google, Apple, telefone por SMS, ou email e senha.
//
// Quem guarda isso e o Firebase Authentication, e so o lado administrativo le. A rotina
// copia o dado para o documento do cliente em Users, no campo provedoresDeLogin, para o
// painel poder mostrar o icone pelo mesmo caminho dos outros campos.
//
// Arquivo puro: nao requer firebase-admin nem firebase-functions. Recebe por parametro a
// funcao que lista as contas, a que le os documentos e a que grava.
//
// Tres estados diferentes, de proposito:
//   lista com provedores  a pessoa entrou por eles; o valor e o cru do Firebase
//                         ('phone', 'google.com', 'apple.com', 'password').
//   lista vazia           conta anonima: entrou sem se identificar. Medido, e vazio.
//   campo ausente         a rotina nao alcancou essa pessoa. Nao e a mesma coisa.
const PROVEDORES_VERSION = 1;
const CAMPO = 'provedoresDeLogin';
const PAGINA_DE_CONTAS = 1000;

// Valores crus do Firebase, ordenados, sem repetir. Conta anonima devolve lista vazia.
function provedoresDaConta(conta = {}) {
  const lista = Array.isArray(conta.providerData) ? conta.providerData : [];
  return [...new Set(lista.map((item) => String(item?.providerId || '')).filter(Boolean))].sort();
}

// Users tem dois caminhos para a mesma pessoa: o id do documento pode ser o uid da conta,
// ou o uid aparece no campo userAuthId. Os dois existem na base, e o indice cobre os dois.
function indiceDeUsuarios(documentos = []) {
  const porAuthId = new Map();
  const porDocumento = new Map();
  documentos.forEach((documento) => {
    const atual = documento?.get ? documento.get(CAMPO) : undefined;
    const entrada = { id: documento.id, atual: Array.isArray(atual) ? atual : null };
    porDocumento.set(documento.id, entrada);
    const authId = documento?.get ? documento.get('userAuthId') : null;
    if (authId) porAuthId.set(String(authId), entrada);
  });
  return {
    porAuthId,
    porDocumento,
    procurar(uid) {
      return porAuthId.get(uid) || porDocumento.get(uid) || null;
    },
  };
}

function mesmaLista(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  return a.length === b.length && a.every((valor, indice) => valor === b[indice]);
}

// listarContas: ({ pageToken }) => { contas, pageToken }. lerUsuarios: () => documentos.
// gravar: ({ id, provedores }) => Promise. Nenhuma escrita quando o valor nao mudou.
async function rodarProvedoresDeLogin({
  listarContas,
  lerUsuarios,
  gravar,
  paginaDeContas = PAGINA_DE_CONTAS,
}) {
  const indice = indiceDeUsuarios(await lerUsuarios());
  const resumo = {
    version: PROVEDORES_VERSION,
    contas: 0,
    anonimas: 0,
    comCadastro: 0,
    semCadastro: 0,
    escritas: 0,
    semMudanca: 0,
    porProvedor: {},
  };

  let pageToken;
  do {
    const pagina = await listarContas({ pageToken, maximo: paginaDeContas });
    const contas = pagina?.contas || [];
    for (const conta of contas) {
      resumo.contas += 1;
      const provedores = provedoresDaConta(conta);
      if (!provedores.length) resumo.anonimas += 1;
      provedores.forEach((provedor) => {
        resumo.porProvedor[provedor] = (resumo.porProvedor[provedor] || 0) + 1;
      });

      const encontrado = indice.procurar(conta.uid);
      if (!encontrado) {
        resumo.semCadastro += 1;
        continue;
      }
      resumo.comCadastro += 1;
      if (mesmaLista(encontrado.atual, provedores)) {
        resumo.semMudanca += 1;
        continue;
      }
      await gravar({ id: encontrado.id, provedores });
      encontrado.atual = provedores;
      resumo.escritas += 1;
    }
    pageToken = pagina?.pageToken;
  } while (pageToken);

  return resumo;
}

module.exports = {
  CAMPO,
  PAGINA_DE_CONTAS,
  PROVEDORES_VERSION,
  indiceDeUsuarios,
  mesmaLista,
  provedoresDaConta,
  rodarProvedoresDeLogin,
};
