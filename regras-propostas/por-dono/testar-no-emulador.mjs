// Testa as regras de hoje (origin/main, as publicadas) e a proposta por dono contra cada uso da
// tabela da cola RP-1 (parte D). Roda só no emulador, com projeto demo-*: nada chega à produção.
//
//   npx firebase-tools@15.30.0 emulators:exec --only firestore --project demo-regras \
//     "node regras-propostas/por-dono/testar-no-emulador.mjs"
//
// O SDK web do Firebase vem de ../web_gerenciador_plus/node_modules (FIREBASE_WEB_SDK_DIR muda).
import { execFileSync } from 'node:child_process';
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

const sdkDir = process.env.FIREBASE_WEB_SDK_DIR || path.resolve(raiz, '../web_gerenciador_plus');
const web = createRequire(path.join(sdkDir, 'package.json'));
const { initializeApp, deleteApp } = web('firebase/app');
const fs = web('firebase/firestore');
const servidor = createRequire(path.join(raiz, 'package.json'));
const admin = servidor('firebase-admin/app').initializeApp({ projectId: PROJETO }, 'semeador');
const { getFirestore: getAdminFirestore, Timestamp } = servidor('firebase-admin/firestore');
const banco = getAdminFirestore(admin);

const conjuntos = [
  { nome: 'hoje', regras: execFileSync('git', ['show', 'origin/main:firestore.rules'], { cwd: raiz, encoding: 'utf8' }) },
  { nome: 'proposta', regras: readFileSync(path.join(aqui, 'firestore.rules'), 'utf8') },
];

async function carregarRegras(texto) {
  const resposta = await fetch(`http://${HOST}/emulator/v1/projects/${PROJETO}:securityRules`, {
    method: 'PUT',
    body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: texto }] } }),
  });
  if (!resposta.ok) throw new Error(`Regras recusadas pelo emulador: ${await resposta.text()}`);
}

async function semear() {
  await fetch(`http://${HOST}/emulator/v1/projects/${PROJETO}/databases/(default)/documents`, { method: 'DELETE' });
  const ref = (caminho) => banco.doc(caminho);
  const quando = Timestamp.fromDate(new Date('2026-10-17T12:00:00Z'));
  const docs = {
    // Cliente com dois Users (um por whitelabel), outro cliente e o convidado anônimo do agente.
    'Users/u-cli': { id: 'u-cli', userAuthId: 'uid-cli', whitelabelId: 'wl', userType: 'UserType.cliente', email: 'cli@x.com', phone: '27999990000' },
    'Users/u-cli-wl2': { id: 'u-cli-wl2', userAuthId: 'uid-cli', whitelabelId: 'wl2', userType: 'UserType.cliente' },
    'Users/u-outro': { id: 'u-outro', userAuthId: 'uid-outro', whitelabelId: 'wl', userType: 'UserType.cliente' },
    'Users/u-anon': { id: 'u-anon', userAuthId: 'uid-anon', userType: 'UserType.cliente' },
    // Dono da loja-1: o Users tem o id da loja (65 de 72 lojas em produção). Dono da loja-2 não.
    'Users/loja-1': { id: 'loja-1', userAuthId: 'uid-dono1', userType: 'UserType.empresa', email: 'dono1@x.com' },
    'Users/u-dono2': { id: 'u-dono2', userAuthId: 'uid-dono2', userType: 'UserType.empresa' },
    'Users/u-consultor': { id: 'u-consultor', userAuthId: 'uid-consultor', userType: 'UserType.consultor', companies: [ref('estabelecimentos/loja-1')] },
    'Users/u-cli/ShoppingCart/loja-1': { companyRef: ref('estabelecimentos/loja-1') },
    'Users/u-cli/ShoppingCart/loja-1/Items/i1': { quantity: 1 },
    'Users/u-cli/Addresses/a1': { street: 'Rua A' },
    'usersAdmin/uid-adm-antigo': { isAdmin: true },
    'estabelecimentos/loja-1': { id: 'loja-1', name: 'Loja 1', userReference: ref('Users/loja-1'), whitelabelId: 'wl', isActive: true },
    'estabelecimentos/loja-2': { id: 'loja-2', name: 'Loja 2', userReference: ref('Users/u-dono2'), isActive: true },
    'estabelecimentos/loja-1/PermissionGroups/g-admin': { isAdmin: true, permissions: [] },
    'estabelecimentos/loja-1/PurchaseRequests/sp1': { currentPurchaseStatus: 'pending' },
    'PurchaseRequests/p1': {
      clientId: 'u-cli', clientReference: ref('Users/u-cli'), companyReference: ref('estabelecimentos/loja-1'),
      currentPurchaseStatus: 'pending', statusList: [], createdAt: quando,
    },
    'PurchaseRequests/p2': {
      clientId: 'u-outro', clientReference: ref('Users/u-outro'), companyReference: ref('estabelecimentos/loja-2'),
      currentPurchaseStatus: 'pending', statusList: [], createdAt: quando,
    },
    // p3: só para o ataque que troca a loja (hoje passa e mudaria o p1 dos outros casos).
    'PurchaseRequests/p3': { clientId: 'u-cli', companyReference: ref('estabelecimentos/loja-1'), currentPurchaseStatus: 'pending', createdAt: quando },
    'PurchaseRequests/p1/AuditLog/a1': { companyReference: ref('estabelecimentos/loja-1'), action: 'item_trocado' },
    // Conversas nos três formatos de produção: cliente -> loja, uid do lojista -> cliente, de outra loja.
    'Chats/c1': { senderId: 'u-cli', receiverId: 'loja-1', purchaseReference: ref('PurchaseRequests/p1'), deletedAt: null, createdAt: quando },
    'Chats/c2': { senderId: 'uid-dono1', receiverId: 'u-cli', purchaseReference: ref('PurchaseRequests/p1'), deletedAt: null, createdAt: quando },
    'Chats/c3': { senderId: 'u-outro', receiverId: 'loja-2', purchaseReference: ref('PurchaseRequests/p2'), deletedAt: null, createdAt: quando },
    'Chats/c1/Messages/m1': { senderId: 'u-cli', text: 'oi', createdAt: quando },
  };
  const lote = banco.batch();
  Object.entries(docs).forEach(([caminho, dados]) => lote.set(ref(caminho), dados));
  await lote.commit();
}

const TOKENS = {
  cliente: { sub: 'uid-cli', firebase: { sign_in_provider: 'phone' } },
  outroCliente: { sub: 'uid-outro', firebase: { sign_in_provider: 'phone' } },
  anonimo: { sub: 'uid-anon', firebase: { sign_in_provider: 'anonymous' } },
  dono1: { sub: 'uid-dono1', adminOf: 'loja-1', groupId: 'g-admin' },
  funcionario1: { sub: 'uid-func1', adminOf: 'loja-1', groupId: 'g-func' },
  dono1SemClaim: { sub: 'uid-dono1' },
  dono2: { sub: 'uid-dono2', adminOf: 'loja-2', groupId: 'g-admin' },
  consultor: { sub: 'uid-consultor' },
  interno: { sub: 'uid-interno', internal: true, firebase: { sign_in_provider: 'password' } },
  contaQualquer: { sub: 'uid-qualquer', firebase: { sign_in_provider: 'password' } },
  adminAntigo: { sub: 'uid-adm-antigo', firebase: { sign_in_provider: 'password' } },
};

let contadorDeApps = 0;
function conectar(quem) {
  const app = initializeApp({ projectId: PROJETO, apiKey: 'demo' }, `app-${(contadorDeApps += 1)}`);
  const db = fs.getFirestore(app);
  fs.connectFirestoreEmulator(db, hostname, Number(porta), TOKENS[quem] ? { mockUserToken: TOKENS[quem] } : {});
  return { app, db };
}

const { collection, collectionGroup, doc, getDoc, getDocs, getCountFromServer, query, where, orderBy, limit, updateDoc, setDoc, addDoc, writeBatch, arrayUnion, serverTimestamp } = fs;
const loja = (db, id) => doc(db, 'estabelecimentos', id);
const pedido = (db, id) => doc(db, 'PurchaseRequests', id);

// [repositório, uso (arquivo:linha), quem, hoje, proposta, operação]
// hoje/proposta: true = permitido, false = negado.
let novo = 0;
const id = (prefixo) => `${prefixo}-${(novo += 1)}`;
const CASOS = [
  // ---- app cliente (mobile_cliente + mobile_core; marcas usam o mesmo código) ----
  ['app cliente', 'purchases_status_running_controller.dart:21 (pedidos em andamento)', 'cliente', true, true,
    (db) => getDocs(query(collection(db, 'PurchaseRequests'), where('clientId', '==', 'u-cli'), where('currentPurchaseStatus', 'in', ['pending', 'accepted'])))],
  ['app cliente', 'purchases_from_firebase_impl.dart:17,44 (lista de pedidos)', 'cliente', true, true,
    (db) => getDocs(query(collection(db, 'PurchaseRequests'), where('clientId', '==', 'u-cli')))],
  ['app cliente', 'checkout_repository_impl.dart:13 (acompanhar pedido)', 'cliente', true, true, (db) => getDoc(pedido(db, 'p1'))],
  ['app cliente', 'checkout_repository_impl.dart:37-45 (cria pedido e apaga carrinho no mesmo lote)', 'cliente', true, true, (db) => {
    const lote = writeBatch(db);
    lote.set(pedido(db, id('novo')), { clientId: 'u-cli', clientReference: doc(db, 'Users', 'u-cli'), companyReference: loja(db, 'loja-1'), currentPurchaseStatus: 'pending', createdAt: serverTimestamp() });
    lote.delete(doc(db, 'Users', 'u-cli', 'ShoppingCart', 'loja-1'));
    return lote.commit();
  }],
  ['app cliente', 'pedido do Users da outra marca (um uid, um Users por whitelabel)', 'cliente', true, true,
    (db) => setDoc(pedido(db, id('wl2')), { clientId: 'u-cli-wl2', companyReference: loja(db, 'loja-1'), currentPurchaseStatus: 'pending' })],
  ['app cliente', 'purchase_firebase_repository_impl.dart:29-32 (cancelar)', 'cliente', true, true,
    (db) => updateDoc(pedido(db, 'p1'), { currentPurchaseStatus: 'canceled', cancelReason: 'desisti', statusList: arrayUnion({ status: 'canceled' }) })],
  ['app cliente', 'review_purchase_service.dart:11-18 (avaliar)', 'cliente', true, true, (db) => updateDoc(pedido(db, 'p1'), { review: { rating: 5 } })],
  ['app cliente', 'chat_purchase_service.dart:12-15 (liga conversa ao pedido)', 'cliente', true, true, (db) => updateDoc(pedido(db, 'p1'), { chatReference: doc(db, 'Chats', 'c1') })],
  ['app cliente', 'delete_account_controller.dart:106-134 (conta por clientId = uid)', 'cliente', true, true,
    (db) => getCountFromServer(query(collection(db, 'PurchaseRequests'), where('clientId', '==', 'uid-cli')))],
  ['app cliente', 'chat_purchase_service.dart:19-29 (abre a conversa do pedido)', 'cliente', true, true, (db) => getDoc(doc(db, 'Chats', 'c1'))],
  ['app cliente', 'chat_purchase_service.dart:33-46 (procura conversa só pelo pedido)', 'cliente', true, true,
    (db) => getDocs(query(collection(db, 'Chats'), where('purchaseReference', '==', pedido(db, 'p1'))))],
  ['app cliente', 'chat_purchase_service.dart:74-79 (cria conversa)', 'cliente', true, true,
    (db) => setDoc(doc(db, 'Chats', id('chat')), { senderId: 'u-cli', receiverId: 'loja-1', purchaseReference: pedido(db, 'p1'), deletedAt: null })],
  ['mobile_core', 'chat_repository_impl.dart:85-97 (lista, senderId)', 'cliente', true, true,
    (db) => getDocs(query(collection(db, 'Chats'), where('senderId', '==', 'u-cli')))],
  ['mobile_core', 'chat_repository_impl.dart:85-97 (lista, receiverId)', 'cliente', true, true,
    (db) => getDocs(query(collection(db, 'Chats'), where('receiverId', '==', 'u-cli')))],
  ['mobile_core', 'chat_repository_impl.dart:33-50 (findOrCreate)', 'cliente', true, true,
    (db) => getDocs(query(collection(db, 'Chats'), where('deletedAt', '==', null), where('senderId', '==', 'u-cli'), where('receiverId', '==', 'loja-1'), where('purchaseReference', '==', pedido(db, 'p1'))))],
  ['mobile_core', 'chat_repository_impl.dart:10-22 (mensagens)', 'cliente', true, true,
    (db) => getDocs(query(collection(db, 'Chats', 'c1', 'Messages'), orderBy('createdAt')))],
  ['mobile_core', 'chat_repository_impl.dart:160-175 (envia mensagem)', 'cliente', true, true, (db) => {
    const lote = writeBatch(db);
    lote.update(doc(db, 'Chats', 'c1'), { lastMessage: 'oi', updatedAt: serverTimestamp() });
    lote.set(doc(db, 'Chats', 'c1', 'Messages', id('m')), { senderId: 'u-cli', text: 'oi' });
    return lote.commit();
  }],
  ['app cliente', 'user_service.dart:109-126 (acha o próprio Users)', 'cliente', true, true,
    (db) => getDocs(query(collection(db, 'Users'), where('userAuthId', '==', 'uid-cli'), where('whitelabelId', '==', 'wl')))],
  ['app cliente', 'user_service.dart:23,54 (cria Users com id aleatório)', 'cliente', true, true,
    (db) => { const novoId = id('u'); return setDoc(doc(db, 'Users', novoId), { id: novoId, userAuthId: 'uid-cli', whitelabelId: 'wl3' }); }],
  ['app cliente', 'user_authenticated_controller.dart:50 (escuta o próprio Users)', 'cliente', true, true, (db) => getDoc(doc(db, 'Users', 'u-cli'))],
  ['app cliente', 'login_controller.dart:93 (grava packageName e userType)', 'cliente', true, true, (db) => updateDoc(doc(db, 'Users', 'u-cli'), { packageName: 'x', userType: 'UserType.cliente' })],
  ['app cliente', 'address_services_impl.dart:32-44 (endereços)', 'cliente', true, true, (db) => getDocs(collection(db, 'Users', 'u-cli', 'Addresses'))],
  ['app cliente', 'whitelabel get_company_info_service.dart:6-18 (boot anônimo, loja da marca)', 'anonimo', true, true,
    (db) => getDocs(query(collection(db, 'estabelecimentos'), where('whitelabelId', '==', 'wl')))],
  ['app cliente', 'user_service.dart:109 com a conta anônima da marca', 'anonimo', true, true,
    (db) => getDocs(query(collection(db, 'Users'), where('userAuthId', '==', 'uid-anon')))],
  // ---- o que a proposta fecha ----
  ['ataque', 'outro cliente lê o pedido de alguém pelo id', 'outroCliente', true, false, (db) => getDoc(pedido(db, 'p1'))],
  ['ataque', 'conta anônima da marca lê pedido de alguém', 'anonimo', true, false, (db) => getDoc(pedido(db, 'p1'))],
  ['ataque', 'qualquer conta lista todos os pedidos', 'contaQualquer', true, false, (db) => getDocs(collection(db, 'PurchaseRequests'))],
  ['ataque', 'cliente lista pedidos de outro clientId', 'cliente', true, false,
    (db) => getDocs(query(collection(db, 'PurchaseRequests'), where('clientId', '==', 'u-outro')))],
  ['ataque', 'cliente cria pedido em nome de outro Users', 'cliente', true, false,
    (db) => setDoc(pedido(db, id('forjado')), { clientId: 'u-outro', companyReference: loja(db, 'loja-1'), currentPurchaseStatus: 'pending' })],
  ['ataque', 'cliente troca a loja do próprio pedido', 'cliente', true, false, (db) => updateDoc(pedido(db, 'p3'), { companyReference: loja(db, 'loja-2') })],
  ['ataque', 'outro cliente lê as mensagens da conversa', 'outroCliente', true, false, (db) => getDocs(collection(db, 'Chats', 'c1', 'Messages'))],
  ['ataque', 'outro cliente procura a conversa pelo pedido', 'outroCliente', true, false,
    (db) => getDocs(query(collection(db, 'Chats'), where('purchaseReference', '==', pedido(db, 'p1'))))],
  ['ataque', 'outro cliente lê o Users (telefone, e-mail) de alguém', 'outroCliente', true, false, (db) => getDoc(doc(db, 'Users', 'u-cli'))],
  ['ataque', 'outra loja lê pedido que não é dela', 'dono2', true, false, (db) => getDoc(pedido(db, 'p1'))],
  ['ataque', 'outra loja lista pedidos de outra loja', 'dono2', true, false,
    (db) => getDocs(query(collection(db, 'PurchaseRequests'), where('companyReference', '==', loja(db, 'loja-1'))))],
  ['ataque', 'qualquer conta lê AuditLog de todas as lojas', 'contaQualquer', true, false, (db) => getDocs(collectionGroup(db, 'AuditLog'))],
  // ---- app Gerenciador (mobile_gerenciador + mobile_core) ----
  ['app Gerenciador', 'firebase_purchases_repository_impl.dart:14-23 (pedidos da loja)', 'dono1', true, true,
    (db) => getDocs(query(collection(db, 'PurchaseRequests'), where('companyReference', '==', loja(db, 'loja-1'))))],
  ['app Gerenciador', 'firebase_purchases_repository_impl.dart:37-47 (lista ordenada)', 'dono1', true, true,
    (db) => getDocs(query(collection(db, 'PurchaseRequests'), where('companyReference', '==', loja(db, 'loja-1')), orderBy('createdAt', 'desc')))],
  ['app Gerenciador', 'home_page.dart:78-86 (contador de pendentes)', 'dono1', true, true,
    (db) => getDocs(query(collection(db, 'PurchaseRequests'), where('currentPurchaseStatus', '==', 'pending'), where('companyReference', '==', loja(db, 'loja-1'))))],
  ['app Gerenciador', 'request_checker_services.dart:9-27 (conta por companyId)', 'dono1', true, true,
    (db) => getCountFromServer(query(collection(db, 'PurchaseRequests'), where('companyId', '==', 'loja-1'), where('currentPurchaseStatus', 'in', ['pending', 'accepted'])))],
  ['app Gerenciador', 'firebase_purchases_repository_impl.dart:76-86 (detalhe pelo id)', 'dono1', true, true, (db) => getDoc(pedido(db, 'p1'))],
  ['app Gerenciador', 'request_status_controller.dart:170 (status e entregador)', 'dono1', true, true,
    (db) => updateDoc(pedido(db, 'p1'), { currentPurchaseStatus: 'accepted', statusList: arrayUnion({ status: 'accepted' }), deliveryPerson: { name: 'Ana' } })],
  ['app Gerenciador', 'request_status_controller.dart:170 por funcionário com adminOf', 'funcionario1', true, true,
    (db) => updateDoc(pedido(db, 'p1'), { currentPurchaseStatus: 'separating' })],
  ['app Gerenciador', 'audit_log_repository.dart:12-16 (collectionGroup AuditLog)', 'dono1', true, true,
    (db) => getDocs(query(collectionGroup(db, 'AuditLog'), where('companyReference', '==', loja(db, 'loja-1'))))],
  ['app Gerenciador', 'audit_log_repository.dart:24-29 (AuditLog do pedido)', 'dono1', true, true, (db) => getDocs(collection(db, 'PurchaseRequests', 'p1', 'AuditLog'))],
  ['app Gerenciador', 'request_details_controller.dart:186 (findOrCreate, senderId = Users do dono)', 'dono1', true, true,
    (db) => getDocs(query(collection(db, 'Chats'), where('deletedAt', '==', null), where('senderId', '==', 'loja-1'), where('receiverId', '==', 'u-cli'), where('purchaseReference', '==', pedido(db, 'p1'))))],
  ['app Gerenciador', 'open_chat_controller.dart:24,38 (cria conversa, senderId = uid)', 'dono1', true, true,
    (db) => setDoc(doc(db, 'Chats', id('chat')), { senderId: 'uid-dono1', receiverId: 'u-cli', purchaseReference: pedido(db, 'p1'), deletedAt: null })],
  ['mobile_core', 'chats_controller.dart:56,72 (lista do lojista, senderId = Users)', 'dono1', true, true,
    (db) => getDocs(query(collection(db, 'Chats'), where('senderId', '==', 'loja-1')))],
  ['mobile_core', 'chats_controller.dart:56,72 (lista do lojista, senderId = uid)', 'dono1', true, true,
    (db) => getDocs(query(collection(db, 'Chats'), where('senderId', '==', 'uid-dono1')))],
  ['mobile_core', 'chat_repository_impl.dart:10-22 (mensagens, lojista)', 'dono1', true, true, (db) => getDocs(collection(db, 'Chats', 'c1', 'Messages'))],
  ['app Gerenciador', 'auth_repository_impl.dart:19-35 (login: Users por userAuthId)', 'dono1', true, true,
    (db) => getDocs(query(collection(db, 'Users'), where('userAuthId', '==', 'uid-dono1'), limit(1)))],
  ['app Gerenciador', 'company_services.dart:9-21 (loja por userReference)', 'dono1', true, true,
    (db) => getDocs(query(collection(db, 'estabelecimentos'), where('userReference', '==', doc(db, 'Users', 'loja-1')), limit(1)))],
  ['app Gerenciador', 'companies_services.dart:11-24 (consultor: próprio Users e lojas)', 'consultor', true, true, (db) => getDoc(doc(db, 'Users', 'u-consultor'))],
  ['app Gerenciador', 'lojista sem claim adminOf: pedidos da loja', 'dono1SemClaim', true, false,
    (db) => getDocs(query(collection(db, 'PurchaseRequests'), where('companyReference', '==', loja(db, 'loja-1'))))],
  ['app Gerenciador', 'lojista sem claim adminOf: conversas (Users com id da loja)', 'dono1SemClaim', true, true,
    (db) => getDocs(query(collection(db, 'Chats'), where('receiverId', '==', 'loja-1')))],
  ['app Gerenciador', 'register_user_service.dart:84-90 (e-mail já existe? lê Users de terceiros)', 'contaQualquer', true, false,
    (db) => getDocs(query(collection(db, 'Users'), where('email', '==', 'dono1@x.com'), where('userType', '==', 'UserType.empresa')))],
  // ---- web antiga (web_gerenciador) ----
  ['web antiga', 'Pedidos.jsx:410-419 / FCMListener.jsx:224-232', 'dono1', true, true,
    (db) => getDocs(query(collection(db, 'PurchaseRequests'), where('companyReference', '==', loja(db, 'loja-1')), orderBy('createdAt', 'desc')))],
  ['web antiga', 'Pedidos.jsx:237-239 (status)', 'dono1', true, true, (db) => updateDoc(pedido(db, 'p1'), { currentPurchaseStatus: 'delivered', statusList: arrayUnion({ status: 'delivered' }) })],
  ['web antiga', 'Pedidos.jsx:531-532 (Users do cliente: telefone, e-mail)', 'dono1', true, false, (db) => getDoc(doc(db, 'Users', 'u-cli'))],
  ['web antiga', 'Mensagens.jsx:152-158 (pedidos do cliente em todas as lojas)', 'dono1', true, false,
    (db) => getDocs(query(collection(db, 'PurchaseRequests'), where('clientId', '==', 'u-cli')))],
  ['web antiga', 'Mensagens.jsx:367-369 (conversas: senderId/receiverId = loja)', 'dono1', true, true,
    (db) => getDocs(query(collection(db, 'Chats'), where('receiverId', '==', 'loja-1')))],
  ['web antiga', 'Mensagens.jsx:499-513 (envia mensagem como loja)', 'dono1', true, true, (db) => addDoc(collection(db, 'Chats', 'c1', 'Messages'), { senderId: 'loja-1', text: 'ok' })],
  ['web antiga', 'Navbar.jsx:206-213 (estabelecimentos/{id}/PurchaseRequests)', 'dono1', true, true,
    (db) => getDocs(query(collection(db, 'estabelecimentos', 'loja-1', 'PurchaseRequests'), where('currentPurchaseStatus', '==', 'pending')))],
  ['web antiga', 'estabelecimentos/{id}/PurchaseRequests de outra loja', 'dono2', true, false,
    (db) => getDocs(collection(db, 'estabelecimentos', 'loja-1', 'PurchaseRequests'))],
  ['web antiga', 'Login.jsx:71-73 (Users por userAuthId)', 'dono1', true, true,
    (db) => getDocs(query(collection(db, 'Users'), where('userAuthId', '==', 'uid-dono1')))],
  // ---- agente (agente_mobile_mercado_web) ----
  ['agente', 'firestore.ts:604-605 (convidado anônimo cria pedido com o Users dele)', 'anonimo', true, true,
    (db) => setDoc(pedido(db, id('agente')), { clientId: 'u-anon', companyReference: loja(db, 'loja-1'), currentPurchaseStatus: 'pending' })],
  ['agente', 'firestore.ts:1030-1038 (meus pedidos na loja)', 'cliente', true, true,
    (db) => getDocs(query(collection(db, 'PurchaseRequests'), where('companyReference', '==', loja(db, 'loja-1')), where('clientId', '==', 'u-cli')))],
  ['agente', 'admin/page.tsx:88 / firestore.ts:1014 ("admin" do agente: qualquer login lê a loja)', 'cliente', true, false,
    (db) => getDocs(query(collection(db, 'PurchaseRequests'), where('companyReference', '==', loja(db, 'loja-1'))))],
  ['agente', 'firestore.ts:1046-1049 ("admin" do agente muda status de pedido alheio)', 'outroCliente', true, false,
    (db) => updateDoc(pedido(db, 'p1'), { currentPurchaseStatus: 'accepted' })],
  ['agente', 'admin do agente com claim adminOf da loja', 'dono1', true, true,
    (db) => getDocs(query(collection(db, 'PurchaseRequests'), where('companyReference', '==', loja(db, 'loja-1'))))],
  // ---- painel interno (web_gerenciador_plus/public/painel_experiencia) ----
  ['painel interno', 'index.html:321 (pedidos de todas as lojas) sem claim internal', 'contaQualquer', true, false,
    (db) => getDocs(query(collection(db, 'PurchaseRequests'), where('createdAt', '>=', new Date('2026-01-01'))))],
  ['painel interno', 'index.html:321 com claim internal', 'interno', true, true,
    (db) => getDocs(query(collection(db, 'PurchaseRequests'), where('createdAt', '>=', new Date('2026-01-01'))))],
  ['painel interno', 'index.html:326 (conversas) com claim internal', 'interno', true, true,
    (db) => getDocs(query(collection(db, 'Chats'), where('createdAt', '>=', new Date('2026-01-01'))))],
  ['painel interno', 'index.html:574 (carrinho do cliente) com claim internal', 'interno', false, true,
    (db) => getDocs(collection(db, 'Users', 'u-cli', 'ShoppingCart', 'loja-1', 'Items'))],
  // ---- admin antigo (mobile_old_web_platform) ----
  ['admin antigo', 'gerents-service.ts:19 (consultores em Users)', 'adminAntigo', true, false,
    (db) => getDocs(query(collection(db, 'Users'), where('userType', '==', 'UserType.consultor')))],
  ['admin antigo', 'company-detail-dialog.component.ts:229 (atualiza loja; já negado hoje)', 'adminAntigo', false, false,
    (db) => updateDoc(loja(db, 'loja-1'), { name: 'x' })],
];

async function rodar(conjunto) {
  await carregarRegras(conjunto.regras);
  await semear();
  const apps = new Map();
  const resultados = [];
  for (const [repo, uso, quem, ...esperados] of CASOS) {
    const operacao = esperados.at(-1);
    if (!apps.has(quem)) apps.set(quem, conectar(quem));
    let permitido = true;
    let erro = '';
    try {
      await operacao(apps.get(quem).db);
    } catch (falha) {
      permitido = false;
      erro = falha.code || falha.message;
      if (erro !== 'permission-denied') throw new Error(`${uso}: erro inesperado ${erro}`);
    }
    resultados.push({ repo, uso, quem, permitido, erro });
  }
  await Promise.all([...apps.values()].map(({ app }) => deleteApp(app)));
  return resultados;
}

const porConjunto = {};
for (const conjunto of conjuntos) porConjunto[conjunto.nome] = await rodar(conjunto);

const sim = (valor) => (valor ? 'permite' : 'NEGA');
let falhas = 0;
console.log('| repositório | uso | quem | hoje | proposta | confere |');
console.log('|---|---|---|---|---|---|');
CASOS.forEach(([repo, uso, quem, hoje, proposta], indice) => {
  const obtidoHoje = porConjunto.hoje[indice].permitido;
  const obtidoProposta = porConjunto.proposta[indice].permitido;
  const confere = obtidoHoje === hoje && obtidoProposta === proposta;
  if (!confere) falhas += 1;
  console.log(`| ${repo} | ${uso} | ${quem} | ${sim(obtidoHoje)} | ${sim(obtidoProposta)} | ${confere ? 'ok' : `ESPERADO hoje ${sim(hoje)} / proposta ${sim(proposta)}`} |`);
});
console.log(`\n${CASOS.length} casos, ${falhas} fora do esperado.`);
process.exitCode = falhas ? 1 : 0;
