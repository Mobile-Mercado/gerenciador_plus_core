import { getApps, initializeApp } from 'firebase-admin/app';
import { getAppCheck } from 'firebase-admin/app-check';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

export function getFirebaseAuth() {
  if (!getApps().length) {
    initializeApp();
  }

  return getAuth();
}

export function getFirestoreDb() {
  if (!getApps().length) {
    initializeApp();
  }

  return getFirestore();
}

// Bucket dos icones da lista padrao (categoriasProdutos/ no Storage).
export function getStorageBucket(name) {
  if (!getApps().length) {
    initializeApp();
  }

  return getStorage().bucket(name);
}

// App Check do cadastro publico de loja (desligado por variavel ate o app enviar o token).
export function getFirebaseAppCheck() {
  if (!getApps().length) {
    initializeApp();
  }

  return getAppCheck();
}
