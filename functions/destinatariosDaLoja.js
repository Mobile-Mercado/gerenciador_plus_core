// Quem recebe o push de pedido da loja no App Gerenciador (cola B57-18g, item 1, aprovada na
// B57-18i, item 1): o dono e os funcionarios ativos (estabelecimentos/{loja}/AdminUsers) cujo grupo
// (PermissionGroups) tem "Ver pedidos" (requests.view) ou e o Administrador.
//
// A mesma regra esta no mobile_old_web_platform (functions/src/services/destinatariosDaLoja.ts),
// que manda o "Voce vendeu!". Os testes de idsDosDestinatarios e blocosDe sao iguais nos dois:
// uma copia nao muda sem a outra.
//
// Arquivo puro: o banco chega por parametro.

// Limite de valores do "in" do Firestore.
const MAX_IDS_POR_CONSULTA = 30;

// Dono primeiro, como hoje; funcionario sem o campo active conta como ativo; grupo que nao existe
// fica de fora; ninguem repete.
function idsDosDestinatarios(donoId, funcionarios, grupos) {
  const ids = [];
  if (donoId) ids.push(donoId);
  for (const f of funcionarios || []) {
    if (!f || f.active === false) continue;
    const g = grupos.get(f.groupId);
    if (!g) continue;
    const ok = g.isAdmin === true || (Array.isArray(g.permissions) && g.permissions.includes('requests.view'));
    if (ok && f.uid && !ids.includes(f.uid)) ids.push(f.uid);
  }
  return ids;
}

// Fatias de `tamanho` (30, o limite do "in").
function blocosDe(lista, tamanho = MAX_IDS_POR_CONSULTA) {
  const blocos = [];
  for (let inicio = 0; inicio < lista.length; inicio += tamanho) blocos.push(lista.slice(inicio, inicio + tamanho));
  return blocos;
}

// Ids de quem recebe. Falha ao ler AdminUsers ou os grupos: so o dono, com log; o dono nunca fica
// sem o push por causa dos funcionarios.
async function idsDaLoja(db, lojaId, donoId) {
  try {
    const funcionarios = (await db.collection(`estabelecimentos/${lojaId}/AdminUsers`).get()).docs
      .map((d) => ({ uid: d.id, ...d.data() }));
    const idsDeGrupo = [...new Set(funcionarios.filter((f) => f.active !== false).map((f) => f.groupId).filter(Boolean))];
    const lidos = idsDeGrupo.length
      ? await db.getAll(...idsDeGrupo.map((id) => db.doc(`estabelecimentos/${lojaId}/PermissionGroups/${id}`)))
      : [];
    const grupos = new Map(lidos.filter((s) => s.exists).map((s) => [s.id, s.data()]));
    return idsDosDestinatarios(donoId, funcionarios, grupos);
  } catch (error) {
    console.error(`[destinatariosDaLoja] Funcionarios da loja ${lojaId} nao lidos; push so o dono`, error?.message || String(error));
    return idsDosDestinatarios(donoId, [], new Map());
  }
}

// Tokens do App Gerenciador de quem recebe: FcmTokens com clientID in [ate 30], um bloco por vez;
// token sem repetir, com a plataforma de cada um (a mesma forma de antes, so do dono).
async function tokensDaLoja(db, lojaId, donoId) {
  const ids = await idsDaLoja(db, lojaId, donoId);
  const tokens = [];
  const plataformas = [];
  for (const bloco of blocosDe(ids)) {
    const snapshot = await db.collection('FcmTokens').where('clientID', 'in', bloco).get();
    snapshot.docs.forEach((documento) => {
      const token = String(documento.data()?.token || '').trim();
      if (!token || tokens.includes(token)) return;
      tokens.push(token);
      plataformas.push(documento.data()?.platform);
    });
  }
  return { tokens, plataformas };
}

module.exports = {
  MAX_IDS_POR_CONSULTA,
  blocosDe,
  idsDosDestinatarios,
  tokensDaLoja,
};
