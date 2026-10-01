import { FieldValue } from 'firebase-admin/firestore';
import { AppError } from '../../domain/errors/AppError.js';
import { assertPermission } from '../../http/middlewares/requirePermission.js';
// Lista de clientes gravada pela rotina noturna. Mesmo arquivo que a rotina usa, para a
// regra de quem e cliente nao existir em duas versoes.
import clientesDaLoja from '../../../functions/clientesDaLoja.js';

const { acrescentarClientes, clientesDosPedidos, lerListaDeClientes } = clientesDaLoja;

// Trinta minutos: a lista de clientes so cresce, entao cache velho nao erra, so fica
// incompleto, e o incompleto e resolvido pela verificacao pontual de isCustomer.
const CUSTOMER_CACHE_TTL_MS = 30 * 60 * 1000;
// Teto da verificacao pontual: uma varredura por loja a cada dez minutos. Sem ele, uma
// sequencia de ids invalidos viraria uma varredura por chamada.
const VERIFICATION_TTL_MS = 10 * 60 * 1000;
// Status que contam como cancelamento do pedido: exigem requests.cancel.
const CANCEL_STATUSES = new Set(['canceled', 'cancelled', 'cancelado', 'denied', 'giveUp']);
const PRICE_FIELDS = new Set(['price', 'promotionPrice', 'historyPrice', 'previewPrice']);
const PRODUCT_EDIT_COLLECTIONS = new Set(['implantacaoGrenciador', 'ProductCategories', 'ProductSubcategories']);
const COUPON_COLLECTIONS = new Set(['Cupons', 'Campaigns']);
const ALLOWED_AUTOMATIONS = new Set([
  'padronizador_nomes',
  'taggeador',
  'defenir_catsub',
]);
const ORDER_UPDATE_FIELDS = new Set([
  'currentPurchaseStatus',
  'statusList',
  'separatedAt',
  'separationChecklist',
  'deliveryPerson',
  // Codigo do link do entregador: o painel grava junto com o deliveryPerson, na mesma
  // escrita da atribuicao, e e a chave que a rota /api/entrega confere.
  'deliveryCode',
  'isTest',
  'isTestAccount',
]);
const USER_UPDATE_FIELDS = new Set(['segmento', 'isTestAccount']);
const BOOLEAN_MUTATION_FIELDS = new Set(['isTest', 'isTestAccount']);
const CHAT_UPDATE_FIELDS = new Set(['lastMessage', 'updatedAt']);
const SAFE_USER_FIELDS = new Set([
  'id',
  'name',
  'nome',
  'email',
  'phone',
  'telefone',
  'image',
  'segmento',
  'isTestAccount',
  // Como a pessoa entrou na conta, gravado pela syncLoginProvidersNightly. Leitura so.
  'provedoresDeLogin',
  'createAt',
  'createdAt',
  'birthDate',
  'birthday',
  'dateOfBirth',
  'dataNascimento',
  'deliveryAddressSelected',
]);

// Chave de permissao de cada escrita do proxy. Leitura nao e barrada nesta rodada.
export function permissionKeyForMutation(mutation, establishmentId) {
  const parts = pathParts(mutation?.target?.path || '');
  const data = mutation?.data && typeof mutation.data === 'object' ? mutation.data : {};
  const criando = mutation?.operation === 'set' && mutation?.options?.merge !== true;

  if (parts[0] === 'PurchaseRequests') {
    const status = String(data.currentPurchaseStatus || '').replace('PurchaseStatus.', '');
    return CANCEL_STATUSES.has(status) ? 'requests.cancel' : 'requests.update_status';
  }
  if (parts[0] === 'Users') return 'requests.update_status';
  if (parts[0] === 'Chats') return 'chat.send';
  if (parts[0] === 'AgenteVendas') return 'chat.send';

  if (parts[0] === 'estabelecimentos' && parts[1] === establishmentId) {
    const colecao = parts[2];
    // Documento da loja: campos da loja e ajustes.
    if (!colecao) return 'settings.edit';
    if (colecao === 'Products') {
      if (mutation.operation === 'delete') return 'products.delete';
      if (criando) return 'products.create';
      if (Object.keys(data).some((campo) => PRICE_FIELDS.has(campo))) return 'products.edit_price';
      if (data.isTrashed === true) return 'products.delete';
      return 'products.edit';
    }
    if (PRODUCT_EDIT_COLLECTIONS.has(colecao)) return 'products.edit';
    if (COUPON_COLLECTIONS.has(colecao)) return 'coupons.manage';
    // deliveryMenList, paymentMethods e as demais subcolecoes de ajustes.
    return 'settings.edit';
  }

  return 'settings.edit';
}

export class ManagerDataAccessPolicy {
  constructor({
    firestore,
    clock = () => Date.now(),
    // Injetavel para o teste conferir quais ids sao acrescentados: a sentinela do
    // FieldValue nao mostra o conteudo.
    arrayUnion = (valores) => FieldValue.arrayUnion(...valores),
  }) {
    this.firestore = firestore;
    this.clock = clock;
    this.customerCache = new Map();
    this.conversationCache = new Map();
    this.arrayUnion = arrayUnion;
  }

  assertActor(actor) {
    if (!actor?.uid || !actor?.establishmentId || !actor?.hasEstablishment) {
      throw forbidden('Conta sem estabelecimento ativo.', 'data_establishment_required');
    }
  }

  async assertRead({ actor, target }) {
    this.assertActor(actor);

    const base = targetBase(target);
    if (base?.kind === 'collectionGroup') {
      if (base.id === 'conversas') return;
      throw forbidden();
    }

    const path = sourcePath(target);
    if (!path) throw invalidTarget();
    if (isOwnEstablishmentPath(path, actor.establishmentId)) return;
    if (isAllowedAutomation(path)) return;
    if (isSearchTermsPath(path, actor.establishmentId)) return;

    const [root] = pathParts(path);
    if (root === 'PurchaseRequests') {
      if (pathParts(path).length > 1) await this.assertOrderDocument(actor, path);
      return;
    }
    if (root === 'Users') {
      await this.assertUserPath(actor, path);
      return;
    }
    if (root === 'Chats') {
      await this.assertChatTarget(actor, target, path);
      return;
    }
    if (isAgentConversationPath(path)) {
      await this.assertAgentConversation(actor, path);
      return;
    }

    throw forbidden();
  }

  async assertMutation({ actor, mutation }) {
    this.assertActor(actor);
    const path = mutation?.target?.path;
    if (!path) throw invalidTarget();

    // Barreira por chave. Ator sem `permissions` e o dono, que passa em tudo.
    assertPermission(
      actor.permissions || { isAdmin: true, groupId: null, keys: [] },
      permissionKeyForMutation(mutation, actor.establishmentId),
    );

    if (isOwnEstablishmentPath(path, actor.establishmentId)) return;

    const [root] = pathParts(path);
    if (root === 'PurchaseRequests') {
      if (mutation.operation !== 'update') throw forbidden();
      await this.assertOrderDocument(actor, path);
      assertOnlyFields(mutation.data, ORDER_UPDATE_FIELDS, 'data_order_fields_forbidden');
      assertBooleanFields(mutation.data, 'data_order_fields_forbidden');
      return;
    }

    if (root === 'Users') {
      if (mutation.operation !== 'update') throw forbidden();
      await this.assertUserPath(actor, path);
      assertOnlyFields(mutation.data, USER_UPDATE_FIELDS, 'data_user_fields_forbidden');
      assertBooleanFields(mutation.data, 'data_user_fields_forbidden');
      return;
    }

    if (root === 'Chats') {
      await this.assertChatMutation(actor, mutation, path);
      return;
    }

    if (isAgentConversationPath(path)) {
      await this.assertAgentMutation(actor, mutation, path);
      return;
    }

    throw forbidden();
  }

  async scopeQuery({ actor, target, queryReference }) {
    const path = sourcePath(target);
    const [root] = pathParts(path);

    if (root === 'PurchaseRequests' && !hasWhere(target, 'companyReference', actor.establishmentId)) {
      return queryReference.where(
        'companyReference',
        '==',
        this.firestore.collection('estabelecimentos').doc(actor.establishmentId),
      );
    }

    if (targetBase(target)?.kind === 'collectionGroup'
      && targetBase(target)?.id === 'conversas'
      && !hasWhere(target, 'companyId', actor.establishmentId)) {
      return queryReference.where('companyId', '==', actor.establishmentId);
    }

    return queryReference;
  }

  async filterDocuments({ actor, target, documents }) {
    const path = sourcePath(target);
    const [root] = pathParts(path);

    // Cliente da loja, participante de conversa com ela, ou o proprio dono. Quem so
    // conversou volta com os mesmos campos de sempre: a peneira do sanitizeDocument nao
    // muda.
    if (root === 'Users' && pathParts(path).length === 1) {
      const legiveis = await this.getReadableUserIds(actor);
      return documents.filter((document) => (
        document.id === actor.userId || legiveis.has(document.id)
      ));
    }

    if (root === 'PurchaseRequests') {
      this.rememberCustomersFromOrders(actor, documents, isCompleteOrderScope(target));
    }

    return documents;
  }

  sanitizeDocument(path, data) {
    const parts = pathParts(path);
    if (parts[0] !== 'Users' || parts.length !== 2) return data;

    return Object.fromEntries(
      Object.entries(data || {}).filter(([key]) => SAFE_USER_FIELDS.has(key)),
    );
  }

  async assertOrderDocument(actor, path) {
    const snapshot = await this.firestore.doc(path).get();
    if (!snapshot.exists || establishmentIdFromOrder(snapshot.data()) !== actor.establishmentId) {
      throw forbidden('Pedido nao pertence ao estabelecimento autenticado.');
    }
  }

  async assertUserPath(actor, path) {
    const parts = pathParts(path);
    if (parts.length === 1) return;

    const userId = parts[1];
    if (userId === actor.userId) return;
    if (!(await this.isCustomer(actor, userId))) {
      throw forbidden('Cliente nao pertence ao estabelecimento autenticado.');
    }
  }

  async assertChatTarget(actor, target, path) {
    const parts = pathParts(path);
    if (parts.length === 1) {
      if (!hasChatOwnershipFilter(target, actor.establishmentId)) throw forbidden();
      return;
    }
    await this.assertChatDocument(actor, parts[1]);
  }

  async assertChatDocument(actor, chatId) {
    const snapshot = await this.firestore.collection('Chats').doc(chatId).get();
    if (!snapshot.exists || !chatBelongsTo(snapshot.data(), actor.establishmentId)) {
      throw forbidden('Conversa nao pertence ao estabelecimento autenticado.');
    }
    return snapshot.data();
  }

  async assertChatMutation(actor, mutation, path) {
    const parts = pathParts(path);
    if (parts.length === 2 && mutation.operation === 'set') {
      const senderId = referenceId(mutation.data?.senderId);
      const receiverId = referenceId(mutation.data?.receiverId);
      if (senderId !== actor.establishmentId && receiverId !== actor.establishmentId) throw forbidden();
      const customerId = senderId === actor.establishmentId ? receiverId : senderId;
      if (!(await this.isCustomer(actor, customerId))) throw forbidden();
      return;
    }

    await this.assertChatDocument(actor, parts[1]);
    if (parts.length === 2) {
      if (mutation.operation !== 'update') throw forbidden();
      assertOnlyFields(mutation.data, CHAT_UPDATE_FIELDS, 'data_chat_fields_forbidden');
      return;
    }

    if (parts[2] !== 'Messages' || parts.length !== 4 || mutation.operation !== 'set') {
      throw forbidden();
    }
    if (referenceId(mutation.data?.senderId) !== actor.establishmentId) {
      throw forbidden('O remetente da mensagem deve ser o estabelecimento autenticado.');
    }
  }

  async assertAgentConversation(actor, path) {
    const conversationPath = agentConversationDocumentPath(path);
    if (!conversationPath) throw forbidden();
    const snapshot = await this.firestore.doc(conversationPath).get();
    if (!snapshot.exists || String(snapshot.data()?.companyId || '') !== actor.establishmentId) {
      throw forbidden('Conversa do agente nao pertence ao estabelecimento autenticado.');
    }
  }

  async assertAgentMutation(actor, mutation, path) {
    await this.assertAgentConversation(actor, path);
    const parts = pathParts(path);
    const isMessage = parts.at(-2) === 'mensagens' && parts.length >= 6;
    if (isMessage) {
      if (mutation.operation !== 'set' || mutation.data?.role !== 'assistant') throw forbidden();
      return;
    }

    if (mutation.operation !== 'update') throw forbidden();
    assertOnlyFields(
      mutation.data,
      new Set(['updatedAt', 'totalMensagens']),
      'data_agent_fields_forbidden',
    );
  }

  // Cliente ou participante de conversa com a loja. A lista de clientes nunca e palavra
  // final para negar: id fora dela dispara uma verificacao pontual, com teto de uma
  // varredura por loja a cada dez minutos.
  async isCustomer(actor, userId) {
    if (!userId) return false;
    const ids = await this.getCustomerIds(actor);
    if (ids.has(userId)) return true;
    const conversationIds = await this.getConversationIds(actor);
    if (conversationIds.has(userId)) return true;
    return this.verifyCustomer(actor, userId);
  }

  // Varre os pedidos da loja procurando o id, no maximo uma vez a cada dez minutos. O que
  // achar entra na memoria e e acrescentado ao documento por arrayUnion.
  async verifyCustomer(actor, userId) {
    const cached = this.customerCache.get(actor.establishmentId);
    const agora = this.clock();
    if (cached?.verifiedAt && agora - cached.verifiedAt < VERIFICATION_TTL_MS) return false;

    const { ids } = await clientesDosPedidos({
      db: this.firestore,
      storeRef: this.storeReference(actor.establishmentId),
    });
    const encontrado = ids.has(userId);
    const atual = cached?.ids || new Set();
    ids.forEach((id) => atual.add(id));
    this.customerCache.set(actor.establishmentId, {
      ids: atual,
      loadedAt: agora,
      verifiedAt: agora,
      complete: true,
    });

    if (encontrado) {
      try {
        await acrescentarClientes({
          storeRef: this.storeReference(actor.establishmentId),
          ids: [userId],
          arrayUnion: this.arrayUnion,
        });
      } catch (error) {
        // Documento ainda nao criado pela rotina noturna: a memoria ja basta para esta
        // chamada, e a rotina da noite grava o id.
      }
    }
    return encontrado;
  }

  // Quem a loja pode ler em Users: cliente dela mais participante de conversa com ela.
  // Usado pelo filterDocuments e pelo getScopedUsers do gateway, para os dois caminhos de
  // leitura responderem o mesmo.
  async getReadableUserIds(actor) {
    const [customerIds, conversationIds] = await Promise.all([
      this.getCustomerIds(actor),
      this.getConversationIds(actor),
    ]);
    return new Set([...customerIds, ...conversationIds]);
  }

  storeReference(establishmentId) {
    return this.firestore.collection('estabelecimentos').doc(establishmentId);
  }

  // Le a lista gravada pela rotina noturna (clientesDaLoja.js). Indice ausente ou bloco
  // faltando caem na varredura direta, como era antes.
  async getCustomerIds(actor) {
    const cached = this.customerCache.get(actor.establishmentId);
    if (cached?.complete && this.clock() - cached.loadedAt < CUSTOMER_CACHE_TTL_MS) {
      return cached.ids;
    }

    const storeRef = this.storeReference(actor.establishmentId);
    const lista = await lerListaDeClientes({ storeRef });
    const ids = lista.ids
      ? new Set(lista.ids)
      : (await clientesDosPedidos({ db: this.firestore, storeRef })).ids;

    this.customerCache.set(actor.establishmentId, {
      ids,
      loadedAt: this.clock(),
      verifiedAt: cached?.verifiedAt,
      complete: true,
      origem: lista.ids ? 'documento' : `recuo:${lista.motivo}`,
    });
    return ids;
  }

  // Quem conversa com a loja: participante de Chats e usuario das conversas do agente.
  // Mesmo cache por loja, mesmo prazo. Duas consultas a mais por renovacao, nenhuma por
  // chamada.
  async getConversationIds(actor) {
    const cached = this.conversationCache.get(actor.establishmentId);
    if (cached && this.clock() - cached.loadedAt < CUSTOMER_CACHE_TTL_MS) return cached.ids;

    const { establishmentId } = actor;
    const chats = this.firestore.collection('Chats');
    const [comoRemetente, comoDestino, conversas] = await Promise.all([
      chats.where('senderId', '==', establishmentId).select('receiverId').get(),
      chats.where('receiverId', '==', establishmentId).select('senderId').get(),
      this.firestore
        .collectionGroup('conversas')
        .where('companyId', '==', establishmentId)
        .select('userId')
        .get(),
    ]);

    const ids = new Set();
    const guardar = (valor) => {
      const id = referenceId(valor);
      if (id && id !== establishmentId) ids.add(id);
    };
    comoRemetente.docs.forEach((document) => guardar(document.get('receiverId')));
    comoDestino.docs.forEach((document) => guardar(document.get('senderId')));
    conversas.docs.forEach((document) => guardar(document.get('userId')));

    this.conversationCache.set(establishmentId, { ids, loadedAt: this.clock() });
    return ids;
  }

  rememberCustomersFromOrders(actor, documents, complete = false) {
    const cached = this.customerCache.get(actor.establishmentId);
    const ids = cached?.ids || new Set();
    documents.forEach((document) => {
      const id = clientIdFromOrder(document.data());
      if (id) ids.add(id);
    });
    this.customerCache.set(actor.establishmentId, {
      ids,
      loadedAt: this.clock(),
      complete: cached?.complete || complete,
    });
  }
}

function targetBase(target) {
  return target?.kind === 'query' ? targetBase(target.source) : target;
}

function sourcePath(target) {
  return targetBase(target)?.path || '';
}

function pathParts(path) {
  return String(path || '').split('/').filter(Boolean);
}

function isOwnEstablishmentPath(path, establishmentId) {
  const parts = pathParts(path);
  return parts[0] === 'estabelecimentos' && parts[1] === establishmentId;
}

function isAllowedAutomation(path) {
  const parts = pathParts(path);
  return parts.length === 2 && parts[0] === 'Automacoes' && ALLOWED_AUTOMATIONS.has(parts[1]);
}

function isSearchTermsPath(path, establishmentId) {
  const parts = pathParts(path);
  return (
    parts[0] === 'Agentes'
      && parts[1] === 'AgenteVendas'
      && parts[2] === 'TermosBuscadosPorEstabelecimento'
      && parts[3] === establishmentId
      && parts[4] === 'termos'
  ) || (
    parts[0] === 'AgenteVendas'
      && parts[1] === establishmentId
      && parts[2] === 'termosBuscados'
  );
}

function isAgentConversationPath(path) {
  const parts = pathParts(path);
  return (
    parts[0] === 'Agentes'
      && parts[1] === 'AgenteVendas'
      && parts[2] === 'Usuarios'
      && parts[4] === 'conversas'
  ) || (
    parts[0] === 'AgenteVendas'
      && parts[2] === 'conversas'
  );
}

function agentConversationDocumentPath(path) {
  const parts = pathParts(path);
  if (parts[0] === 'Agentes' && parts[1] === 'AgenteVendas' && parts[2] === 'Usuarios') {
    if (parts[4] !== 'conversas' || !parts[5]) return null;
    return parts.slice(0, 6).join('/');
  }
  if (parts[0] === 'AgenteVendas') {
    if (parts[2] !== 'conversas' || !parts[3]) return null;
    return parts.slice(0, 4).join('/');
  }
  return null;
}

function hasWhere(target, field, expectedReferenceId) {
  return allWhereConstraints(target).some((constraint) => {
    if (constraint.field !== field || constraint.operator !== '==') return false;
    return referenceId(constraint.value) === expectedReferenceId;
  });
}

function hasChatOwnershipFilter(target, establishmentId) {
  if (target?.kind !== 'query') return false;
  return (target.constraints || []).some((constraint) => (
    constraint?.kind === 'where'
      &&
    (constraint.field === 'senderId' || constraint.field === 'receiverId')
      && constraint.operator === '=='
      && referenceId(constraint.value) === establishmentId
  ));
}

function allWhereConstraints(target) {
  if (target?.kind !== 'query') return [];
  return (target.constraints || []).flatMap(flattenWhere);
}

function isCompleteOrderScope(target) {
  if (target?.kind !== 'query') return true;
  return !(target.constraints || []).some((constraint) => {
    if (constraint?.kind === 'limit' || constraint?.kind === 'startAfter') return true;
    if (constraint?.kind !== 'where') return false;
    return constraint.field !== 'companyReference';
  });
}

function flattenWhere(constraint) {
  if (constraint?.kind === 'where') return [constraint];
  if (constraint?.kind === 'or') return (constraint.filters || []).flatMap(flattenWhere);
  return [];
}

function establishmentIdFromOrder(data = {}) {
  return referenceId(data.companyReference || data.companyRef || data.companyId);
}

function clientIdFromOrder(data = {}) {
  return referenceId(
    data.clientId
      || data.customerId
      || data.userId
      || data.clientReference
      || data.customerReference
      || data.userReference
      || data.client?.id
      || data.customer?.id
      || data.user?.id,
  );
}

function chatBelongsTo(data = {}, establishmentId) {
  return referenceId(data.senderId) === establishmentId
    || referenceId(data.receiverId) === establishmentId;
}

function referenceId(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.split('/').filter(Boolean).at(-1) || value;
  if (value.id) return String(value.id);
  if (value.path) return String(value.path).split('/').filter(Boolean).at(-1) || '';
  return '';
}

function assertOnlyFields(data, allowed, code) {
  const fields = Object.keys(data || {});
  if (!fields.length || fields.some((field) => !allowed.has(field))) {
    throw forbidden('A alteracao contem campos nao permitidos.', code);
  }
}

// isTest e isTestAccount so aceitam true ou false.
function assertBooleanFields(data, code) {
  const invalid = Object.entries(data || {})
    .some(([field, value]) => BOOLEAN_MUTATION_FIELDS.has(field) && typeof value !== 'boolean');
  if (invalid) {
    throw forbidden('A alteracao contem campos nao permitidos.', code);
  }
}

function invalidTarget() {
  return new AppError('Destino de dados invalido.', {
    statusCode: 400,
    code: 'data_target_invalid',
  });
}

function forbidden(message = 'Acesso aos dados solicitado nao permitido.', code = 'data_access_forbidden') {
  return new AppError(message, { statusCode: 403, code });
}
