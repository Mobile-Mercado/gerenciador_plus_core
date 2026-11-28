// Motivos da separacao (cola do Thay B57-16, itens 9 a 12; proposta aprovada B57-16-11-proposta-motivos.md):
// estabelecimentos/{loja}/MotivosDaSeparacao, so o Core le e grava.
// - Os 8 padroes do item 10 ficam fixos aqui, com id fixo; a loja so ganha o documento de um padrao quando o
//   edita (texto, troca, remocao), apaga (apagado: true) ou usa (usos).
// - Os salvos (origem 'app' ou 'web') tem texto, troca, remocao, origem, salvoPor { id, nome }, salvoEm e usos.
// - Ordem por uso: mais usos primeiro; empate, os padroes na ordem do item 10 e, depois, os salvos, do mais novo
//   ao mais antigo.
// - O chip mostra 30 caracteres (como a pessoa ve; eram 24 ate a cola B57-16c) e "…" quando o texto passa disso.

export const COLECAO_DOS_MOTIVOS = 'MotivosDaSeparacao';
export const TAMANHO_DO_CHIP = 30;
export const TAMANHO_DO_TEXTO = 200;

export const MOTIVOS_PADRAO = Object.freeze([
  { id: 'padrao_produto_em_falta', texto: 'Produto em falta', troca: true, remocao: true },
  { id: 'padrao_sem_estoque_no_momento', texto: 'Sem estoque no momento', troca: true, remocao: true },
  { id: 'padrao_produto_com_avaria', texto: 'Produto com avaria', troca: true, remocao: true },
  { id: 'padrao_fora_da_validade', texto: 'Fora da validade', troca: true, remocao: true },
  { id: 'padrao_estamos_sem_opcao_equivalente', texto: 'Estamos sem opção equivalente', troca: true, remocao: true },
  { id: 'padrao_trocamos_por_um_similar', texto: 'Trocamos por um similar', troca: true, remocao: false },
  { id: 'padrao_marca_indisponivel_no_momento', texto: 'Marca indisponível no momento', troca: true, remocao: true },
  { id: 'padrao_tamanho_indisponivel', texto: 'Tamanho indisponível', troca: true, remocao: true },
].map((motivo) => Object.freeze(motivo)));

const PADRAO_POR_ID = new Map(MOTIVOS_PADRAO.map((motivo, ordem) => [motivo.id, { ...motivo, ordem }]));
export const ehPadrao = (id) => PADRAO_POR_ID.has(id);

const segmentador = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('pt-BR', { granularity: 'grapheme' }) : null;
const caracteres = (texto) => (segmentador ? [...segmentador.segment(texto)].map((parte) => parte.segment) : [...texto]);

export function limparTexto(texto) {
  return String(texto ?? '').replace(/\s+/g, ' ').trim();
}

export function chipDoMotivo(texto) {
  const partes = caracteres(limparTexto(texto));
  return partes.length > TAMANHO_DO_CHIP ? `${partes.slice(0, TAMANHO_DO_CHIP).join('')}…` : partes.join('');
}

// Mesmo motivo: sem diferenca de maiuscula, de espacos e do ponto final (o chip entra no campo com ponto).
export const chaveDoTexto = (texto) => limparTexto(texto).replace(/[.\s]+$/, '').toLowerCase();
export const mesmoMotivo = (a, b) => chaveDoTexto(a) === chaveDoTexto(b);

const emIso = (valor) => {
  if (!valor) return null;
  const data = typeof valor.toDate === 'function' ? valor.toDate() : new Date(valor);
  return Number.isNaN(data.getTime()) ? null : data.toISOString();
};
const emMs = (valor) => (emIso(valor) ? new Date(emIso(valor)).getTime() : 0);

// Um motivo para a resposta, a partir do padrao (se houver) e do documento da loja (se houver).
export function motivoParaResposta(id, dados = {}) {
  const padrao = PADRAO_POR_ID.get(id);
  const texto = limparTexto(dados.texto ?? padrao?.texto ?? '');
  return {
    id,
    texto,
    chip: chipDoMotivo(texto),
    troca: typeof dados.troca === 'boolean' ? dados.troca : padrao?.troca === true,
    remocao: typeof dados.remocao === 'boolean' ? dados.remocao : padrao?.remocao === true,
    origem: padrao ? 'padrao' : (dados.origem === 'app' ? 'app' : 'web'),
    salvoPor: padrao ? null : (dados.salvoPor ? { id: dados.salvoPor.id ?? null, nome: dados.salvoPor.nome ?? null } : null),
    salvoEm: padrao ? null : emIso(dados.salvoEm),
    usos: Number.isFinite(Number(dados.usos)) ? Number(dados.usos) : 0,
  };
}

// `documentos`: [{ id, dados }] da colecao da loja. Devolve os motivos da loja na ordem de uso.
export function montarLista(documentos = []) {
  const porId = new Map(documentos.map(({ id, dados }) => [id, dados || {}]));
  const padroes = MOTIVOS_PADRAO
    .filter((padrao) => porId.get(padrao.id)?.apagado !== true)
    .map((padrao) => motivoParaResposta(padrao.id, porId.get(padrao.id)));
  const salvos = documentos
    .filter(({ id, dados }) => !ehPadrao(id) && dados && dados.apagado !== true && limparTexto(dados.texto))
    .map(({ id, dados }) => ({ motivo: motivoParaResposta(id, dados), salvoEm: emMs(dados.salvoEm) }));
  const comOrdem = [
    ...padroes.map((motivo) => ({ motivo, grupo: 0, ordem: PADRAO_POR_ID.get(motivo.id).ordem })),
    ...salvos.map(({ motivo, salvoEm }) => ({ motivo, grupo: 1, ordem: -salvoEm })),
  ];
  return comOrdem
    .sort((a, b) => (b.motivo.usos - a.motivo.usos) || (a.grupo - b.grupo) || (a.ordem - b.ordem))
    .map(({ motivo }) => motivo);
}

export function filtrarPorTipo(motivos, tipo = 'todos') {
  if (tipo === 'troca') return motivos.filter((motivo) => motivo.troca);
  if (tipo === 'remocao') return motivos.filter((motivo) => motivo.remocao);
  return motivos;
}
