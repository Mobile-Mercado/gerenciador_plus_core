import { AppError } from '../errors/AppError.js';

// Cola do Thay B57-13t, item 38 (k): colecao "Sugestões de revisão" por loja, sem mexer no documento do
// produto: estabelecimentos/{loja}/SugestoesDeRevisao/{tipo}_{produtoId}. Na revisao de unidade:
//   { tipo: 'unidade', produtoId, sugestao: 'kg' | 'un', duvida, ... }   (carga feita por script)
// A tela "Revisar unidade" grava, ao conferir a linha, so o resultado:
//   { resultado, unidadeConferida }   e o Core poe conferidoEm (hora do servidor) e conferidoPor (o autor,
//   no formato do Log da equipe).
// So quem edita produto (products.edit) grava, so na propria loja, so esses campos e sempre por mescla.
export const SUGESTOES_DE_REVISAO = 'SugestoesDeRevisao';

export const RESULTADOS_DA_CONFERENCIA = Object.freeze([
  'aceitou a sugestão',
  'escolheu outra unidade',
  'manteve a unidade, contra a sugestão',
]);

const CAMPOS_DO_PAINEL = new Set(['resultado', 'unidadeConferida', 'conferidoEm', 'conferidoPor']);

export function ehSugestaoDeRevisao(path, establishmentId) {
  const partes = String(path || '').split('/');
  return partes.length === 4
    && partes[0] === 'estabelecimentos'
    && Boolean(establishmentId)
    && partes[1] === establishmentId
    && partes[2] === SUGESTOES_DE_REVISAO
    && /^[A-Za-z0-9_-]{1,200}$/.test(partes[3]);
}

const recusa = (mensagem) => new AppError(mensagem, { statusCode: 400, code: 'sugestao_de_revisao_invalida' });

// O que o painel pode gravar: resultado (um dos tres, ou null sem sugestao) e a unidade conferida.
export function resultadoDoPainel(data = {}) {
  const resultado = data.resultado ?? null;
  if (resultado !== null && !RESULTADOS_DA_CONFERENCIA.includes(resultado)) throw recusa('Resultado da conferência inválido.');
  const unidade = data.unidadeConferida;
  if (typeof unidade !== 'string' || !unidade.trim() || unidade.length > 60) throw recusa('Unidade conferida inválida.');
  const fora = Object.keys(data).filter((campo) => !CAMPOS_DO_PAINEL.has(campo) && campo !== 'sugestao' && campo !== 'tipo');
  if (fora.length) throw recusa('A alteração contém campos não permitidos.');
  return { resultado, unidadeConferida: unidade.trim() };
}
