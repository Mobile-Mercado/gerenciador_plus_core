// Cola do Thay B57-13, item 28: autor das acoes do painel no Log da equipe
// (estabelecimentos/{loja}/AcoesEquipe). O Core grava o campo `autor` em cada acao que o painel
// grava pelo proxy de dados, no lugar do que vier no corpo:
//   { tipo: 'contaDaLoja' | 'funcionario', nome, email, computador }
// - contaDaLoja: a conta principal da loja, a do Users para o qual estabelecimentos/{loja}.userReference
//   aponta (criada no cadastro da loja). O web mostra o e-mail.
// - funcionario: o login criado em "Novo funcionario" (AdminUsers). O web mostra o nome.
// - computador: o nome dado ao navegador em "Acessos conectados" (SessoesWeb/{X-Sessao}.nome), ou null
//   (o web mostra "Navegador sem nome").
// O admin da plataforma agindo na loja (X-Loja-Alvo) fica sem autor: o web mostra o `quem` gravado.

export const ACOES_DA_EQUIPE = 'AcoesEquipe';

export function ehAcaoDaEquipe(path, establishmentId) {
  const partes = String(path || '').split('/');
  return partes.length === 4
    && partes[0] === 'estabelecimentos'
    && Boolean(establishmentId)
    && partes[1] === establishmentId
    && partes[2] === ACOES_DA_EQUIPE;
}

export function autorDaAcao(actor, computador) {
  if (!actor || actor.porAdminDaPlataforma) return null;
  const usuario = actor.userDocument || {};
  const ehContaDaLoja = Boolean(actor.contaDaLoja?.uid) && actor.contaDaLoja.uid === actor.uid;
  const nomeDoComputador = String(computador ?? '').trim();
  return {
    tipo: ehContaDaLoja ? 'contaDaLoja' : 'funcionario',
    nome: usuario.nome || usuario.name || null,
    email: (ehContaDaLoja ? actor.contaDaLoja.email : null) || usuario.email || null,
    computador: nomeDoComputador || null,
  };
}

// O id da sessao vem do cabecalho X-Sessao (UUID do navegador). Outro formato nao vira caminho.
export function sessaoValida(sessaoId) {
  const valor = String(sessaoId || '').trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(valor) ? valor : null;
}
