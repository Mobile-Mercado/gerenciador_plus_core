import { AppError } from '../../domain/errors/AppError.js';
import {
  ROTULOS, SITUACOES, nomeDoArquivo, numeroDoPedido, podeReenviar, puladosPelaRegraDoNumero, situacaoDoRetorno,
} from '../../domain/retornoDav/situacaoDoRetorno.js';

// Itens 5.13 (aba "Retorno DAV" nos Logs do Gerenciador Web) e 4.21 (botao "Reenviar ao Linear"),
// aprovados pelo Thay em 23/11. A loja vem sempre da conta de quem chama (ou da loja alvo do admin).

export const PERIODO_PADRAO_DIAS = 30;
const DIA_MS = 86_400_000;
// O reenvio so vale para pedido pronto ha no maximo 30 dias. A regra do numero tambem acha pedidos
// antigos (Zero Grau: 323, 325, 327, 360, 362, 366 a 370, de abril a julho), os "10 provaveis
// antigos" do item 2.25, que o Thay decidiu nao tratar; eles aparecem como "Nao enviado", sem o botao.
export const REENVIO_ATE_DIAS = 30;

function rotuloDoPedido(dados, numero) {
  const doPedido = typeof dados.orderNumber === 'string' && dados.orderNumber.trim() ? dados.orderNumber.trim() : null;
  return doPedido || (numero ? String(numero).padStart(6, '0') : null);
}

function vendasComNumero(vendas) {
  return vendas.map((venda) => ({ ...venda, numero: numeroDoPedido(venda.dados?.numeroPedido) }));
}

export class RetornoDav {
  constructor({ repositorio, clock = () => new Date() }) {
    this.repositorio = repositorio;
    this.clock = clock;
  }

  linha(venda, contexto) {
    const { situacao, em, quem } = situacaoDoRetorno(venda, contexto);
    const recente = Boolean(venda.prontoEm) && contexto.agora - venda.prontoEm <= REENVIO_ATE_DIAS * DIA_MS;
    return {
      id: venda.id,
      pedido: rotuloDoPedido(venda.dados || {}, venda.numero),
      numero: venda.numero,
      prontoEm: venda.prontoEm ? venda.prontoEm.toISOString() : null,
      arquivo: nomeDoArquivo(venda.numero),
      situacao,
      rotulo: ROTULOS[situacao],
      em: em ? em.toISOString() : null,
      quem,
      podeReenviar: podeReenviar(situacao) && recente,
    };
  }

  // Uma linha por pedido pronto, do mais novo para o mais antigo. `dias` null: todos.
  async listar({ lojaId, dias = PERIODO_PADRAO_DIAS }) {
    const agora = this.clock();
    const vendas = vendasComNumero(await this.repositorio.listarVendas({ lojaId }));
    const pulados = puladosPelaRegraDoNumero(vendas);
    const desde = dias ? agora.getTime() - dias * DIA_MS : null;
    return vendas
      .filter((venda) => desde === null || (venda.prontoEm && venda.prontoEm.getTime() >= desde))
      .map((venda) => this.linha(venda, { pulados, agora }))
      .sort((a, b) => String(b.prontoEm).localeCompare(String(a.prontoEm)) || (b.numero ?? 0) - (a.numero ?? 0));
  }

  // 4.21: so na situacao "Nao enviado", uma vez so por pedido.
  async reenviar({ lojaId, vendaId, ator }) {
    if (typeof vendaId !== 'string' || !vendaId.trim() || vendaId.includes('/')) {
      throw new AppError('Pedido inválido.', { statusCode: 400, code: 'pedido_invalido' });
    }
    const agora = this.clock();
    const vendas = vendasComNumero(await this.repositorio.listarVendas({ lojaId }));
    const venda = vendas.find((item) => item.id === vendaId);
    if (!venda) throw new AppError('Pedido não encontrado.', { statusCode: 404, code: 'pedido_nao_encontrado' });
    const pulados = puladosPelaRegraDoNumero(vendas);
    const antes = this.linha(venda, { pulados, agora });
    const naoPode = (situacao) => (situacao === SITUACOES.REENVIO
      ? new AppError('O reenvio deste pedido já foi pedido.', { statusCode: 409, code: 'reenvio_ja_pedido' })
      : new AppError('Só pedido não enviado pode ser reenviado.', { statusCode: 409, code: 'reenvio_nao_permitido' }));
    if (!antes.podeReenviar) throw naoPode(antes.situacao);
    // Na transacao, com o documento lido de novo: dois cliques ao mesmo tempo reenviam uma vez so.
    const conferir = (dados) => {
      const agoraNaTransacao = this.linha({ ...venda, dados }, { pulados, agora });
      return agoraNaTransacao.podeReenviar ? null : naoPode(agoraNaTransacao.situacao);
    };
    const resultado = await this.repositorio.marcarReenvio({ lojaId, vendaId, ator, rotulo: antes.pedido ? `#${antes.pedido}` : vendaId, conferir });
    if (!resultado.existe) throw new AppError('Pedido não encontrado.', { statusCode: 404, code: 'pedido_nao_encontrado' });
    return {
      ...antes,
      situacao: SITUACOES.REENVIO,
      rotulo: ROTULOS.reenvio,
      em: agora.toISOString(),
      quem: ator.quem || null,
      podeReenviar: false,
    };
  }
}
