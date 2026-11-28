// Cola do Thay B57-13, item 28: autor das acoes do painel no Log da equipe
// (estabelecimentos/{loja}/AcoesEquipe). O Core grava o campo `autor` em cada acao que o painel
// grava pelo proxy de dados, no lugar do que vier no corpo:
//   { tipo: 'contaDaLoja' | 'funcionario', nome, email, computador }
// - contaDaLoja: a conta principal da loja, a do Users para o qual estabelecimentos/{loja}.userReference
//   aponta (criada no cadastro da loja). O web mostra o e-mail.
// - funcionario: o login criado em "Novo funcionario" (AdminUsers). O web mostra o nome.
// - computador: o nome dado ao navegador em "Acessos conectados" (SessoesWeb/{X-Sessao}.nome), ou null;
//   computadorAutomatico: "{sistema} · {navegador}" da sessao (cola B57-18l, item 2). Sem sessao, nenhum
//   dos dois (o web mostra "Navegador sem nome").
// O admin da plataforma agindo na loja (X-Loja-Alvo) grava autor.tipo 'adminDaPlataforma' (cola B57-13k,
// item 35): a linha fica escondida da loja na leitura (acaoDoAdmin.js).

export const ACOES_DA_EQUIPE = 'AcoesEquipe';

export function ehAcaoDaEquipe(path, establishmentId) {
  const partes = String(path || '').split('/');
  return partes.length === 4
    && partes[0] === 'estabelecimentos'
    && Boolean(establishmentId)
    && partes[1] === establishmentId
    && partes[2] === ACOES_DA_EQUIPE;
}

// Paginas do historico de lotes da equipe (categorizador, taggeador e nomeador): cola B57-13g, 28.5.
export function ehHistoricoDaEquipe(path, establishmentId) {
  const partes = String(path || '').split('/');
  return partes.length === 4
    && partes[0] === 'estabelecimentos'
    && Boolean(establishmentId)
    && partes[1] === establishmentId
    && partes[2] === 'implantacaoGrenciador'
    && /^historicoProdutos_\d+$/.test(partes[3]);
}

export function autorDaAcao(actor, computador) {
  if (!actor) return null;
  if (actor.porAdminDaPlataforma) return { tipo: 'adminDaPlataforma', nome: null, email: null, computador: null };
  const usuario = actor.userDocument || {};
  const ehContaDaLoja = Boolean(actor.contaDaLoja?.uid) && actor.contaDaLoja.uid === actor.uid;
  return {
    tipo: ehContaDaLoja ? 'contaDaLoja' : 'funcionario',
    nome: usuario.nome || usuario.name || null,
    email: (ehContaDaLoja ? actor.contaDaLoja.email : null) || usuario.email || null,
    ...camposDoComputador(computador),
  };
}

// Cola B57-18l, item 2: o computador vem como texto (o nome dado) ou como { nome, automatico }
// (nomeDoComputadorNaLoja). computador: o nome dado, ou null; computadorAutomatico ("Windows 11 · Chrome"),
// so quando ha sessao. O web mostra o nome e, ao lado em cinza, o automatico.
export function camposDoComputador(computador) {
  const objeto = computador && typeof computador === 'object';
  const nome = String((objeto ? computador.nome : computador) ?? '').trim();
  const automatico = objeto ? String(computador.automatico ?? '').trim() : '';
  return { computador: nome || null, ...(automatico ? { computadorAutomatico: automatico } : {}) };
}

// O id da sessao vem do cabecalho X-Sessao (UUID do navegador). Outro formato nao vira caminho.
export function sessaoValida(sessaoId) {
  const valor = String(sessaoId || '').trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(valor) ? valor : null;
}
