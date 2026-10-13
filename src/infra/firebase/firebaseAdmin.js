import { getApps, initializeApp } from 'firebase-admin/app';
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
