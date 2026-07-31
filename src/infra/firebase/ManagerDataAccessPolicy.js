import { AppError } from '../../domain/errors/AppError.js';

const CUSTOMER_CACHE_TTL_MS = 5 * 60 * 1000;
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
]);
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
  'createAt',
  'createdAt',
  'birthDate',
  'birthday',
  'dateOfBirth',
  'dataNascimento',
  'deliveryAddressSelected',
]);

export class ManagerDataAccessPolicy {
  constructor({ firestore, clock = () => Date.now() }) {
    this.firestore = firestore;
    this.clock = clock;
    this.customerCache = new Map();
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

    if (isOwnEstablishmentPath(path, actor.establishmentId)) return;

    const [root] = pathParts(path);
    if (root === 'PurchaseRequests') {
      if (mutation.operation !== 'update') throw forbidden();
      await this.assertOrderDocument(actor, path);
      assertOnlyFields(mutation.data, ORDER_UPDATE_FIELDS, 'data_order_fields_forbidden');
      return;
    }

    if (root === 'Users') {
      if (mutation.operation !== 'update') throw forbidden();
      await this.assertUserPath(actor, path);
      assertOnlyFields(mutation.data, new Set(['segmento']), 'data_user_fields_forbidden');
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

    if (root === 'Users' && pathParts(path).length === 1) {
      const customerIds = await this.getCustomerIds(actor);
      return documents.filter((document) => (
        document.id === actor.userId || customerIds.has(document.id)
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

  async isCustomer(actor, userId) {
    if (!userId) return false;
    const ids = await this.getCustomerIds(actor);
    return ids.has(userId);
  }

  async getCustomerIds(actor) {
    const cached = this.customerCache.get(actor.establishmentId);
    if (cached?.complete && this.clock() - cached.loadedAt < CUSTOMER_CACHE_TTL_MS) {
      return cached.ids;
    }

    const establishmentReference = this.firestore
      .collection('estabelecimentos')
      .doc(actor.establishmentId);
    const snapshot = await this.firestore
      .collection('PurchaseRequests')
      .where('companyReference', '==', establishmentReference)
      .select(
        'clientId',
        'customerId',
        'userId',
        'clientReference',
        'customerReference',
        'userReference',
      )
      .get();
    const ids = new Set();
    snapshot.docs.forEach((document) => {
      const id = clientIdFromOrder(document.data());
      if (id) ids.add(id);
    });
    this.customerCache.set(actor.establishmentId, {
      ids,
      loadedAt: this.clock(),
      complete: true,
    });
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

function invalidTarget() {
  return new AppError('Destino de dados invalido.', {
    statusCode: 400,
    code: 'data_target_invalid',
  });
}

function forbidden(message = 'Acesso aos dados solicitado nao permitido.', code = 'data_access_forbidden') {
  return new AppError(message, { statusCode: 403, code });
}
