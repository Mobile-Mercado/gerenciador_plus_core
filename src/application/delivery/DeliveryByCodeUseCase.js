import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { AppError } from '../../domain/errors/AppError.js';

// Unica escrita em PurchaseRequests fora da ManagerDataAccessPolicy: a pagina do
// entregador nao tem login, entao a autorizacao e o proprio deliveryCode. Por isso a
// lista de campos abaixo e fechada aqui dentro e nada do corpo da requisicao chega ao
// Firestore.
const CAMPOS_PERMITIDOS = new Set([
  'currentPurchaseStatus',
  'statusList',
  'deliveredBy',
  'deliveredAt',
  'deliveredSource',
]);

const STATUS_EM_ROTA = 'PurchaseStatus.deliveryRoute';
const STATUS_ENTREGUE = 'PurchaseStatus.completed';
const ORIGEM = 'entregador_link';
const CODIGO_VALIDO = /^[A-Za-z0-9-]{4,32}$/;

export class DeliveryByCodeUseCase {
  constructor({ firestore, clock = () => new Date() }) {
    this.firestore = firestore;
    this.clock = clock;
  }

  // Codigo inexistente, pedido inexistente, pedido em outro status e codigo repetido
  // respondem a mesma coisa: o link nao serve de sonda para descobrir pedido.
  async summary(codigo) {
    const snapshot = await this.findOrder(codigo);
    return resumoDoPedido(snapshot.data());
  }

  // Transacao: duas marcacoes seguidas com o mesmo codigo nao passam as duas, porque a
  // segunda ja encontra o pedido fora de rota.
  async confirm(codigo) {
    const consulta = this.query(codigo);
    const resultado = await this.firestore.runTransaction(async (transaction) => {
      const encontrados = await transaction.get(consulta);
      const snapshot = umPedidoEmRota(encontrados);
      if (!snapshot) return null;

      const pedido = snapshot.data();
      const entregador = String(pedido.deliveryPerson?.name || '').trim();
      const alteracao = {
        currentPurchaseStatus: STATUS_ENTREGUE,
        statusList: [
          ...(Array.isArray(pedido.statusList) ? pedido.statusList : []),
          { purchaseStatus: STATUS_ENTREGUE, createdAt: Timestamp.fromDate(this.clock()) },
        ],
        deliveredBy: entregador,
        deliveredAt: FieldValue.serverTimestamp(),
        deliveredSource: ORIGEM,
      };
      assertCamposPermitidos(alteracao);
      transaction.update(snapshot.ref, alteracao);
      return { pedido, entregador, ref: snapshot.ref };
    });

    if (!resultado) throw linkInvalido();
    // Uma leitura a mais so para devolver a hora que o Firestore gravou: serverTimestamp
    // nao tem valor antes do commit, e a tela mostra essa hora, nao a do celular.
    const gravado = await resultado.ref.get();
    const deliveredAt = gravado.get('deliveredAt');
    return {
      ...resumoDoPedido(resultado.pedido),
      status: 'entregue',
      marcadoPor: resultado.entregador,
      origem: ORIGEM,
      deliveredAt: deliveredAt?.toDate ? deliveredAt.toDate().toISOString() : null,
    };
  }

  query(codigo) {
    const limpo = String(codigo || '').trim();
    if (!CODIGO_VALIDO.test(limpo)) throw linkInvalido();
    return this.firestore
      .collection('PurchaseRequests')
      .where('deliveryCode', '==', limpo)
      .limit(2);
  }

  async findOrder(codigo) {
    const snapshot = umPedidoEmRota(await this.query(codigo).get());
    if (!snapshot) throw linkInvalido();
    return snapshot;
  }
}

// Vale so um pedido, e so enquanto ele esta em rota de entrega. Codigo repetido em
// dois pedidos nao vale para nenhum.
function umPedidoEmRota(resultado) {
  const documentos = resultado?.docs || [];
  if (documentos.length !== 1) return null;
  const [snapshot] = documentos;
  return snapshot.get('currentPurchaseStatus') === STATUS_EM_ROTA ? snapshot : null;
}

// So o que a tela do entregador precisa. Nada de id de cliente, e-mail ou lista de
// produtos.
function resumoDoPedido(pedido = {}) {
  const endereco = pedido.address || {};
  const pagamento = pedido.purchasePayment || {};
  const troco = Number(pagamento.valueBack || 0);
  return {
    pedido: pedido.orderNumber || '',
    loja: pedido.companyName || '',
    cliente: String(pedido.clientName || '').trim().split(/\s+/)[0] || '',
    telefone: pedido.clientePhoneNumber || '',
    endereco: enderecoEmUmaLinha(endereco),
    complemento: textoOuVazio(endereco.complement),
    referencia: textoOuVazio(endereco.reference),
    itens: Array.isArray(pedido.productsCart) ? pedido.productsCart.length : 0,
    total: Number(pedido.total || 0),
    pagamento: pagamento.paymentType || '',
    troco: troco > 0 ? troco : null,
    pagoOnline: pagamentoOnlineConfirmado(pedido),
  };
}

// Forma de pagamento nao diz se o dinheiro entrou: na Zero Grau, Pix e cartao sao
// cobrados na maquininha, na entrega. Quem diz e o registro da transacao, que vive em
// dois lugares no pedido: paymentStatus no topo e purchasePayment.paymentStatus.
// So 'paid' conta como confirmado; 'paidAwaitingConfirmation' nao, porque ainda espera
// o provedor.
function pagamentoOnlineConfirmado(pedido = {}) {
  const situacoes = [pedido.paymentStatus, pedido.purchasePayment?.paymentStatus]
    .map((valor) => String(valor || '').trim().toLowerCase());
  return situacoes.includes('paid');
}

function enderecoEmUmaLinha(endereco) {
  if (endereco.fullAddress) return String(endereco.fullAddress);
  return [
    [endereco.street, endereco.number].filter(Boolean).join(', '),
    endereco.neighborhood,
    [endereco.city, endereco.uf].filter(Boolean).join('/'),
  ].filter(Boolean).join(' - ');
}

function textoOuVazio(valor) {
  return typeof valor === 'string' ? valor : '';
}

function assertCamposPermitidos(alteracao) {
  const proibido = Object.keys(alteracao).find((campo) => !CAMPOS_PERMITIDOS.has(campo));
  if (proibido) {
    throw new AppError('Campo nao permitido nesta rota.', {
      statusCode: 500,
      code: 'entrega_campo_nao_permitido',
    });
  }
}

// Mesma resposta para todos os motivos, de proposito.
function linkInvalido() {
  return new AppError('Este link nao esta mais valido.', {
    statusCode: 404,
    code: 'entrega_link_invalido',
  });
}

export const CAMPOS_DE_ESCRITA = CAMPOS_PERMITIDOS;
export const STATUS_DE_ROTA = STATUS_EM_ROTA;
export const STATUS_DE_ENTREGA = STATUS_ENTREGUE;
