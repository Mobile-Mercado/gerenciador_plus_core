// Item 5.13 "Retorno DAV" (aprovado pelo Thay em 23/11; mockup mockup-retorno-dav-aprovado.html):
// situacao de cada pedido pronto para o caixa (estabelecimentos/{loja}/ReturnSales/{pedido}).
//
// Campos lidos (gravados pela nuvem do integrador, VendasGravadasServices.ts, e pelo reenvio do 4.21):
// - gravadoEm: o integrador confirmou o arquivo gravado (4.20) -> "Gravado na pasta".
// - reenvio { em, uid, quem }: reenvio pedido no Gerenciador Web, ainda sem gravadoEm -> "Reenvio pedido".
// - entregueSemConfirmacaoEm: saiu para um integrador sem confirmacao (1.0.36) -> "Entregue".
// - entregueEm: hora da entrega dos pedidos de antes da 4.20, preenchida pelo script
//   scripts/retornoDavHistorico.mjs a partir do registro da funcao -> "Entregue".
// - aguardaGravacao: true para os pedidos que nasceram com a 4.20 no ar e ainda nao foram gravados.
//
// Pedido de antes da 4.20 sem aguardaGravacao: o integrador antigo so buscava numero maior que o
// ultimo que ja tinha. Um pedido que ficou pronto quando ja havia, ha mais de 10 minutos, um pronto de
// numero maior nunca saiu (caso do 432 da Zero Grau, pronto em 17/11 depois do 434 de 16/11) ->
// "Nao enviado". Os outros sairam; a hora da entrega so existe com o entregueEm.

export const SITUACOES = Object.freeze({
  GRAVADO: 'gravado',
  REENVIO: 'reenvio',
  ENTREGUE: 'entregue',
  NAO_ENVIADO: 'nao_enviado',
  AGUARDANDO: 'aguardando',
});

export const ROTULOS = Object.freeze({
  gravado: 'Gravado na pasta',
  reenvio: 'Reenvio pedido',
  entregue: 'Entregue',
  nao_enviado: 'Não enviado',
  aguardando: 'Aguardando o integrador',
});

// Um pedido 4.20 que o integrador ainda nao gravou e normal por alguns minutos (o caixa busca a cada
// 5 min). Passado isto, conta como "Nao enviado" e o reenvio fica liberado.
export const ESPERA_DO_INTEGRADOR_MS = 30 * 60 * 1000;
// Folga para o pronto de numero maior ter saido antes do pedido ficar pronto (regra antiga).
export const FOLGA_DA_REGRA_DO_NUMERO_MS = 10 * 60 * 1000;

export function emData(valor) {
  const data = typeof valor?.toDate === 'function' ? valor.toDate() : valor;
  if (data instanceof Date) return Number.isNaN(data.getTime()) ? null : data;
  if (typeof valor === 'string' || typeof valor === 'number') {
    const convertida = new Date(valor);
    return Number.isNaN(convertida.getTime()) ? null : convertida;
  }
  return null;
}

export function numeroDoPedido(valor) {
  const numero = Number.parseInt(String(valor ?? '').replace(/^S/i, ''), 10);
  return Number.isSafeInteger(numero) && numero > 0 ? numero : null;
}

// Nome do arquivo que a nuvem manda ao integrador (VendasWebLinearServices.ts:568-572).
export function nomeDoArquivo(numero) {
  return numero ? `VENDAWEB_${numero}.xml` : null;
}

// Para a regra antiga: para cada pedido, se ja havia um pronto de numero maior, com folga.
export function puladosPelaRegraDoNumero(vendas) {
  const pulados = new Set();
  const ordenadas = vendas
    .filter((venda) => venda.numero && venda.prontoEm)
    .sort((a, b) => a.prontoEm - b.prontoEm);
  ordenadas.forEach((venda) => {
    const antesDele = ordenadas.some((outra) => outra !== venda
      && outra.numero > venda.numero
      && venda.prontoEm - outra.prontoEm >= FOLGA_DA_REGRA_DO_NUMERO_MS);
    if (antesDele) pulados.add(venda.id);
  });
  return pulados;
}

// { situacao, em, quem } de uma venda. `pulados` vem de puladosPelaRegraDoNumero (todas as vendas da loja).
export function situacaoDoRetorno(venda, { pulados = new Set(), agora = new Date() } = {}) {
  const dados = venda.dados || {};
  const gravado = emData(dados.gravadoEm);
  if (gravado) return { situacao: SITUACOES.GRAVADO, em: gravado, quem: null };
  const reenvio = dados.reenvio && emData(dados.reenvio.em);
  if (dados.reenvio) {
    return { situacao: SITUACOES.REENVIO, em: reenvio, quem: dados.reenvio.quem || null };
  }
  const entregueSem = emData(dados.entregueSemConfirmacaoEm);
  if (entregueSem) return { situacao: SITUACOES.ENTREGUE, em: entregueSem, quem: null };
  if (dados.aguardaGravacao === true) {
    const espera = venda.prontoEm ? agora - venda.prontoEm : Infinity;
    return espera < ESPERA_DO_INTEGRADOR_MS
      ? { situacao: SITUACOES.AGUARDANDO, em: null, quem: null }
      : { situacao: SITUACOES.NAO_ENVIADO, em: null, quem: null };
  }
  const entregue = emData(dados.entregueEm);
  if (entregue) return { situacao: SITUACOES.ENTREGUE, em: entregue, quem: null };
  if (dados.naoEnviado === true || pulados.has(venda.id)) return { situacao: SITUACOES.NAO_ENVIADO, em: null, quem: null };
  return { situacao: SITUACOES.ENTREGUE, em: null, quem: null };
}

export function podeReenviar(situacao) {
  return situacao === SITUACOES.NAO_ENVIADO;
}
