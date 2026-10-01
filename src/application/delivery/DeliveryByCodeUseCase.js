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
    const pedido = snapshot.data();
    const loja = await lerLoja(pedido, (referencia) => referencia.get());
    return resumoDoPedido(pedido, { gatewayEmProducao: emProducao(loja), loja });
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
      // Leitura antes de qualquer escrita, como a transacao exige.
      const loja = await lerLoja(pedido, (referencia) => transaction.get(referencia));
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
      return {
        pedido, entregador, ref: snapshot.ref, producao: emProducao(loja), loja,
      };
    });

    if (!resultado) throw linkInvalido();
    // Uma leitura a mais so para devolver a hora que o Firestore gravou: serverTimestamp
    // nao tem valor antes do commit, e a tela mostra essa hora, nao a do celular.
    const gravado = await resultado.ref.get();
    const deliveredAt = gravado.get('deliveredAt');
    return {
      ...resumoDoPedido(resultado.pedido, {
        gatewayEmProducao: resultado.producao,
        loja: resultado.loja,
      }),
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
// O ambiente do gateway mora no documento da loja, nao no pedido: gateway em
// homologacao aprova cartao de verdade, com codigo de autorizacao real. Custa uma
// leitura por chamada, e sao poucas entregas por dia.
async function lerLoja(pedido, ler) {
  const referencia = pedido?.companyReference;
  if (!referencia || typeof ler !== 'function') return null;
  try {
    const snapshot = await ler(referencia);
    return snapshot?.data ? snapshot.data() : null;
  } catch {
    // Loja ilegivel conta como fora de producao: na duvida, o entregador cobra.
    return null;
  }
}

// So 'prod' e sinonimos contam como producao. Qualquer outro valor, e a ausencia do
// ambiente numa loja que tem gateway, valem como ambiente de teste.
const AMBIENTES_DE_PRODUCAO = new Set(['prod', 'producao', 'production', 'live']);

function emProducao(loja) {
  const gateway = loja?.paymentGateway || {};
  const ambiente = gateway.safrapay?.environment
    ?? gateway.safrapay?.env
    ?? gateway.environment
    ?? gateway.env
    ?? loja?.safrapay?.environment;
  return AMBIENTES_DE_PRODUCAO.has(String(ambiente || '').trim().toLowerCase());
}

// O nome da loja no pedido e o nome no momento da compra, e por isso tem precedencia. Mas
// o app do cliente grava companyName vazio: os 255 pedidos da Zero Grau estao em branco.
// Nesse caso vale o nome do documento da loja, que a leitura do gateway ja trouxe.
function nomeDaLoja(pedido = {}, loja = null) {
  const doPedido = String(pedido.companyName || '').trim();
  if (doPedido) return doPedido;
  return String(
    loja?.fantasyName || loja?.name || loja?.corporateName || loja?.coorporativeName || '',
  ).trim();
}

function resumoDoPedido(pedido = {}, { gatewayEmProducao = false, loja = null } = {}) {
  const endereco = pedido.address || {};
  const pagamento = pedido.purchasePayment || {};
  const troco = Number(pagamento.valueBack || 0);
  return {
    pedido: pedido.orderNumber || '',
    loja: nomeDaLoja(pedido, loja),
    cliente: String(pedido.clientName || '').trim().split(/\s+/)[0] || '',
    telefone: pedido.clientePhoneNumber || '',
    endereco: enderecoEmUmaLinha(endereco),
    complemento: textoOuVazio(endereco.complement),
    referencia: textoOuVazio(endereco.reference),
    itens: Array.isArray(pedido.productsCart) ? pedido.productsCart.length : 0,
    total: Number(pedido.total || 0),
    pagamento: pagamento.paymentType || '',
    troco: troco > 0 ? troco : null,
    pagoOnline: pagamentoOnlineConfirmado(pedido, gatewayEmProducao),
  };
}

// Forma de pagamento nao diz se o dinheiro entrou: na Zero Grau, Pix e cartao sao
// cobrados na maquininha, na entrega. Quem diz e o registro da transacao.
//
// Todos os valores conferidos aqui sao TEXTO CRU DO PROVEDOR, nao do nosso dominio:
//   mode              'online' quando a cobranca foi feita pelo app; cobranca na
//                     maquininha nao tem esse valor.
//   paymentStatus     estado devolvido pela Safrapay e gravado pelo app do cliente em
//                     safrapay_payment_service.dart. 'paid' e o Pix confirmado;
//                     'paidAwaitingConfirmation' e o cartao aprovado que ainda espera a
//                     confirmacao do provedor; existe tambem no topo do pedido, em
//                     pedidos de um esquema mais antigo, e as duas posicoes valem.
//   responseCode      codigo de retorno da adquirente. '00' e aprovado.
//   authorizationCode codigo de autorizacao do cartao. 'HMLTEST' e o ambiente de
//                     homologacao da Safrapay: nunca conta como pagamento.
const STATUS_PAGO = 'paid';
const STATUS_CARTAO_APROVADO = 'paidawaitingconfirmation';
const STATUS_NUNCA_PAGO = new Set(['canceled', 'pendingcancel', 'waitingforpayment']);
const RESPOSTA_APROVADA = '00';
const AUTORIZACAO_DE_HOMOLOGACAO = 'HMLTEST';

function pagamentoOnlineConfirmado(pedido = {}, gatewayEmProducao = false) {
  // Gateway fora de producao nao prova pagamento nenhum, mesmo com autorizacao real.
  if (!gatewayEmProducao) return false;
  const pagamento = pedido.purchasePayment || {};
  if (String(pagamento.mode || '').trim().toLowerCase() !== 'online') return false;

  const autorizacao = String(pagamento.authorizationCode || '').trim();
  if (autorizacao.toUpperCase() === AUTORIZACAO_DE_HOMOLOGACAO) return false;

  const situacao = String(pagamento.paymentStatus || pedido.paymentStatus || '')
    .trim()
    .toLowerCase();
  if (STATUS_NUNCA_PAGO.has(situacao)) return false;
  if (situacao === STATUS_PAGO) return true;

  return situacao === STATUS_CARTAO_APROVADO
    && String(pagamento.responseCode || '').trim() === RESPOSTA_APROVADA
    && autorizacao !== '';
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
