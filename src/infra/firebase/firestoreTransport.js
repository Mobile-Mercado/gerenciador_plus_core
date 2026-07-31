import {
  FieldValue,
  GeoPoint,
  Timestamp,
} from 'firebase-admin/firestore';
import { AppError } from '../../domain/errors/AppError.js';

export const TRANSPORT_TYPE = '__managerDataType';

export function encodeFirestoreValue(value) {
  if (value === null || value === undefined) return value ?? null;
  if (isTimestamp(value)) {
    return { [TRANSPORT_TYPE]: 'timestamp', millis: value.toMillis() };
  }
  if (value instanceof Date) {
    return { [TRANSPORT_TYPE]: 'timestamp', millis: value.getTime() };
  }
  if (isDocumentReference(value)) {
    return { [TRANSPORT_TYPE]: 'reference', path: value.path };
  }
  if (isGeoPoint(value)) {
    return {
      [TRANSPORT_TYPE]: 'geopoint',
      latitude: value.latitude,
      longitude: value.longitude,
    };
  }
  if (Array.isArray(value)) return value.map(encodeFirestoreValue);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, encodeFirestoreValue(entry)]),
    );
  }
  return value;
}

export function decodeFirestoreValue(value, firestore, { allowFieldValues = false } = {}) {
  if (value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) {
    return value.map((entry) => decodeFirestoreValue(entry, firestore, { allowFieldValues }));
  }
  if (typeof value !== 'object') return value;

  const type = value[TRANSPORT_TYPE];
  if (type === 'timestamp') return Timestamp.fromMillis(assertFiniteNumber(value.millis));
  if (type === 'reference') return firestore.doc(assertFirestorePath(value.path, 'document'));
  if (type === 'geopoint') {
    return new GeoPoint(
      assertFiniteNumber(value.latitude),
      assertFiniteNumber(value.longitude),
    );
  }
  if (type === 'fieldValue') {
    if (!allowFieldValues) throw invalidTransport('Valor especial nao permitido nesta consulta.');
    const entries = Array.isArray(value.values) ? value.values : [];
    if (value.operation === 'serverTimestamp') return FieldValue.serverTimestamp();
    if (value.operation === 'increment') {
      return FieldValue.increment(assertFiniteNumber(value.value));
    }
    if (value.operation === 'arrayUnion') {
      return FieldValue.arrayUnion(
        ...entries.map((entry) => decodeFirestoreValue(entry, firestore, { allowFieldValues })),
      );
    }
    throw invalidTransport('Operacao especial desconhecida.');
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      decodeFirestoreValue(entry, firestore, { allowFieldValues }),
    ]),
  );
}

export function serializeDocumentSnapshot(snapshot, sanitize = (path, data) => data) {
  const data = snapshot.exists ? sanitize(snapshot.ref.path, snapshot.data()) : null;
  return {
    id: snapshot.id,
    path: snapshot.ref.path,
    exists: snapshot.exists,
    data: snapshot.exists ? encodeFirestoreValue(data) : null,
  };
}

export function assertFirestorePath(path, expectedKind) {
  const normalized = String(path || '')
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join('/');
  const segmentCount = normalized.split('/').filter(Boolean).length;
  const valid = expectedKind === 'document'
    ? segmentCount > 0 && segmentCount % 2 === 0
    : segmentCount > 0 && segmentCount % 2 === 1;
  if (!valid || normalized.length > 1500) {
    throw invalidTransport('Caminho do Firestore invalido.');
  }
  return normalized;
}

function isTimestamp(value) {
  return typeof value?.toMillis === 'function'
    && typeof value?.seconds === 'number'
    && value.constructor?.name === 'Timestamp';
}

function isDocumentReference(value) {
  return typeof value?.path === 'string'
    && typeof value?.get === 'function'
    && value.constructor?.name === 'DocumentReference';
}

function isGeoPoint(value) {
  return typeof value?.latitude === 'number'
    && typeof value?.longitude === 'number'
    && value.constructor?.name === 'GeoPoint';
}

function assertFiniteNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw invalidTransport('Numero invalido no transporte de dados.');
  return number;
}

function invalidTransport(message) {
  return new AppError(message, { statusCode: 400, code: 'data_transport_invalid' });
}
