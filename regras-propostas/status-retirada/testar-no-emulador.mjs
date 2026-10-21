// Trava do status de retirada (cola RP-13, decisao do Thay de 21/10/2026): pedido em
// PurchaseStatus.readyForPickup nao volta para pending, accepted nem separatingOrder. Roda so no
// emulador, com projeto demo-*, contra o firestore.rules do repositorio e contra a proposta por dono.
//
//   npx firebase-tools@15.30.0 emulators:exec --only firestore --project demo-regras \
//     "node regras-propostas/status-retirada/testar-no-emulador.mjs"
//
// O firebase-tools 15 pede Java 21. O SDK web vem de ../web_gerenciador_plus/node_modules
// (FIREBASE_WEB_SDK_DIR muda).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const raiz = path.resolve(aqui, '../..');
const PROJETO = process.env.GCLOUD_PROJECT || 'demo-regras';
const HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!HOST) throw new Error('Rode dentro de "firebase emulators:exec --only firestore".');
if (!PROJETO.startsWith('demo-')) throw new Error('Use um projeto demo-*: este teste nunca fala com produção.');
const [hostname, porta] = HOST.split(':');

const web = createRequire(path.join(process.env.FIREBASE_WEB_SDK_DIR || path.resolve(raiz, '../web_gerenciador_plus'), 'package.json'));
const { initializeApp, deleteApp } = web('firebase/app');
const { getFirestore, connectFirestoreEmulator, doc, updateDoc, setDoc } = web('firebase/firestore');
const servidor = createRequire(path.join(raiz, 'package.json'));
const admin = servidor('firebase-admin/app').initializeApp({ projectId: PROJETO }, 'semeador');
const banco = servidor('firebase-admin/firestore').getFirestore(admin);

const conjuntos = [
  { nome: 'firestore.rules', regras: readFileSync(path.join(raiz, 'firestore.rules'), 'utf8') },
  { nome: 'proposta por dono', regras: readFileSync(path.join(raiz, 'regras-propostas/por-dono/firestore.rules'), 'utf8') },
];

const S = (status) => `PurchaseStatus.${status}`;
async function semear() {
  await fetch(`http://${HOST}/emulator/v1/projects/${PROJETO}/databases/(default)/documents`, { method: 'DELETE' });
  const lote = banco.batch();
  const ref = (caminho) => banco.doc(caminho);
  lote.set(ref('Users/u-cli'), { id: 'u-cli', userAuthId: 'uid-cli' });
  lote.set(ref('estabelecimentos/loja-1'), { name: 'Loja 1', userReference: ref('Users/loja-1') });
  const pedido = (status) => ({ clientId: 'u-cli', companyReference: ref('estabelecimentos/loja-1'), currentPurchaseStatus: status, statusList: [] });
  ['pronto-1', 'pronto-2', 'pronto-3', 'pronto-4', 'pronto-5', 'pronto-6'].forEach((id) => lote.set(ref(`PurchaseRequests/${id}`), pedido(S('readyForPickup'))));
  lote.set(ref('PurchaseRequests/separando'), pedido(S('separatingOrder')));
  lote.set(ref('PurchaseRequests/pendente'), pedido(S('pending')));
  ['pronto-a', 'pronto-b'].forEach((id) => lote.set(ref(`estabelecimentos/loja-1/PurchaseRequests/${id}`), { currentPurchaseStatus: S('readyForPickup') }));
  await lote.commit();
}

// [descricao, caminho, mudanca, permitido]
const CASOS = [
  ['pronto para retirar -> pending (Gerenciador antigo)', 'PurchaseRequests/pronto-1', { currentPurchaseStatus: S('pending') }, false],
  ['pronto para retirar -> accepted ("Aceitar" do Gerenciador antigo)', 'PurchaseRequests/pronto-2', { currentPurchaseStatus: S('accepted') }, false],
  ['pronto para retirar -> separatingOrder', 'PurchaseRequests/pronto-3', { currentPurchaseStatus: S('separatingOrder') }, false],
  ['pronto para retirar -> accepted sem prefixo', 'PurchaseRequests/pronto-4', { currentPurchaseStatus: 'accepted' }, false],
  ['pronto para retirar -> completed (retirado)', 'PurchaseRequests/pronto-5', { currentPurchaseStatus: S('completed') }, true],
  ['pronto para retirar, so outro campo (prontoParaRetirarEm)', 'PurchaseRequests/pronto-6', { prontoParaRetirarEm: new Date('2026-10-21T18:00:00Z') }, true],
  ['separatingOrder -> pronto para retirar', 'PurchaseRequests/separando', { currentPurchaseStatus: S('readyForPickup') }, true],
  ['pending -> accepted (fluxo de sempre)', 'PurchaseRequests/pendente', { currentPurchaseStatus: S('accepted') }, true],
  ['dentro da loja: pronto -> accepted', 'estabelecimentos/loja-1/PurchaseRequests/pronto-a', { currentPurchaseStatus: S('accepted') }, false],
  ['dentro da loja: pronto -> completed', 'estabelecimentos/loja-1/PurchaseRequests/pronto-b', { currentPurchaseStatus: S('completed') }, true],
];

let falhas = 0;
for (const conjunto of conjuntos) {
  const resposta = await fetch(`http://${HOST}/emulator/v1/projects/${PROJETO}:securityRules`, {
    method: 'PUT', body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: conjunto.regras }] } }),
  });
  if (!resposta.ok) throw new Error(`Regras recusadas (${conjunto.nome}): ${await resposta.text()}`);
  await semear();
  // A loja do pedido, com a claim adminOf: passa na regra de hoje e na proposta por dono.
  const app = initializeApp({ projectId: PROJETO, apiKey: 'demo' }, `app-${conjunto.nome}`);
  const db = getFirestore(app);
  connectFirestoreEmulator(db, hostname, Number(porta), { mockUserToken: { sub: 'uid-dono1', adminOf: 'loja-1', groupId: 'g-admin' } });
  for (const [descricao, caminho, mudanca, esperado] of CASOS) {
    let permitido = true;
    try {
      await updateDoc(doc(db, caminho), mudanca);
    } catch (erro) {
      if (erro.code !== 'permission-denied') throw erro;
      permitido = false;
    }
    const ok = permitido === esperado;
    if (!ok) falhas += 1;
    console.log(`${ok ? 'ok  ' : 'FORA'} | ${conjunto.nome} | ${descricao} | ${permitido ? 'permite' : 'NEGA'}`);
  }
  // Criar pedido continua permitido (a regra nova so olha o update).
  let criou = true;
  try { await setDoc(doc(db, `estabelecimentos/loja-1/PurchaseRequests/novo-${conjunto.nome.length}`), { currentPurchaseStatus: S('pending') }); } catch { criou = false; }
  if (!criou) falhas += 1;
  console.log(`${criou ? 'ok  ' : 'FORA'} | ${conjunto.nome} | criar pedido dentro da loja | ${criou ? 'permite' : 'NEGA'}`);
  await deleteApp(app);
}
console.log(`\n${conjuntos.length * (CASOS.length + 1)} casos, ${falhas} fora do esperado.`);
process.exitCode = falhas ? 1 : 0;
