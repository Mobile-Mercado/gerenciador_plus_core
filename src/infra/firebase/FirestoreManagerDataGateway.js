import { FieldPath, Filter } from 'firebase-admin/firestore';
import { AppError } from '../../domain/errors/AppError.js';
import {
  assertFirestorePath,
  decodeFirestoreValue,
  serializeDocumentSnapshot,
} from './firestoreTransport.js';
import { carimboDeStatus } from './ManagerDataAccessPolicy.js';
import { autorDaAcao, ehAcaoDaEquipe, ehHistoricoDaEquipe } from '../../domain/logs/autorDaAcao.js';
import { contasDoAdminParaALoja, ehAcaoDoAdmin, ehDoAdmin } from '../../domain/logs/acaoDoAdmin.js';
import { caminhosDoAdminNaLoja, contasDoAdminDaPlataforma } from './contasDoAdminDaPlataforma.js';
import { nomeDoComputadorNaLoja } from './nomeDoComputador.js';

const MAX_BATCH_OPERATIONS = 450;
const MAX_QUERY_LIMIT = 500;
const USER_FETCH_CHUNK = 100;

export class FirestoreManagerDataGateway {
  constructor({ firestore, policy }) {
    this.firestore = firestore;
    this.policy = policy;
  }

  async getDocument({ actor, target }) {
    await this.policy.assertRead({ actor, target });
    const reference = this.documentReference(target);
    const snapshot = await reference.get();
    // Cola B57-13k, item 35: os registros de lote do Admin nao aparecem para a loja.
    const contas = this.escondeDoAdmin(actor) && ehHistoricoDaEquipe(reference.path, actor.establishmentId)
      ? await this.contasDoAdmin(actor)
      : null;
    return serializeDocumentSnapshot(
      snapshot,
      (path, data) => {
        const limpo = this.policy.sanitizeDocument(path, data);
        if (!contas || !Array.isArray(limpo?.registros)) return limpo;
        return { ...limpo, registros: limpo.registros.filter((registro) => !ehDoAdmin(registro, contas)) };
      },
    );
  }

  async getDocuments({ actor, target }) {
    await this.policy.assertRead({ actor, target });
    let documents;
    if (isRootUsersTarget(target)) {
      documents = await this.getScopedUsers(actor, target);
    } else {
      const queryReference = await this.queryReference(actor, target);
      const snapshot = await queryReference.get();
      documents = snapshot.docs;
      if (this.escondeDoAdmin(actor) && ehAcoesDaEquipe(target, actor.establishmentId)) {
        documents = await this.semAcoesDoAdmin(actor, target, queryReference, documents);
      }
    }
    const filtered = await this.policy.filterDocuments({ actor, target, documents });
    return this.serializeQuery(filtered);
  }

  // Cola B57-13k, item 35: "nada que o Admin faz fica visivel para o gerente ou para o dono da loja".
  // So a leitura da loja; o admin da plataforma agindo na loja ve tudo. Nada e apagado no banco.
  escondeDoAdmin(actor) {
    return Boolean(actor?.establishmentId) && !actor.porAdminDaPlataforma;
  }

  async contasDoAdmin(actor) {
    return contasDoAdminParaALoja(await contasDoAdminDaPlataforma(this.firestore), actor?.contaDaLoja);
  }

  // Tira as linhas do Admin e completa a pagina com as seguintes (ate 5 leituras a mais), para a
  // paginacao do painel (pagina cheia = tem mais) continuar certa.
  async semAcoesDoAdmin(actor, target, queryReference, documents) {
    const [contas, caminhosDoAdmin] = await Promise.all([
      this.contasDoAdmin(actor),
      caminhosDoAdminNaLoja(this.firestore, actor.establishmentId),
    ]);
    const visivel = (documento) => !ehAcaoDoAdmin(documento.data(), { caminho: documento.ref.path, caminhosDoAdmin, contas });
    const limite = limiteDaConsulta(target);
    const visiveis = documents.filter(visivel);
    let ultimo = documents[documents.length - 1];
    // Pagina cheia: pode haver mais linhas depois da ultima lida.
    let temMais = Boolean(limite) && documents.length === limite;
    for (let rodada = 0; temMais && visiveis.length < limite && rodada < 5; rodada += 1) {
      const falta = limite - visiveis.length;
      // eslint-disable-next-line no-await-in-loop
      const seguinte = await queryReference.startAfter(ultimo).limit(falta).get();
      visiveis.push(...seguinte.docs.filter(visivel));
      temMais = seguinte.docs.length === falta;
      ultimo = seguinte.docs[seguinte.docs.length - 1];
    }
    return visiveis;
  }

  async countDocuments({ actor, target }) {
    await this.policy.assertRead({ actor, target });
    if (isRootUsersTarget(target)) {
      const documents = await this.getScopedUsers(actor, target);
      return { count: documents.length };
    }
    const queryReference = await this.queryReference(actor, target);
    const snapshot = await queryReference.count().get();
    return { count: Number(snapshot.data().count || 0) };
  }

  async mutate({ actor, request, sessaoId = null }) {
    const operations = request.operation === 'batch'
      ? request.operations
      : [request];
    if (!Array.isArray(operations) || !operations.length || operations.length > MAX_BATCH_OPERATIONS) {
      throw new AppError('Quantidade de alteracoes invalida.', {
        statusCode: 400,
        code: 'data_batch_invalid',
      });
    }

    const normalized = operations.map((mutation) => this.normalizeMutation(mutation));
    for (const mutation of normalized) {
      // Cola B57-13g, item 6: a acao nova do Log da equipe e gravada para todo usuario logado da
      // loja, sem a chave settings.edit; so na loja dele e so documento novo (create, que nao
      // sobrescreve registro). Merge, update e delete seguem pela politica.
      if (ehCriacaoDeAcaoDaEquipe(mutation, actor)) {
        this.policy.assertActor(actor);
        mutation.somenteCriar = true;
        continue;
      }
      await this.policy.assertMutation({ actor, mutation });
    }
    // Depois da politica: o carimbo nao passa pela lista de campos do painel, so o
    // Core grava quem trocou o status.
    normalized.forEach((mutation) => {
      if (mutation.operation === 'update' && mutation.target.path.startsWith('PurchaseRequests/')) {
        mutation.data = carimboDeStatus(actor, mutation.data);
      }
    });
    await this.carimbarAutor(actor, normalized, sessaoId);

    if (normalized.length === 1 && request.operation !== 'batch') {
      await this.applyMutation(normalized[0]);
    } else {
      const batch = this.firestore.batch();
      normalized.forEach((mutation) => this.applyBatchMutation(batch, mutation));
      await batch.commit();
    }
    return { written: normalized.length };
  }

  // Cola B57-13, item 28: a acao do Log da equipe gravada pelo painel leva o autor (conta da loja ou
  // funcionario) e o nome do computador em "Acessos conectados", lido da sessao do X-Sessao. O autor
  // do corpo e trocado pelo do Core.
  //
  // Cola B57-13g, item 28.5: os registros de lote do categorizador, do taggeador e do nomeador
  // (implantacaoGrenciador/historicoProdutos_N) ganham o mesmo autor. O painel regrava a pagina
  // inteira: so os registros alem dos ja gravados sao novos; os antigos ficam com o autor que tinham.
  async carimbarAutor(actor, normalized, sessaoId) {
    const acoes = normalized.filter((mutation) => mutation.operation === 'set'
      && ehAcaoDaEquipe(mutation.target.path, actor?.establishmentId));
    const historicos = normalized.filter((mutation) => mutation.operation === 'set'
      && Array.isArray(mutation.data?.registros)
      && ehHistoricoDaEquipe(mutation.target.path, actor?.establishmentId));
    if (!acoes.length && !historicos.length) return;
    const autor = autorDaAcao(actor, await this.nomeDoComputador(actor.establishmentId, sessaoId));
    if (autor) {
      acoes.forEach((mutation) => {
        mutation.data = { ...mutation.data, autor };
      });
    }
    // Cola B57-13k, item 35: a loja le a pagina sem os registros do Admin. Os registros ja gravados
    // ficam exatamente como estao no banco (inclusive os do Admin); do que o painel manda, so o que
    // passa dos que ele leu e novo.
    const contas = historicos.length && this.escondeDoAdmin(actor) ? await this.contasDoAdmin(actor) : null;
    for (const mutation of historicos) {
      // eslint-disable-next-line no-await-in-loop
      const atual = await this.firestore.doc(mutation.target.path).get();
      const gravados = atual.exists && Array.isArray(atual.data()?.registros) ? atual.data().registros : [];
      const lidosPeloPainel = contas ? gravados.filter((registro) => !ehDoAdmin(registro, contas)).length : gravados.length;
      const novos = mutation.data.registros.slice(lidosPeloPainel).map((registro) => {
        if (!registro || typeof registro !== 'object' || Array.isArray(registro)) return registro;
        const { autor: _doCorpo, ...resto } = registro;
        return autor ? { ...resto, autor } : resto;
      });
      mutation.data = { ...mutation.data, registros: [...gravados, ...novos] };
    }
  }

  nomeDoComputador(establishmentId, sessaoId) {
    return nomeDoComputadorNaLoja(this.firestore, establishmentId, sessaoId);
  }

  async subscribe({ actor, target, onSnapshot, onError }) {
    await this.policy.assertRead({ actor, target });
    if (isRootUsersTarget(target)) {
      throw new AppError('Assinatura em tempo real de Users nao e permitida.', {
        statusCode: 400,
        code: 'data_stream_users_not_supported',
      });
    }

    if (target.kind === 'document') {
      return this.documentReference(target).onSnapshot(
        (snapshot) => onSnapshot({
          kind: 'document',
          document: serializeDocumentSnapshot(
            snapshot,
            (path, data) => this.policy.sanitizeDocument(path, data),
          ),
        }),
        onError,
      );
    }

    const reference = await this.queryReference(actor, target);
    return reference.onSnapshot(
      async (snapshot) => {
        try {
          const documents = await this.policy.filterDocuments({
            actor,
            target,
            documents: snapshot.docs,
          });
          onSnapshot({ kind: 'query', ...this.serializeQuery(documents) });
        } catch (error) {
          onError(error);
        }
      },
      onError,
    );
  }

  documentReference(target) {
    if (target?.kind !== 'document') throw invalidTarget();
    return this.firestore.doc(assertFirestorePath(target.path, 'document'));
  }

  async queryReference(actor, target) {
    const base = target.kind === 'query' ? target.source : target;
    let reference;
    if (base?.kind === 'collection') {
      reference = this.firestore.collection(assertFirestorePath(base.path, 'collection'));
    } else if (base?.kind === 'collectionGroup') {
      const collectionId = String(base.id || '').trim();
      if (!collectionId || collectionId.includes('/') || collectionId.length > 200) throw invalidTarget();
      reference = this.firestore.collectionGroup(collectionId);
    } else {
      throw invalidTarget();
    }

    reference = await this.policy.scopeQuery({ actor, target, queryReference: reference });
    if (target.kind !== 'query') return reference;

    for (const constraint of target.constraints || []) {
      reference = await this.applyConstraint(reference, constraint);
    }
    return reference;
  }

  async applyConstraint(reference, constraint) {
    if (constraint?.kind === 'where') {
      return reference.where(
        fieldPath(constraint.field),
        assertOperator(constraint.operator),
        decodeFirestoreValue(constraint.value, this.firestore),
      );
    }
    if (constraint?.kind === 'or') {
      const filters = (constraint.filters || []).map((filter) => this.firestoreFilter(filter));
      if (filters.length < 2 || filters.length > 10) throw invalidTarget();
      return reference.where(Filter.or(...filters));
    }
    if (constraint?.kind === 'orderBy') {
      const direction = constraint.direction === 'desc' ? 'desc' : 'asc';
      return reference.orderBy(fieldPath(constraint.field), direction);
    }
    if (constraint?.kind === 'limit') {
      const requested = Number(constraint.value);
      if (!Number.isInteger(requested) || requested < 1) throw invalidTarget();
      return reference.limit(Math.min(requested, MAX_QUERY_LIMIT));
    }
    if (constraint?.kind === 'startAfter') {
      if (constraint.cursor?.kind === 'document') {
        const snapshot = await this.firestore
          .doc(assertFirestorePath(constraint.cursor.path, 'document'))
          .get();
        if (!snapshot.exists) {
          throw new AppError('Cursor de paginacao nao encontrado.', {
            statusCode: 400,
            code: 'data_cursor_not_found',
          });
        }
        return reference.startAfter(snapshot);
      }
      const values = Array.isArray(constraint.cursor?.values)
        ? constraint.cursor.values.map((value) => decodeFirestoreValue(value, this.firestore))
        : [];
      if (!values.length) throw invalidTarget();
      return reference.startAfter(...values);
    }
    throw invalidTarget();
  }

  firestoreFilter(filter) {
    if (filter?.kind === 'where') {
      return Filter.where(
        fieldPath(filter.field),
        assertOperator(filter.operator),
        decodeFirestoreValue(filter.value, this.firestore),
      );
    }
    if (filter?.kind === 'or') {
      const nested = (filter.filters || []).map((entry) => this.firestoreFilter(entry));
      return Filter.or(...nested);
    }
    throw invalidTarget();
  }

  normalizeMutation(mutation) {
    const operation = String(mutation?.operation || '');
    if (!['set', 'update', 'delete'].includes(operation)) throw invalidTarget();
    const path = assertFirestorePath(mutation?.target?.path, 'document');
    const data = operation === 'delete'
      ? null
      : decodeFirestoreValue(mutation.data || {}, this.firestore, { allowFieldValues: true });
    return {
      operation,
      target: { kind: 'document', path },
      data,
      options: { merge: mutation?.options?.merge === true },
    };
  }

  async applyMutation(mutation) {
    const reference = this.firestore.doc(mutation.target.path);
    if (mutation.somenteCriar) {
      await reference.create(mutation.data);
    } else if (mutation.operation === 'set') {
      await reference.set(mutation.data, mutation.options);
    } else if (mutation.operation === 'update') {
      await reference.update(mutation.data);
    } else {
      await reference.delete();
    }
  }

  applyBatchMutation(batch, mutation) {
    const reference = this.firestore.doc(mutation.target.path);
    if (mutation.somenteCriar) batch.create(reference, mutation.data);
    else if (mutation.operation === 'set') batch.set(reference, mutation.data, mutation.options);
    else if (mutation.operation === 'update') batch.update(reference, mutation.data);
    else batch.delete(reference);
  }

  async getScopedUsers(actor, target) {
    // Cliente da loja mais participante de conversa com ela: a mesma regra do
    // filterDocuments, para os dois caminhos de leitura responderem igual.
    const customerIds = await this.policy.getReadableUserIds(actor);
    const allowedIds = new Set(customerIds);
    allowedIds.add(actor.userId);

    const idFilter = allWhereConstraints(target).find((constraint) => (
      constraint.field?.kind === 'documentId' && constraint.operator === 'in'
    ));
    let ids = [...allowedIds];
    if (idFilter) {
      const requested = new Set(Array.isArray(idFilter.value) ? idFilter.value.map(String) : []);
      ids = ids.filter((id) => requested.has(id));
    }

    const snapshots = [];
    const requestedLimit = queryLimit(target) || MAX_QUERY_LIMIT;
    const requiresGlobalSort = target?.kind === 'query'
      && (target.constraints || []).some((constraint) => constraint?.kind === 'orderBy');
    for (let index = 0; index < ids.length; index += USER_FETCH_CHUNK) {
      const references = ids
        .slice(index, index + USER_FETCH_CHUNK)
        .map((id) => this.firestore.collection('Users').doc(id));
      if (!references.length) continue;
      const chunk = await this.firestore.getAll(...references);
      snapshots.push(
        ...chunk.filter((snapshot) => (
          snapshot.exists && matchesTarget(snapshot, target, this.firestore)
        )),
      );
      if (!requiresGlobalSort && snapshots.length >= requestedLimit) break;
    }

    const ordered = sortTarget(snapshots, target);
    return ordered.slice(0, requestedLimit);
  }

  serializeQuery(documents) {
    const docs = documents.map((document) => serializeDocumentSnapshot(
      document,
      (path, data) => this.policy.sanitizeDocument(path, data),
    ));
    return { docs, size: docs.length, empty: docs.length === 0 };
  }
}

function isRootUsersTarget(target) {
  const base = target?.kind === 'query' ? target.source : target;
  return base?.kind === 'collection' && base.path === 'Users';
}

function allWhereConstraints(target) {
  if (target?.kind !== 'query') return [];
  return (target.constraints || []).flatMap((constraint) => {
    if (constraint?.kind === 'where') return [constraint];
    if (constraint?.kind === 'or') return constraint.filters || [];
    return [];
  });
}

function matchesTarget(snapshot, target, firestore) {
  return allWhereConstraints(target).every((constraint) => {
    const left = constraint.field?.kind === 'documentId'
      ? snapshot.id
      : nestedValue(snapshot.data(), constraint.field);
    const right = decodeFirestoreValue(constraint.value, firestore);
    return compare(left, constraint.operator, right);
  });
}

function compare(left, operator, right) {
  if (operator === '==') return comparable(left) === comparable(right);
  if (operator === 'in') return Array.isArray(right) && right.some((value) => comparable(left) === comparable(value));
  if (operator === 'array-contains') return Array.isArray(left) && left.some((value) => comparable(value) === comparable(right));
  if (operator === 'array-contains-any') {
    return Array.isArray(left) && Array.isArray(right)
      && left.some((entry) => right.some((value) => comparable(entry) === comparable(value)));
  }
  return false;
}

function comparable(value) {
  if (value?.path) return value.path;
  if (typeof value?.toMillis === 'function') return value.toMillis();
  return value;
}

function sortTarget(documents, target) {
  if (target?.kind !== 'query') return documents;
  const orders = (target.constraints || []).filter((constraint) => constraint?.kind === 'orderBy');
  if (!orders.length) return documents;
  return [...documents].sort((a, b) => {
    for (const order of orders) {
      const left = order.field?.kind === 'documentId' ? a.id : nestedValue(a.data(), order.field);
      const right = order.field?.kind === 'documentId' ? b.id : nestedValue(b.data(), order.field);
      const result = comparable(left) < comparable(right) ? -1 : comparable(left) > comparable(right) ? 1 : 0;
      if (result) return order.direction === 'desc' ? -result : result;
    }
    return 0;
  });
}

function queryLimit(target) {
  const constraint = target?.kind === 'query'
    ? (target.constraints || []).find((entry) => entry?.kind === 'limit')
    : null;
  const value = Number(constraint?.value || 0);
  return Number.isInteger(value) && value > 0 ? Math.min(value, MAX_QUERY_LIMIT) : null;
}

function nestedValue(data, field) {
  if (typeof field !== 'string') return undefined;
  return field.split('.').reduce((value, key) => value?.[key], data);
}

function fieldPath(field) {
  if (field?.kind === 'documentId') return FieldPath.documentId();
  const value = String(field || '').trim();
  if (!value || value.length > 500) throw invalidTarget();
  return value;
}

function assertOperator(operator) {
  const allowed = new Set([
    '<', '<=', '==', '!=', '>=', '>',
    'array-contains', 'in', 'not-in', 'array-contains-any',
  ]);
  if (!allowed.has(operator)) throw invalidTarget();
  return operator;
}

// Consulta da colecao AcoesEquipe da loja do ator (Logs da aba Equipe).
function ehAcoesDaEquipe(target, establishmentId) {
  const base = target?.kind === 'query' ? target.source : target;
  return base?.kind === 'collection' && base.path === `estabelecimentos/${establishmentId}/AcoesEquipe`;
}

function limiteDaConsulta(target) {
  const limite = (target?.constraints || []).find((constraint) => constraint?.kind === 'limit');
  const valor = Number(limite?.value);
  return Number.isInteger(valor) && valor > 0 ? Math.min(valor, MAX_QUERY_LIMIT) : null;
}

function ehCriacaoDeAcaoDaEquipe(mutation, actor) {
  return mutation.operation === 'set'
    && mutation.options?.merge !== true
    && ehAcaoDaEquipe(mutation.target.path, actor?.establishmentId);
}

function invalidTarget() {
  return new AppError('Consulta de dados invalida.', {
    statusCode: 400,
    code: 'data_target_invalid',
  });
}
