import { Agent } from 'node:https';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAppCheck } from 'firebase-admin/app-check';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

// So no teste local (F1, 14/10/2026): com a credencial do gcloud (sem conta de servico), a API de
// login do Google exige o projeto de cota no cabecalho x-goog-user-project, e o firebase-admin nao
// manda. Com GOOGLE_CLOUD_QUOTA_PROJECT definida, o agente HTTP do app (opcao publica httpAgent)
// poe o cabecalho nas chamadas a *.googleapis.com. Sem a variavel, nada muda.
export class AgenteComProjetoDeCota extends Agent {
  constructor(projetoDeCota, opcoes = {}) {
    super({ keepAlive: true, ...opcoes });
    this.projetoDeCota = projetoDeCota;
  }

  addRequest(requisicao, opcoes) {
    const host = String(opcoes?.host || opcoes?.hostname || '');
    if (host.endsWith('googleapis.com') && !requisicao.getHeader('x-goog-user-project')) {
      requisicao.setHeader('x-goog-user-project', this.projetoDeCota);
    }
    return super.addRequest(requisicao, opcoes);
  }
}

export function opcoesDoApp(ambiente = process.env) {
  const projetoDeCota = String(ambiente.GOOGLE_CLOUD_QUOTA_PROJECT || '').trim();
  return projetoDeCota ? { httpAgent: new AgenteComProjetoDeCota(projetoDeCota) } : undefined;
}

function iniciarApp() {
  if (!getApps().length) {
    initializeApp(opcoesDoApp());
  }
}

export function getFirebaseAuth() {
  iniciarApp();

  return getAuth();
}

export function getFirestoreDb() {
  iniciarApp();

  return getFirestore();
}

// Bucket dos icones da lista padrao (categoriasProdutos/ no Storage).
export function getStorageBucket(name) {
  iniciarApp();

  return getStorage().bucket(name);
}

// App Check do cadastro publico de loja (desligado por variavel ate o app enviar o token).
export function getFirebaseAppCheck() {
  iniciarApp();

  return getAppCheck();
}
