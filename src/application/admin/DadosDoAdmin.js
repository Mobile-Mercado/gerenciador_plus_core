import { Timestamp } from 'firebase-admin/firestore';

// Painel de Experiencia dentro do Admin (rodada de 13/10/2026), lendo pelo Core. As mesmas leituras
// que o public/painel_experiencia faz direto no Firestore (pedidos do periodo mais 180 dias de
// contexto, conversas com a loja e com o agente, nomes das lojas), ja no formato que as contas do
// painel usam. Filtro de loja opcional; sem ele, todas as lojas.
const LOOKBACK_DAYS = 180;
const PERIODOS = new Set([7, 30, 90, 180, 365]);

const limparStatus = (valor) => String(valor || '').replace('PurchaseStatus.', '');

function paraData(valor) {
  if (!valor) return null;
  if (typeof valor.toDate === 'function') return valor.toDate();
  if (valor instanceof Date) return valor;
  const data = new Date(valor);
  return Number.isNaN(data.getTime()) ? null : data;
}

const iso = (valor) => paraData(valor)?.toISOString() || null;

export function pedidoDoPainel(documento) {
  const x = documento.data() || {};
  const statusList = (x.statusList || [])
    .map((s) => ({ s: limparStatus(s.purchaseStatus || s.status), t: iso(s.createdAt) }))
    .filter((s) => s.t);
  const primeiro = (nome) => statusList.find((s) => s.s === nome)?.t || null;
  return {
    id: documento.id,
    created: iso(x.createdAt) || primeiro('pending'),
    orderNumber: x.orderNumber || '',
    company: x.companyReference?.id || 'sem-loja',
    companyName: x.companyName || x.companyReference?.id || 'Sem nome',
    clientId: x.clientId || x.clientReference?.id || '',
    clientName: x.clientName || 'Sem nome',
    clientPhone: x.clientePhoneNumber || x.clientPhoneNumber || '',
    status: limparStatus(x.currentPurchaseStatus || x.purchaseStatus || x.status),
    total: Number(x.total) || 0,
    agent: x.origem === 'agente_ia' || x.agentOrder === true,
    cancelReason: String(x.cancelReason || '').trim(),
    stars: x.review && Number.isFinite(Number(x.review.stars)) ? Number(x.review.stars) : null,
    reviewComment: x.review?.comment || '',
    payment: x.purchasePayment?.paymentType ? limparStatus(String(x.purchasePayment.paymentType).replace('PaymentType.', '')) : '',
    tAccepted: primeiro('accepted'),
    tSep: primeiro('separatingOrder'),
    tWait: primeiro('waitingForDelivery'),
    tRoute: primeiro('deliveryRoute'),
    tDone: primeiro('completed') || primeiro('deliveryConfirmed'),
    statusList,
  };
}

export class DadosDoAdmin {
  constructor({ firestore, clock = () => Date.now() }) {
    this.firestore = firestore;
    this.clock = clock;
  }

  async experiencia({ dias = 90, lojaId = '' } = {}) {
    const periodo = PERIODOS.has(Number(dias)) ? Number(dias) : 90;
    const inicio = new Date(this.clock());
    inicio.setDate(inicio.getDate() - periodo);
    inicio.setHours(0, 0, 0, 0);
    const desde = new Date(inicio);
    desde.setDate(desde.getDate() - LOOKBACK_DAYS);
    const marco = Timestamp.fromDate(desde);

    let pedidosQuery = this.firestore.collection('PurchaseRequests').where('createdAt', '>=', marco);
    if (lojaId) pedidosQuery = pedidosQuery.where('companyReference', '==', this.firestore.collection('estabelecimentos').doc(lojaId));
    const [pedidos, chats, agente] = await Promise.all([
      pedidosQuery.get(),
      this.firestore.collection('Chats').where('createdAt', '>=', marco).get().catch(() => ({ docs: [] })),
      this.firestore.collectionGroup('conversas').get().catch(() => ({ docs: [] })),
    ]);
    const listaPedidos = pedidos.docs.map(pedidoDoPainel).filter((pedido) => pedido.created);
    const ids = [...new Set(listaPedidos.map((pedido) => pedido.company))].filter((id) => id && id !== 'sem-loja');
    const lojas = {};
    const documentos = ids.length
      ? await this.firestore.getAll(...ids.map((id) => this.firestore.collection('estabelecimentos').doc(id)))
      : [];
    documentos.forEach((documento) => {
      const x = documento.data() || {};
      lojas[documento.id] = x.name || x.nome || x.nomeEstabelecimento || x.fantasyName || x.razaoSocial || documento.id;
    });
    return {
      periodo,
      inicio: inicio.toISOString(),
      lojaId: lojaId || null,
      pedidos: listaPedidos,
      chats: chats.docs.map((documento) => {
        const x = documento.data() || {};
        return {
          id: documento.id,
          created: iso(x.createdAt),
          updated: iso(x.updatedAt),
          senderId: x.senderId || '',
          receiverId: x.receiverId || '',
          senderName: x.senderName || '',
          receiverName: x.receiverName || '',
          last: String(x.lastMessage?.mensage || '').slice(0, 200),
          purchaseId: x.purchaseReference?.id || '',
        };
      }).filter((conversa) => conversa.created),
      agente: agente.docs
        .map((documento) => {
          const x = documento.data() || {};
          return {
            id: documento.id,
            userId: x.userId || '',
            companyId: x.companyId || '',
            created: iso(x.createdAt) || iso(x.updatedAt),
            updated: iso(x.updatedAt),
            messages: Number(x.totalMensagens) || 0,
            orderId: x.pedidoId || '',
            orderTotal: Number(x.pedidoTotal) || 0,
          };
        })
        .filter((conversa) => conversa.userId && conversa.created && conversa.created >= desde.toISOString())
        .filter((conversa) => !lojaId || conversa.companyId === lojaId),
      lojas,
    };
  }

  // Carrinho atual de uma pessoa numa loja (linha do tempo do painel): so a quantidade de itens.
  async carrinho(uid, lojaId) {
    const itens = await this.firestore.collection('Users').doc(String(uid)).collection('ShoppingCart')
      .doc(String(lojaId)).collection('Items').count().get();
    return { itens: Number(itens.data()?.count) || 0 };
  }
}
