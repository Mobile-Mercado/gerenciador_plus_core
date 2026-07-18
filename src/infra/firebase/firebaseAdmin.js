import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

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
