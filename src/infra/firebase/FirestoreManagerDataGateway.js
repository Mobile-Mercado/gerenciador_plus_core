import { FieldPath, Filter } from 'firebase-admin/firestore';
import { AppError } from '../../domain/errors/AppError.js';
import {
  assertFirestorePath,
  decodeFirestoreValue,
  serializeDocumentSnapshot,
} from './firestoreTransport.js';

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
    return serializeDocumentSnapshot(
      snapshot,
      (path, data) => this.policy.sanitizeDocument(path, data),
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
    }
    const filtered = await this.policy.filterDocuments({ actor, target, documents });
    return this.serializeQuery(filtered);
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

  async mutate({ actor, request }) {
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
      await this.policy.assertMutation({ actor, mutation });
    }

    if (normalized.length === 1 && request.operation !== 'batch') {
      await this.applyMutation(normalized[0]);
    } else {
      const batch = this.firestore.batch();
      normalized.forEach((mutation) => this.applyBatchMutation(batch, mutation));
      await batch.commit();
    }
    return { written: normalized.length };
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
    if (mutation.operation === 'set') {
      await reference.set(mutation.data, mutation.options);
    } else if (mutation.operation === 'update') {
      await reference.update(mutation.data);
    } else {
      await reference.delete();
    }
  }

  applyBatchMutation(batch, mutation) {
    const reference = this.firestore.doc(mutation.target.path);
    if (mutation.operation === 'set') batch.set(reference, mutation.data, mutation.options);
    else if (mutation.operation === 'update') batch.update(reference, mutation.data);
    else batch.delete(reference);
  }

  async getScopedUsers(actor, target) {
    const customerIds = await this.policy.getCustomerIds(actor);
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

function invalidTarget() {
  return new AppError('Consulta de dados invalida.', {
    statusCode: 400,
    code: 'data_target_invalid',
  });
}
