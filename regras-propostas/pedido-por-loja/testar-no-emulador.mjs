// Testa a regra nova do PurchaseRequests (proposta B57-18d, item 5; testes pedidos na B57-18h,
// item 2) contra as regras de hoje (firestore.rules da branch) e a proposta desta pasta.
// Roda só no emulador do Firestore, com projeto demo-*: nada chega à produção.
//
//   npx firebase-tools@15.30.0 emulators:exec --only firestore --project demo-regras-b57 \
//     "node regras-propostas/pedido-por-loja/testar-no-emulador.mjs"
//
// Parte A: os 14 testes da proposta. Parte B: uma gravação por linha da tabela "O que o app do
// cliente grava no pedido", copiando a operação e os campos do mobile_cliente e do mobile_core.
// O SDK web do Firebase vem de ../web_gerenciador_plus/node_modules (FIREBASE_WEB_SDK_DIR muda).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const raiz = path.resolve(aqui, '../..');
const PROJETO = process.env.GCLOUD_PROJECT || 'demo-regras-b57';
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
const { getFirestore: getAdminFirestore, Timestamp: TimestampAdmin } = servidor('firebase-admin/firestore');
const banco = getAdminFirestore(admin);

const regrasHoje = readFileSync(path.join(raiz, 'firestore.rules'), 'utf8');
const regrasProposta = readFileSync(path.join(aqui, 'firestore.rules'), 'utf8');

async function carregarRegras(texto) {
  const resposta = await fetch(`http://${HOST}/emulator/v1/projects/${PROJETO}:securityRules`, {
    method: 'PUT',
    body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: texto }] } }),
  });
  if (!resposta.ok) throw new Error(`Regras recusadas pelo emulador: ${await resposta.text()}`);
}

const S = (s) => `PurchaseStatus.${s}`;

// ---------- sementes (Admin SDK, o emulador não aplica as regras a ele) ----------
const quando = TimestampAdmin.fromDate(new Date('2026-11-28T12:00:00Z'));
const refA = (caminho) => banco.doc(caminho);
// Pedido como o PurchaseAdapter.toMap grava (mobile_core purchase_adapter.dart:84-131).
function pedidoSemente({ id, clientId, clientDoc = clientId, status, extra = {}, loja = 'loja-1' }) {
  return {
    id, orderNumber: '1234', clientId, clientName: 'Cliente', clientePhoneNumber: '27999990000', codeConfirmation: '',
    documentInNote: null, price: 2000, deliveryPrice: 500, total: 2500, discountValue: 0, appliedCoupons: [],
    address: { street: 'Rua A', number: '1' }, productsCart: [{ productId: 'prod-1', quantity: 1, price: 2000 }],
    purchasePayment: { paymentType: 'PaymentType.money', paymentValue: null, valueBack: null, provider: null, mode: null,
      paymentStatus: null, chargeId: null, transactionId: null, copyPasteKey: null, qrCodeBase64: null, pixExpiresAt: null,
      authorizationCode: null, responseCode: null, responseMessage: null, chargedAmount: null },
    scheduling: quando, statusList: [{ purchaseStatus: S(status), createdAt: quando }], chatReference: null,
    companyReference: refA(`estabelecimentos/${loja}`), clientReference: refA(`Users/${clientDoc}`),
    currentPurchaseStatus: S(status), cancelReason: null, deliveryPerson: null, companyName: '', companyAddress: '',
    companyImageUrl: '', review: null, createdAt: quando, updatedAt: null, estimatedTimeDelivery: null, schedule: null,
    ...extra,
  };
}
// Pedido em waitingForOrderPayment depois do cartão recusado: o que o app gravou (saveAwaitingPayment)
// mais o que a API SafraPay gravou (cobrancaCartao).
const recusado = {
  purchasePayment: { paymentType: 'PaymentType.creditcard', paymentValue: 2500, valueBack: null, provider: 'safrapay', mode: 'app',
    paymentStatus: 'paymentDenied', chargeId: 'ch-1', transactionId: null, copyPasteKey: null, qrCodeBase64: null, pixExpiresAt: null,
    authorizationCode: null, responseCode: '51', responseMessage: 'Recusada', chargedAmount: null },
  pagamentoExpiraEm: quando, cobrancaCartao: { status: 'recusada', em: quando },
};
const pixAguardando = {
  purchasePayment: { paymentType: 'PaymentType.pix', paymentValue: 2500, valueBack: null, provider: 'safrapay', mode: 'app',
    paymentStatus: 'pending', chargeId: 'ch-pix', transactionId: 'tx-pix', copyPasteKey: '000201...', qrCodeBase64: 'iVBOR...',
    pixExpiresAt: quando, authorizationCode: null, responseCode: null, responseMessage: null, chargedAmount: 2500 },
  pagamentoExpiraEm: quando,
};

const BASE = {
  'Users/u-cli': { id: 'u-cli', userAuthId: 'uid-cli' },
  'Users/u-outro': { id: 'u-outro', userAuthId: 'uid-outro' },
  'Users/uid-velho': { id: 'uid-velho', userAuthId: 'uid-velho' },
  'Users/u-lc': { id: 'u-lc', userAuthId: 'uid-lc' },
  'Users/loja-1': { id: 'loja-1', userAuthId: 'uid-dono1' },
  'Users/u-dono2': { id: 'u-dono2', userAuthId: 'uid-dono2' },
  'estabelecimentos/loja-1': { id: 'loja-1', name: 'Loja 1', userReference: refA('Users/loja-1'), isActive: true },
  'estabelecimentos/loja-2': { id: 'loja-2', name: 'Loja 2', userReference: refA('Users/u-dono2'), isActive: true },
  'estabelecimentos/loja-1/AdminUsers/uid-func1': { active: true },
  'estabelecimentos/loja-1/AdminUsers/uid-func-inativo': { active: false },
  'estabelecimentos/loja-1/AdminUsers/uid-func-semgrupo': { active: true },
  'estabelecimentos/loja-2/AdminUsers/uid-func2': { active: true },
  'Users/u-cli/ShoppingCart/loja-1': { companyRef: refA('estabelecimentos/loja-1') },
  'Users/uid-velho/ShoppingCart/loja-1': { companyRef: refA('estabelecimentos/loja-1') },
  'Chats/chat-existente': { senderId: 'u-cli', receiverId: 'loja-1', deletedAt: null },
};

async function semear(casos) {
  await fetch(`http://${HOST}/emulator/v1/projects/${PROJETO}/databases/(default)/documents`, { method: 'DELETE' });
  const docs = { ...BASE };
  for (const c of casos) if (c.semente) docs[`PurchaseRequests/${c.pedido}`] = c.semente(c.pedido);
  const lote = banco.batch();
  Object.entries(docs).forEach(([caminho, dados]) => lote.set(banco.doc(caminho), dados));
  await lote.commit();
}

const TOKENS = {
  dono1: { sub: 'uid-dono1', adminOf: 'loja-1', groupId: 'g-admin' },
  func1: { sub: 'uid-func1', adminOf: 'loja-1', groupId: 'g-sep' },
  funcInativo: { sub: 'uid-func-inativo', adminOf: 'loja-1', groupId: 'g-sep' },
  funcSemAdminUsers: { sub: 'uid-func-sem-doc', adminOf: 'loja-1', groupId: 'g-sep' },
  funcSemGrupo: { sub: 'uid-func-semgrupo', adminOf: 'loja-1' },
  funcOutraLoja: { sub: 'uid-func2', adminOf: 'loja-2', groupId: 'g-sep' },
  cliente: { sub: 'uid-cli', firebase: { sign_in_provider: 'phone' } },
  outroCliente: { sub: 'uid-outro', firebase: { sign_in_provider: 'phone' } },
  velho: { sub: 'uid-velho', firebase: { sign_in_provider: 'phone' } },
  // Pior caso de leituras: claim da loja sem AdminUsers e sem ser o dono, e cliente do pedido.
  lojistaCliente: { sub: 'uid-lc', adminOf: 'loja-1', groupId: 'g-sep' },
};

let contadorDeApps = 0;
function conectar(quem) {
  const app = initializeApp({ projectId: PROJETO, apiKey: 'demo' }, `app-${(contadorDeApps += 1)}`);
  const db = fs.getFirestore(app);
  fs.connectFirestoreEmulator(db, hostname, Number(porta), { mockUserToken: TOKENS[quem] });
  return { app, db };
}

const { doc, collection, updateDoc, setDoc, writeBatch, runTransaction, arrayUnion, serverTimestamp, Timestamp } = fs;

// Pedido inteiro como o app grava (PurchaseAdapter.toMap), pelo SDK do cliente.
function pedidoDoApp(db, { id, clientId, status, pagamento }) {
  const agora = Timestamp.now();
  return {
    id, orderNumber: '', clientId, clientName: 'Cliente', clientePhoneNumber: '27999990000', codeConfirmation: '',
    documentInNote: null, price: 2000, deliveryPrice: 500, total: 2500, discountValue: 0, appliedCoupons: [],
    address: { street: 'Rua A', number: '1' }, productsCart: [{ productId: 'prod-1', quantity: 1, price: 2000 }],
    purchasePayment: { paymentType: pagamento, paymentValue: null, valueBack: null, provider: null, mode: null,
      paymentStatus: null, chargeId: null, transactionId: null, copyPasteKey: null, qrCodeBase64: null, pixExpiresAt: null,
      authorizationCode: null, responseCode: null, responseMessage: null, chargedAmount: null },
    scheduling: agora, statusList: [{ purchaseStatus: S(status), createdAt: agora }], chatReference: null,
    companyReference: doc(db, 'estabelecimentos', 'loja-1'), clientReference: doc(db, 'Users', clientId),
    currentPurchaseStatus: S(status), cancelReason: null, deliveryPerson: null, companyName: '', companyAddress: '',
    companyImageUrl: '', review: null, createdAt: agora, updatedAt: null,
    estimatedTimeDelivery: { date: agora, intervalMinutes: 30 }, schedule: null, modoRecebimento: 'entrega',
  };
}

// ---------- gravações exatas do app do cliente ----------
// checkout_repository_impl.dart:60-72: batch.set (sem merge) do pedido inteiro + delete do carrinho.
const checkoutPagoNaEntrega = (clientId) => (db, ref) => {
  const lote = writeBatch(db);
  lote.set(ref, pedidoDoApp(db, { id: ref.id, clientId, status: 'pending', pagamento: 'PaymentType.money' }));
  lote.delete(doc(db, 'Users', clientId, 'ShoppingCart', 'loja-1'));
  return lote.commit();
};
// checkout_repository_impl.dart:112-126 (app_paid_order_flow.dart:130): transação, relê o status e
// transaction.set com merge do pedido inteiro em waitingForOrderPayment + pagamentoExpiraEm.
const salvarAguardandoPagamento = (clientId, pagamento) => (db, ref) => runTransaction(db, async (t) => {
  const atual = await t.get(ref);
  const status = atual.data()?.currentPurchaseStatus;
  if (atual.exists() && status !== S('waitingForOrderPayment')) throw new Error(`app não grava: status ${status}`);
  t.set(ref, { ...pedidoDoApp(db, { id: ref.id, clientId, status: 'waitingForOrderPayment', pagamento }),
    pagamentoExpiraEm: Timestamp.fromDate(new Date(Date.now() + 15 * 60000)) }, { merge: true });
});
// checkout_repository_impl.dart:138-150 (app_paid_order_flow.dart:150): update com
// purchasePayment.<campo> para cada campo não nulo do PurchasePaymentAdapter.toMap.
const resultadoPix = { paymentType: 'PaymentType.pix', paymentValue: 2500, provider: 'safrapay', mode: 'app', paymentStatus: 'pending',
  chargeId: 'ch-pix-2', transactionId: 'tx-pix-2', copyPasteKey: '000201...', qrCodeBase64: 'iVBOR...',
  pixExpiresAt: '2026-11-28T12:15:00Z', chargedAmount: 2500 };
const resultadoCartao = { paymentType: 'PaymentType.creditcard', paymentValue: 2500, provider: 'safrapay', mode: 'app',
  paymentStatus: 'paid', chargeId: 'ch-card', transactionId: 'tx-card', authorizationCode: 'A1B2C3', responseCode: '00',
  responseMessage: 'Aprovada', chargedAmount: 2500 };
const updatePurchasePayment = (payment) => (_db, ref) =>
  updateDoc(ref, Object.fromEntries(Object.entries(payment).map(([k, v]) => [`purchasePayment.${k}`, v])));
// safrapay_payment_service.dart:95-102 (toPurchasePaymentUpdate), gravado por
// checkout_repository_impl.dart:130-135 (updatePurchase) ou pix_due_card.dart:318 (_reference.update).
const pagarDeOutraForma = (_db, ref) => updateDoc(ref, {
  'purchasePayment.paymentStatus': 'canceled', 'purchasePayment.responseMessage': 'Cancelado',
  'purchasePayment.responseCode': 'trace-1', 'purchasePayment.chargeId': 'ch-pix',
});
// app_paid_order_flow.dart:303-345 (cancelExpiredPixOrder + pixExpiredCancelFields): transação, relê.
const camposPixVencido = () => {
  const agora = new Date();
  return {
    currentPurchaseStatus: S('canceled'),
    statusList: arrayUnion({ purchaseStatus: S('canceled'), createdAt: Timestamp.fromDate(agora) }),
    motivoEncerramento: 'pix_vencido', encerradoEm: serverTimestamp(), updatedAt: Timestamp.fromDate(agora),
  };
};
const cancelarPixVencido = (_db, ref) => runTransaction(_db, async (t) => {
  const atual = await t.get(ref);
  if (atual.data()?.currentPurchaseStatus !== S('waitingForOrderPayment')) throw new Error('app não grava: status mudou');
  t.update(ref, camposPixVencido());
});
// purchase_firebase_repository_impl.dart:20-54 (cancelPurchase): transação; sem estorno só relê.
const estorno = { 'purchasePayment.paymentStatus': 'refunded', 'purchasePayment.responseMessage': 'Estornado',
  'purchasePayment.responseCode': 'trace-2', 'purchasePayment.chargeId': 'ch-card' };
const desistir = (comEstorno) => (db, ref) => runTransaction(db, async (t) => {
  await t.get(ref);
  t.update(ref, {
    currentPurchaseStatus: S('giveUp'), cancelReason: 'Desisti da compra', updatedAt: Timestamp.now(),
    statusList: arrayUnion({ purchaseStatus: S('giveUp'), createdAt: Timestamp.now() }),
    ...(comEstorno ? estorno : {}),
  });
});
// review_purchase_service.dart:98-110: batch com PurchaseReviews/{id} e o update de review no pedido.
const avaliar = (clientId) => (db, ref) => {
  const review = { id: `rev-${ref.id}`, clientId, companyId: 'loja-1', purchaseRequestId: ref.id, comment: 'Bom',
    stars: 5, isPublic: true, createdAt: Timestamp.now(), updatedAt: null };
  const lote = writeBatch(db);
  lote.set(doc(db, 'PurchaseReviews', review.id), review);
  lote.update(ref, { review });
  return lote.commit();
};
// chat_purchase_service.dart:56-59: conversa já existe, só liga ao pedido.
const ligarConversaExistente = (db, ref) => updateDoc(ref, { chatReference: doc(db, 'Chats', 'chat-existente') });
// chat_purchase_service.dart:62-86: batch com a conversa nova e o chatReference no pedido.
const criarConversa = (clientId) => (db, ref) => {
  const lote = writeBatch(db);
  const nova = doc(collection(db, 'Chats'));
  lote.set(nova, { id: nova.id, senderId: clientId, senderName: 'Cliente', senderProfilePicture: null, senderIsConnected: true,
    receiverId: 'loja-1', receiverName: 'não definido para essa conversa', receiverProfilePicture: '', receiverIsConnected: false,
    createdAt: Timestamp.now(), updatedAt: Timestamp.now(), deletedAt: null, lastMessage: null, purchaseReference: ref });
  lote.update(ref, { chatReference: nova });
  return lote.commit();
};

// ---------- casos ----------
let n = 0;
const CASOS = [];
// semente: status do pedido semeado (null = pedido novo, não existe); cli: dono do pedido semeado.
function caso(teste, nome, quem, hoje, proposta, operacao, { status = 'pending', cli = 'u-cli', extra = {}, loja } = {}) {
  const pedido = `ped-${(n += 1)}`;
  const semente = status === null ? null : (id) => pedidoSemente({ id, clientId: cli, status, extra, loja });
  CASOS.push({ teste, nome, quem, hoje, proposta, operacao, pedido, semente });
}
const upd = (campos) => (_db, ref) => updateDoc(ref, campos);
const statusPelaLoja = (s) => upd({ currentPurchaseStatus: S(s), statusList: arrayUnion({ purchaseStatus: S(s), createdAt: Timestamp.now() }), cancelReason: null });

// Parte A: os 14 testes da proposta.
caso('A1', 'dono: status (aceitar)', 'dono1', true, true, statusPelaLoja('accepted'));
caso('A1', 'dono: itens separados, price, total', 'dono1', true, true,
  upd({ productsCart: [{ productId: 'prod-1', quantity: 2, price: 2000 }], price: 4000, total: 4500, descontoNaSeparacao: 0 }), { status: 'separatingOrder' });
caso('A1', 'dono: nfce', 'dono1', true, true, upd({ nfce: 'https://nfce.sefaz/x' }), { status: 'completed' });
caso('A1', 'dono: pronto para retirar + prontoParaRetirarEm', 'dono1', true, true,
  upd({ currentPurchaseStatus: S('readyForPickup'), statusList: arrayUnion({ purchaseStatus: S('readyForPickup') }), prontoParaRetirarEm: serverTimestamp() }), { status: 'separatingOrder' });
caso('A2', 'funcionário ativo da loja: status', 'func1', true, true, statusPelaLoja('accepted'));
caso('A2', 'funcionário com active: false', 'funcInativo', true, false, statusPelaLoja('accepted'));
caso('A2', 'claim da loja sem AdminUsers (e não é o dono)', 'funcSemAdminUsers', true, false, statusPelaLoja('accepted'));
caso('A2', 'funcionário sem groupId', 'funcSemGrupo', true, false, statusPelaLoja('accepted'));
caso('A2', 'funcionário com claim de outra loja', 'funcOutraLoja', true, false, statusPelaLoja('accepted'));
caso('A3', 'conta qualquer (cliente de outro pedido) muda status', 'outroCliente', true, false, statusPelaLoja('accepted'));
caso('A3', 'conta qualquer muda total', 'outroCliente', true, false, upd({ total: 1 }));
caso('A4', 'dono troca companyReference', 'dono1', true, false, (db, ref) => updateDoc(ref, { companyReference: doc(db, 'estabelecimentos', 'loja-2') }));
caso('A4', 'dono troca clientId', 'dono1', true, false, upd({ clientId: 'u-outro' }));
caso('A4', 'funcionário troca clientReference', 'func1', true, false, (db, ref) => updateDoc(ref, { clientReference: doc(db, 'Users', 'u-outro') }));

function casosDoCliente(prefixo, quem, cli) {
  caso(`${prefixo}5`, 'nova tentativa SafraPay (transação, set merge) em waitingForOrderPayment', quem, true, true,
    salvarAguardandoPagamento(cli, 'PaymentType.creditcard'), { status: 'waitingForOrderPayment', cli, extra: recusado });
  caso(`${prefixo}6`, 'set inteiro sem merge waitingForOrderPayment -> pending (pagar na entrega)', quem, true, true,
    checkoutPagoNaEntrega(cli), { status: 'waitingForOrderPayment', cli, extra: recusado });
  caso(`${prefixo}7`, 'purchasePayment.* em waitingForOrderPayment', quem, true, true, updatePurchasePayment(resultadoPix),
    { status: 'waitingForOrderPayment', cli, extra: pixAguardando });
  caso(`${prefixo}7`, 'purchasePayment.* em pending', quem, true, true, updatePurchasePayment(resultadoCartao), { status: 'pending', cli });
  caso(`${prefixo}8`, 'Pix vencido -> canceled com os 5 campos', quem, true, true, upd(camposPixVencido()),
    { status: 'waitingForOrderPayment', cli, extra: pixAguardando });
  caso(`${prefixo}8`, 'Pix vencido -> canceled de accepted', quem, true, false, upd(camposPixVencido()), { status: 'accepted', cli });
  caso(`${prefixo}9`, 'giveUp de pending sem purchasePayment', quem, true, true, desistir(false), { status: 'pending', cli });
  caso(`${prefixo}9`, 'giveUp de pending com purchasePayment', quem, true, true, desistir(true), { status: 'pending', cli });
  caso(`${prefixo}9`, 'giveUp de completed', quem, true, false, desistir(false), { status: 'completed', cli });
  caso(`${prefixo}10`, 'review sozinho', quem, true, true, upd({ review: { stars: 5 } }), { status: 'completed', cli });
  caso(`${prefixo}10`, 'chatReference sozinho', quem, true, true, ligarConversaExistente, { status: 'accepted', cli });
  caso(`${prefixo}10`, 'review + total', quem, true, false, upd({ review: { stars: 5 }, total: 1 }), { status: 'completed', cli });
}
casosDoCliente('A', 'cliente', 'u-cli');
caso('A11', 'cliente muda currentPurchaseStatus para accepted', 'cliente', true, false, statusPelaLoja('accepted'));
caso('A11', 'cliente grava deliveryPerson', 'cliente', true, false, upd({ deliveryPerson: { name: 'Ana' } }));
casosDoCliente('A12 (clientId = uid) ', 'velho', 'uid-velho');
caso('A13', 'dono: readyForPickup -> accepted (voltaDaRetirada)', 'dono1', false, false, statusPelaLoja('accepted'), { status: 'readyForPickup' });

// Parte B: uma por linha da tabela, com a gravação exata do app.
caso('B1', 'Criar pedido pago na entrega (checkout_repository_impl.dart:70, batch.set + delete do carrinho)', 'cliente', true, true,
  checkoutPagoNaEntrega('u-cli'), { status: null });
caso('B2', 'SafraPay grava antes de cobrar, pedido novo (checkout_repository_impl.dart:121, transação set merge)', 'cliente', true, true,
  salvarAguardandoPagamento('u-cli', 'PaymentType.pix'), { status: null });
caso('B2', 'SafraPay nova tentativa no mesmo pedido, cartão recusado antes (checkout_repository_impl.dart:121)', 'cliente', true, true,
  salvarAguardandoPagamento('u-cli', 'PaymentType.creditcard'), { status: 'waitingForOrderPayment', extra: recusado });
caso('B3', 'Cartão recusado, depois pagar na entrega no mesmo id (checkout_repository_impl.dart:70, set sem merge, waiting -> pending)', 'cliente', true, true,
  checkoutPagoNaEntrega('u-cli'), { status: 'waitingForOrderPayment', extra: recusado });
caso('B4', 'Resultado da cobrança Pix: QR (checkout_repository_impl.dart:149) em waitingForOrderPayment', 'cliente', true, true,
  updatePurchasePayment(resultadoPix), { status: 'waitingForOrderPayment', extra: { pagamentoExpiraEm: quando } });
caso('B4', 'Resultado da cobrança cartão (checkout_repository_impl.dart:149) com a API já em pending', 'cliente', true, true,
  updatePurchasePayment(resultadoCartao), { status: 'pending', extra: { pagamentoExpiraEm: quando, cobrancaCartao: { status: 'aprovada' } } });
caso('B4', 'Resultado da cobrança cartão (checkout_repository_impl.dart:149) ainda em waitingForOrderPayment', 'cliente', true, true,
  updatePurchasePayment({ ...resultadoCartao, paymentStatus: 'paymentProcessing' }), { status: 'waitingForOrderPayment', extra: { pagamentoExpiraEm: quando } });
caso('B5', 'Pix "Pagar de outra forma" no checkout (checkout_repository_impl.dart:134 via checkout_confirmation_controller.dart:936)', 'cliente', true, true,
  pagarDeOutraForma, { status: 'waitingForOrderPayment', extra: pixAguardando });
caso('B5', 'Pix "Pagar de outra forma" em Meus pedidos (pix_due_card.dart:318)', 'cliente', true, true,
  pagarDeOutraForma, { status: 'waitingForOrderPayment', extra: pixAguardando });
caso('B6', 'Pix vencido: cancelar (app_paid_order_flow.dart:342, transação)', 'cliente', true, true,
  cancelarPixVencido, { status: 'waitingForOrderPayment', extra: pixAguardando });
caso('B7', 'Desistir sem estorno de pending (purchase_firebase_repository_impl.dart:53, transação)', 'cliente', true, true,
  desistir(false), { status: 'pending' });
caso('B7', 'Desistir sem estorno de waitingForOrderPayment', 'cliente', true, true,
  desistir(false), { status: 'waitingForOrderPayment', extra: pixAguardando });
caso('B7', 'Desistir com estorno SafraPay de accepted', 'cliente', true, true,
  desistir(true), { status: 'accepted', extra: { purchasePayment: { ...recusado.purchasePayment, paymentStatus: 'paid' } } });
caso('B7', 'Desistir com estorno SafraPay de separatingOrder', 'cliente', true, true,
  desistir(true), { status: 'separatingOrder' });
caso('B8', 'Avaliar pedido entregue (review_purchase_service.dart:109, batch com PurchaseReviews)', 'cliente', true, true,
  avaliar('u-cli'), { status: 'completed' });
caso('B8', 'Avaliar pedido com entrega confirmada', 'cliente', true, true, avaliar('u-cli'), { status: 'deliveryConfirmed' });
caso('B9', 'Abrir conversa já existente (chat_purchase_service.dart:57)', 'cliente', true, true, ligarConversaExistente, { status: 'accepted' });
caso('B9', 'Abrir conversa nova (chat_purchase_service.dart:85, batch com Chats)', 'cliente', true, true, criarConversa('u-cli'), { status: 'deliveryRoute' });

// ---------- execução ----------
async function rodar(regras, casos) {
  await carregarRegras(regras);
  await semear(casos);
  const apps = new Map();
  const resultados = [];
  for (const c of casos) {
    if (!apps.has(c.quem)) apps.set(c.quem, conectar(c.quem));
    const { db } = apps.get(c.quem);
    let permitido = true;
    let erro = '';
    try {
      await c.operacao(db, doc(db, 'PurchaseRequests', c.pedido));
    } catch (falha) {
      permitido = false;
      erro = falha.code || falha.message;
      if (erro !== 'permission-denied') throw new Error(`${c.teste} ${c.nome}: erro inesperado ${erro}`);
    }
    resultados.push(permitido);
  }
  await Promise.all([...apps.values()].map(({ app }) => deleteApp(app)));
  return resultados;
}

const hoje = await rodar(regrasHoje, CASOS);
const proposta = await rodar(regrasProposta, CASOS);

const sim = (valor) => (valor ? 'permite' : 'NEGA');
let falhas = 0;
console.log('| teste | caso | quem | hoje | proposta | resultado |');
console.log('|---|---|---|---|---|---|');
CASOS.forEach((c, i) => {
  const confere = hoje[i] === c.hoje && proposta[i] === c.proposta;
  if (!confere) falhas += 1;
  console.log(`| ${c.teste} | ${c.nome} | ${c.quem} | ${sim(hoje[i])} | ${sim(proposta[i])} | ${confere ? 'passou' : `FALHOU (esperado hoje ${sim(c.hoje)} / proposta ${sim(c.proposta)})`} |`);
});

// A14: leituras. O Firestore aceita até 10 get()/exists() numa gravação de um documento. Uma cópia
// da proposta põe k exists() a mais, de documentos distintos, antes da regra do pedido: o maior k
// que ainda passa mostra quantas leituras a regra faz (10 - k). Esperado: no máximo 4.
function comLeiturasAMais(k) {
  const extras = Array.from({ length: k }, (_, i) => `!exists(/databases/$(database)/documents/Contagem/x${i})`).join(' && ') || 'true';
  const alvo = 'allow update: if request.auth != null && !voltaDaRetirada()\n        && ((ehDaLoja';
  if (!regrasProposta.includes(alvo)) throw new Error('A14: não achei a regra do pedido na proposta');
  return regrasProposta.replace(alvo, `allow update: if request.auth != null && (${extras}) && !voltaDaRetirada()\n        && ((ehDaLoja`);
}
async function medirLeituras(quem, operacao, status) {
  let maiorQuePassa = -1;
  for (let k = 0; k <= 10; k += 1) {
    const casos = [{ teste: 'A14', nome: `k=${k}`, quem, operacao, pedido: `conta-${quem}-${k}`,
      semente: (id) => pedidoSemente({ id, clientId: quem === 'lojistaCliente' ? 'u-lc' : 'u-cli', status }) }];
    const [passou] = await rodar(comLeiturasAMais(k), casos);
    if (passou) maiorQuePassa = k; else break;
  }
  return maiorQuePassa;
}
const kDono = await medirLeituras('dono1', statusPelaLoja('accepted'), 'pending');
const kPior = await medirLeituras('lojistaCliente', upd({ review: { stars: 4 } }), 'completed');
const leituras = (k) => (k === 10 ? 'o emulador não aplicou o teto de 10' : `${10 - k} leituras`);
const a14 = [
  ['A14', 'dono sem AdminUsers: leituras da regra', 'dono1', kDono >= 6 && kDono < 10, leituras(kDono)],
  ['A14', 'pior caso (claim da loja sem AdminUsers nem dono, cliente do pedido)', 'lojistaCliente', kPior >= 6 && kPior < 10, leituras(kPior)],
];
for (const [teste, nome, quem, ok, medida] of a14) {
  if (!ok) falhas += 1;
  console.log(`| ${teste} | ${nome} (no máximo 4) | ${quem} | - | ${medida} | ${ok ? 'passou' : 'FALHOU'} |`);
}
console.log(`\n${CASOS.length + a14.length} casos, ${falhas} fora do esperado.`);
process.exitCode = falhas ? 1 : 0;
