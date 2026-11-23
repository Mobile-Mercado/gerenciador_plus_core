import { FieldValue } from 'firebase-admin/firestore';

// Itens 5.13 e 4.21: leitura dos pedidos prontos para o caixa (estabelecimentos/{loja}/ReturnSales)
// e o reenvio ao Linear. So os campos da situacao saem do banco (select): a venda tem dado do cliente.
export const RETURN_SALES = 'ReturnSales';
export const ACOES_EQUIPE = 'AcoesEquipe';
const CAMPOS = [
  'numeroPedido', 'orderNumber', 'purchaseReference', 'aguardaGravacao', 'gravadoEm', 'entregueSemConfirmacaoEm',
  'entregueEm', 'naoEnviado', 'reenvio', 'lancadoAMao', 'updatedAt',
];

function emData(valor) {
  const data = typeof valor?.toDate === 'function' ? valor.toDate() : valor;
  return data instanceof Date && !Number.isNaN(data.getTime()) ? data : null;
}

export class FirestoreRetornoDavRepository {
  constructor({ firestore, serverTimestamp = () => FieldValue.serverTimestamp() }) {
    this.firestore = firestore;
    this.serverTimestamp = serverTimestamp;
  }

  loja(lojaId) {
    return this.firestore.collection('estabelecimentos').doc(lojaId);
  }

  // Todas as vendas prontas da loja (a regra do numero precisa de todas). "Pronto" = criacao do
  // documento; sem ela (teste), updatedAt.
  async listarVendas({ lojaId }) {
    const lidos = await this.loja(lojaId).collection(RETURN_SALES).select(...CAMPOS).get();
    return lidos.docs.map((doc) => {
      const dados = doc.data() || {};
      return { id: doc.id, dados, prontoEm: emData(doc.createTime) || emData(dados.updatedAt) };
    });
  }

  // 4.21: marca para a proxima busca do integrador (4.20: aguardaGravacao sai em qualquer numero),
  // em transacao. `conferir(dados)` devolve o erro quando o pedido nao pode ser reenviado (ja pedido,
  // ja gravado ou entregue). Registra no Log da equipe com quem e quando.
  async marcarReenvio({ lojaId, vendaId, ator, rotulo, conferir }) {
    const ref = this.loja(lojaId).collection(RETURN_SALES).doc(vendaId);
    const acao = this.loja(lojaId).collection(ACOES_EQUIPE).doc();
    return this.firestore.runTransaction(async (transacao) => {
      const atual = await transacao.get(ref);
      if (!atual.exists) return { existe: false };
      const erro = conferir(atual.data() || {});
      if (erro) throw erro;
      const quando = this.serverTimestamp();
      transacao.update(ref, {
        aguardaGravacao: true,
        buscadoPor: FieldValue.delete(),
        reenvio: { em: quando, uid: ator.uid || null, quem: ator.quem || null, porAdmin: ator.porAdmin === true },
      });
      transacao.set(acao, {
        em: quando,
        quem: ator.email || ator.quem || ator.uid || '',
        tela: 'logs',
        acao: 'reenviar_ao_linear',
        alvo: { tipo: 'pedido', id: vendaId, rotulo },
        antes: { situacao: 'Não enviado' },
        depois: { situacao: 'Reenvio pedido' },
        origem: ator.porAdmin ? 'admin' : 'manual',
      });
      return { existe: true };
    });
  }

  // 5.14: "Ja lancado no Linear". Em transacao; gravadoEm junto, para a nuvem nunca mais entregar o
  // pedido (foiGravada). Registra no Log da equipe com quem e quando.
  async marcarLancado({ lojaId, vendaId, ator, rotulo, conferir }) {
    const ref = this.loja(lojaId).collection(RETURN_SALES).doc(vendaId);
    const acao = this.loja(lojaId).collection(ACOES_EQUIPE).doc();
    return this.firestore.runTransaction(async (transacao) => {
      const atual = await transacao.get(ref);
      if (!atual.exists) return { existe: false };
      const erro = conferir(atual.data() || {});
      if (erro) throw erro;
      const quando = this.serverTimestamp();
      transacao.update(ref, {
        aguardaGravacao: false,
        gravadoEm: quando,
        buscadoPor: FieldValue.delete(),
        lancadoAMao: { em: quando, uid: ator.uid || null, quem: ator.quem || null, porAdmin: ator.porAdmin === true },
      });
      transacao.set(acao, {
        em: quando,
        quem: ator.email || ator.quem || ator.uid || '',
        tela: 'logs',
        acao: 'lancado_no_linear',
        alvo: { tipo: 'pedido', id: vendaId, rotulo },
        antes: { situacao: 'Não enviado' },
        depois: { situacao: 'Lançado à mão' },
        origem: ator.porAdmin ? 'admin' : 'manual',
      });
      return { existe: true };
    });
  }
}
