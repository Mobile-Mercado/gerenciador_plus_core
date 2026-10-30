// Regra de estabelecimentos/{loja} da versao 55 (RP-68, itens A.1, A.2 e A.3). O lojista (claim
// adminOf) nao grava valor de credencial da Safrapay nem a escolha da credencial (merchantId,
// merchantToken, accessToken, webhookSecret, safrapayMerchantId, safrapayMerchantToken, token,
// merchantRef, merchantConfigId e useDefaultMerchant) em safrapay, paymentGateway nem
// paymentGateway.safrapay: ausente, nulo, vazio (e false no useDefaultMerchant) ou igual ao gravado
// na mesma posicao passa. userReference: o lojista nao troca, nao acrescenta nem apaga. O que o App
// Gerenciador publicado (master) grava hoje continua aceito; o Admin SDK (Core, web publicada pelo
// proxy, Admin) nao passa pela regra. Roda so no emulador, com projeto demo-*, contra o
// firestore.rules do repositorio (REGRAS_ARQUIVO troca o arquivo, para comparar com outra regra).
//
//   npx firebase-tools@15.30.0 emulators:exec --only firestore --project demo-regras \
//     "node regras-propostas/credencial-e-dono/testar-no-emulador.mjs"
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
const { getFirestore, connectFirestoreEmulator, doc, getDoc, updateDoc, writeBatch, deleteField } = web('firebase/firestore');
const servidor = createRequire(path.join(raiz, 'package.json'));
const admin = servidor('firebase-admin/app').initializeApp({ projectId: PROJETO }, 'semeador');
const banco = servidor('firebase-admin/firestore').getFirestore(admin);

const arquivoDaRegra = process.env.REGRAS_ARQUIVO || path.join(raiz, 'firestore.rules');
const resposta = await fetch(`http://${HOST}/emulator/v1/projects/${PROJETO}:securityRules`, {
  method: 'PUT', body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: readFileSync(arquivoDaRegra, 'utf8') }] } }),
});
if (!resposta.ok) throw new Error(`Regras recusadas: ${await resposta.text()}`);

const LOJA = 'loja-1';
// Loja como fica depois do passo 4 da RP-57: sem credencial, com o resto. Credencial em
// safrapayMerchants/{loja}, que so o Admin SDK le.
const lojaSemCredencial = () => ({
  name: 'Loja 1',
  userReference: banco.doc('Users/u-dono1'),
  isActive: true,
  paymentMethods: [{ name: 'Pix', enabled: true }],
  safrapay: { enabled: true, environment: 'prod', methods: { pix: true, creditcard: true, debitcard: false } },
  paymentGateway: { enabled: true, provider: 'safrapay', methods: { pix: true },
    safrapay: { enabled: true, provider: 'safrapay', env: 'prod', environment: 'prod', gatewayUrl: 'https://payment.safrapay.com.br' } },
  deliveryInfo: { referenceName: 'Centro', minTime: 30, maxTime: 60 },
});
// Loja antes do passo 4 (credencial ainda no documento).
const lojaComCredencial = () => {
  const loja = lojaSemCredencial();
  loja.safrapay.merchantId = 'mid-de-mentira';
  loja.safrapay.merchantToken = 'tok-de-mentira';
  loja.paymentGateway.safrapay.merchantId = 'mid-de-mentira';
  loja.paymentGateway.safrapay.merchantToken = 'tok-de-mentira-2';
  return loja;
};
// Loja com a escolha da credencial gravada pelo Admin (implantar_gateway_estabelecimentos.js
// da API grava em paymentGateway.safrapay).
const lojaComEscolha = () => {
  const loja = lojaSemCredencial();
  loja.safrapay.merchantRef = 'loja-1';
  loja.paymentGateway.merchantConfigId = 'loja-1';
  loja.paymentGateway.safrapay.useDefaultMerchant = true;
  loja.paymentGateway.safrapay.merchantRef = 'loja-1';
  return loja;
};

async function semear(loja) {
  const lote = banco.batch();
  lote.set(banco.doc('Users/u-dono1'), { id: 'u-dono1', userAuthId: 'uid-dono1' });
  lote.set(banco.doc('Users/u-func'), { id: 'u-func', userAuthId: 'uid-func' });
  lote.set(banco.doc(`estabelecimentos/${LOJA}`), loja);
  await lote.commit();
}

const apps = [];
function conectar(nome, token) {
  const app = initializeApp({ projectId: PROJETO, apiKey: 'demo' }, nome);
  apps.push(app);
  const db = getFirestore(app);
  connectFirestoreEmulator(db, hostname, Number(porta), { mockUserToken: token });
  return db;
}
const dono = conectar('dono', { sub: 'uid-dono1', adminOf: LOJA, groupId: 'g-admin' });
// Funcionario: tambem tem adminOf da loja (createAdminUser grava a mesma claim).
const funcionario = conectar('funcionario', { sub: 'uid-func', adminOf: LOJA, groupId: 'g-restrito' });
const outraLoja = conectar('outra-loja', { sub: 'uid-dono2', adminOf: 'loja-2', groupId: 'g-admin' });
const contaNova = conectar('conta-nova', { sub: 'uid-novo' });

const lojaRef = (db) => doc(db, `estabelecimentos/${LOJA}`);

// Payload do App Gerenciador publicado (master), "Formas de pagamento":
// payment_methods_repository_impl.dart:47-53 + safrapay_config_adapter.dart:21-33. O app manda o
// mapa safrapay inteiro (update troca o mapa todo) com o merchantId e o merchantToken que leu.
const formasDoAppPublicado = (mid = '', tok = '', enabled = true) => ({
  paymentMethods: [{ name: 'Pix', enabled: true }, { name: 'Dinheiro', enabled: true }],
  cardFlags: [],
  safrapay: { enabled, merchantId: mid, merchantToken: tok, environment: 'prod',
    methods: { pix: true, creditcard: true, debitcard: false } },
});

// [descricao, loja semeada, quem grava, mudanca, permitido]
const CASOS = [
  // O que o App Gerenciador publicado (master) grava hoje.
  ['App publicado: Formas de pagamento com credencial vazia', lojaSemCredencial, dono, formasDoAppPublicado(), true],
  ['App publicado: Formas de pagamento desligando a Safra (enabled livre)', lojaSemCredencial, dono, formasDoAppPublicado('', '', false), true],
  ['App publicado: Formas de pagamento numa loja com a escolha da credencial gravada (o mapa safrapay sai sem merchantRef)', lojaComEscolha, dono, formasDoAppPublicado(), true],
  ['App publicado: Formas de pagamento antes do passo 4, com a credencial que leu', lojaComCredencial, dono, formasDoAppPublicado('mid-de-mentira', 'tok-de-mentira'), true],
  ['App publicado: Formas de pagamento numa loja com safrapay nulo', () => ({ ...lojaSemCredencial(), safrapay: null }), dono, formasDoAppPublicado(), true],
  ['App publicado: Dados basicos (basic_info_controller.dart:221, BasicInfoUpdateAdapter)', lojaSemCredencial, dono,
    { responsibleName: 'Dono', name: 'Loja 1 nova', cpfOrCnpj: '00.000.000/0001-00', phone: '11999999999', minimumPriceCart: 10 }, true],
  ['App publicado: Entrega (delivery_repository_impl.dart:13-16)', lojaSemCredencial, dono,
    { deliveryInfo: { referenceName: 'Bairro', minTime: 20, maxTime: 40 } }, true],
  ['App publicado: imagem da loja (basic_info_images_controller.dart:121)', lojaSemCredencial, dono, { coverImageUrl: 'https://exemplo/capa.webp' }, true],
  ['App publicado: cadastro, passo da loja (register_company_service.dart:10-16)', lojaSemCredencial, dono,
    { chatProfileImage: null, coverImage: null, name: 'Loja 1', fantasyName: 'Loja 1', coorporativeName: 'Loja 1 LTDA', cpfOrCpnf: '', address: null }, true],
  ['App publicado: grava userReference igual ao salvo (CompanyAdapter.toMap)', lojaSemCredencial, dono, (db) => ({ name: 'Loja 1', userReference: doc(db, 'Users/u-dono1') }), true],
  // Valores vazios ou iguais ao gravado.
  ['merchantRef vazio em safrapay', lojaSemCredencial, dono, { 'safrapay.merchantRef': '' }, true],
  ['merchantConfigId nulo em paymentGateway', lojaSemCredencial, dono, { 'paymentGateway.merchantConfigId': null }, true],
  ['useDefaultMerchant false em paymentGateway.safrapay', lojaSemCredencial, dono, { 'paymentGateway.safrapay.useDefaultMerchant': false }, true],
  ['useDefaultMerchant igual ao gravado (true) em paymentGateway.safrapay', lojaComEscolha, dono, { 'paymentGateway.safrapay.useDefaultMerchant': true, 'paymentGateway.safrapay.enabled': false }, true],
  ['merchantRef igual ao gravado em safrapay', lojaComEscolha, dono, { 'safrapay.merchantRef': 'loja-1', 'safrapay.enabled': false }, true],
  ['merchantRef apagado de paymentGateway.safrapay', lojaComEscolha, dono, { 'paymentGateway.safrapay.merchantRef': deleteField() }, true],
  // Troca da credencial ou da escolha gravada.
  ['antes do passo 4: troca a credencial gravada', lojaComCredencial, dono, formasDoAppPublicado('mid-de-mentira', 'outro-token'), false],
  ['troca merchantRef gravado em safrapay', lojaComEscolha, dono, { 'safrapay.merchantRef': 'outra-loja' }, false],
  ['useDefaultMerchant "true" (texto) em safrapay', lojaSemCredencial, dono, { 'safrapay.useDefaultMerchant': 'true' }, false],
  ['useDefaultMerchant 1 em paymentGateway', lojaSemCredencial, dono, { 'paymentGateway.useDefaultMerchant': 1 }, false],
  ['merchantRef copiado para outra posicao (paymentGateway)', lojaComEscolha, dono, { 'paymentGateway.merchantRef': 'loja-1' }, false],
  // userReference (A.1).
  ['dono troca userReference para outro Users', lojaSemCredencial, dono, (db) => ({ userReference: doc(db, 'Users/u-func') }), false],
  ['funcionario troca userReference para o proprio Users', lojaSemCredencial, funcionario, (db) => ({ userReference: doc(db, 'Users/u-func') }), false],
  ['userReference nulo', lojaSemCredencial, dono, { userReference: null }, false],
  ['userReference apagado', lojaSemCredencial, dono, { userReference: deleteField() }, false],
  ['userReference acrescentado numa loja sem userReference', () => { const l = lojaSemCredencial(); delete l.userReference; return l; }, funcionario,
    (db) => ({ userReference: doc(db, 'Users/u-func') }), false],
  ['userReference como texto', lojaSemCredencial, dono, { userReference: 'Users/u-func' }, false],
  // Quem nao e da loja continua de fora.
  ['lojista de outra loja salva Formas de pagamento', lojaSemCredencial, outraLoja, formasDoAppPublicado(), false],
];

// Cada campo travado, com valor novo, nas tres posicoes, pontuado e com o mapa inteiro.
const TRAVADOS = ['merchantId', 'merchantToken', 'accessToken', 'webhookSecret', 'safrapayMerchantId',
  'safrapayMerchantToken', 'token', 'merchantRef', 'merchantConfigId', 'useDefaultMerchant'];
const valorNovo = (campo) => (campo === 'useDefaultMerchant' ? true : 'valor-novo');
for (const campo of TRAVADOS) {
  for (const posicao of ['safrapay', 'paymentGateway', 'paymentGateway.safrapay']) {
    CASOS.push([`${posicao}.${campo} novo, pontuado`, lojaSemCredencial, dono, { [`${posicao}.${campo}`]: valorNovo(campo) }, false]);
    CASOS.push([`${posicao}.${campo} novo, mapa inteiro`, lojaSemCredencial, dono, () => {
      const loja = lojaSemCredencial();
      if (posicao === 'paymentGateway.safrapay') {
        return { paymentGateway: { ...loja.paymentGateway, safrapay: { ...loja.paymentGateway.safrapay, [campo]: valorNovo(campo) } } };
      }
      return { [posicao]: { ...loja[posicao], [campo]: valorNovo(campo) } };
    }, false]);
  }
}

let falhas = 0;
let total = 0;
function relatar(descricao, permitido, esperado) {
  total += 1;
  const ok = permitido === esperado;
  if (!ok) falhas += 1;
  console.log(`${ok ? 'ok  ' : 'FORA'} | ${descricao} | ${permitido ? 'permite' : 'NEGA'}`);
}
async function tentar(acao) {
  try {
    await acao();
    return true;
  } catch (erro) {
    if (erro.code !== 'permission-denied') throw erro;
    return false;
  }
}

for (const [descricao, loja, db, mudanca, esperado] of CASOS) {
  await semear(loja());
  const dados = typeof mudanca === 'function' ? mudanca(db) : mudanca;
  relatar(descricao, await tentar(() => updateDoc(lojaRef(db), dados)), esperado);
}

// Leitura da loja continua aberta a quem tem login (boot do whitelabel).
await semear(lojaSemCredencial());
relatar('leitura da loja por conta sem claim', await tentar(() => getDoc(lojaRef(contaNova))), true);

// Cadastro do App Gerenciador publicado (register_user_service.dart:15-48): Users e loja no mesmo
// lote, a loja com userReference. Na versao 55 a loja nasce so pelo servidor (create fechado desde
// 13/10/2026), entao o lote e recusado; quem cadastra e o Core (POST /api/cadastro/loja).
relatar('cadastro do App publicado: Users e loja no mesmo lote (create da loja fechado na v55)', await tentar(async () => {
  const lote = writeBatch(contaNova);
  lote.set(doc(contaNova, 'Users/u-novo'), { id: 'u-novo', userAuthId: 'uid-novo', userType: 'UserType.empresa' });
  lote.set(doc(contaNova, 'estabelecimentos/loja-nova'), { id: 'loja-nova', name: '', isActive: false, userReference: doc(contaNova, 'Users/u-novo') });
  await lote.commit();
}), false);

// Admin SDK (Core, web publicada pelo proxy, Admin): nao passa pela regra.
await semear(lojaSemCredencial());
relatar('Admin SDK troca userReference, merchantRef e useDefaultMerchant e grava credencial', await tentar(() => banco.doc(`estabelecimentos/${LOJA}`).update({
  userReference: banco.doc('Users/u-func'),
  'safrapay.merchantToken': 'tok-do-admin',
  'paymentGateway.safrapay.merchantRef': 'loja-1',
  'paymentGateway.safrapay.useDefaultMerchant': true,
})), true);
relatar('Admin SDK cria loja com userReference', await tentar(() => banco.doc('estabelecimentos/loja-do-core').set({ name: 'Do Core', userReference: banco.doc('Users/u-dono1') })), true);

for (const app of apps) await deleteApp(app);
console.log(`\n${path.basename(arquivoDaRegra)}: ${total} casos, ${falhas} fora do esperado.`);
process.exitCode = falhas ? 1 : 0;
