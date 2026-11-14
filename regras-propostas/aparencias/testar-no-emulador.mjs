// Regra de estabelecimentos/{loja} das Aparencias (cola B56-21, Passo 0; regra da cola B56-04):
// o lojista (claim adminOf) nao grava ofertas, abertura nem primeiraTela, como ja nao grava
// aparencia, aparenciaHome, featureFlags e offerColor; so o Core grava, pelo Admin SDK, que nao passa
// pela regra. modelosAparencia e aparenciaPadrao ficam fechados para app e painel. O que o lojista
// grava hoje na loja (o resto do documento, inclusive o splashImageUrl que o painel grava direto)
// continua aceito. Roda so no emulador, com projeto demo-*, contra o firestore.rules do repositorio
// (REGRAS_ARQUIVO troca o arquivo, para comparar com a regra no ar).
//
//   npx firebase-tools@15.30.0 emulators:exec --only firestore --project demo-regras \
//     "node regras-propostas/aparencias/testar-no-emulador.mjs"
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
const { initializeApp } = web('firebase/app');
const { getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc, updateDoc } = web('firebase/firestore');
const servidor = createRequire(path.join(raiz, 'package.json'));
const admin = servidor('firebase-admin/app').initializeApp({ projectId: PROJETO }, 'semeador');
const banco = servidor('firebase-admin/firestore').getFirestore(admin);

const arquivoDaRegra = process.env.REGRAS_ARQUIVO || path.join(raiz, 'firestore.rules');
const resposta = await fetch(`http://${HOST}/emulator/v1/projects/${PROJETO}:securityRules`, {
  method: 'PUT', body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: readFileSync(arquivoDaRegra, 'utf8') }] } }),
});
if (!resposta.ok) throw new Error(`Regras recusadas: ${await resposta.text()}`);

let numero = 0;
function conectar(token) {
  const app = initializeApp({ projectId: PROJETO, apiKey: 'demo' }, `app-${numero += 1}`);
  const db = getFirestore(app);
  connectFirestoreEmulator(db, hostname, Number(porta), token ? { mockUserToken: token } : undefined);
  return db;
}
const lojista = conectar({ sub: 'uid-dono1', adminOf: 'loja-1', groupId: 'g-admin' });
const outraLoja = conectar({ sub: 'uid-dono2', adminOf: 'loja-2', groupId: 'g-admin' });
const cliente = conectar({ sub: 'uid-cli' });

async function semear() {
  await fetch(`http://${HOST}/emulator/v1/projects/${PROJETO}/databases/(default)/documents`, { method: 'DELETE' });
  const lote = banco.batch();
  lote.set(banco.doc('Users/u-dono1'), { id: 'u-dono1', userAuthId: 'uid-dono1' });
  lote.set(banco.doc('estabelecimentos/loja-1'), {
    name: 'Loja 1', userReference: banco.doc('Users/u-dono1'), isActive: true, scheduling: { enabled: false },
    // Gravados pelo Core (Admin SDK): o lojista grava o resto do documento sem mexer neles.
    ofertas: { fundo: { tipo: 'cor', cor: '#FFF4D1' }, lojistaPodeTrocarFundo: false },
    abertura: { tipo: 'imagem' },
    primeiraTela: { cor: '#2E4BD6' },
  });
  lote.set(banco.doc('estabelecimentos/loja-1/PermissionGroups/g-admin'), { isAdmin: true, permissions: [] });
  lote.set(banco.doc('modelosAparencia/m1'), { bloco: 'topo', nome: 'Topo X', base: 2, ajustes: {} });
  lote.set(banco.doc('aparenciaPadrao/padroes'), { topo: {} });
  await lote.commit();
}

async function resultado(acao) {
  try {
    await acao();
    return 'passa';
  } catch (erro) {
    return erro?.code === 'permission-denied' ? 'recusa' : `erro ${erro?.code || erro?.message}`;
  }
}

const loja = (db) => doc(db, 'estabelecimentos/loja-1');
const casos = [
  ['lojista grava ofertas.fundo.cor', 'recusa', () => updateDoc(loja(lojista), { 'ofertas.fundo.cor': '#000000' })],
  ['lojista liga ofertas.lojistaPodeTrocarFundo (set com merge)', 'recusa', () => setDoc(loja(lojista), { ofertas: { lojistaPodeTrocarFundo: true } }, { merge: true })],
  ['lojista apaga o mapa ofertas', 'recusa', () => updateDoc(loja(lojista), { ofertas: null })],
  ['lojista grava abertura.tipo', 'recusa', () => updateDoc(loja(lojista), { 'abertura.tipo': 'animacao' })],
  ['lojista grava abertura.animacaoUrl', 'recusa', () => updateDoc(loja(lojista), { 'abertura.animacaoUrl': 'https://x/a.json' })],
  ['lojista grava primeiraTela.cor', 'recusa', () => updateDoc(loja(lojista), { 'primeiraTela.cor': '#000000' })],
  ['lojista grava primeiraTela.logoUrl', 'recusa', () => updateDoc(loja(lojista), { 'primeiraTela.logoUrl': 'https://x/l.png' })],
  ['controle: lojista grava aparenciaHome.topo (ja era so do Admin)', 'recusa', () => updateDoc(loja(lojista), { 'aparenciaHome.topo': 3 })],
  ['controle: lojista grava offerColor (ja era so do Admin)', 'recusa', () => updateDoc(loja(lojista), { offerColor: '#000000' })],
  ['lojista grava o nome, sem tocar em ofertas, abertura e primeiraTela', 'passa', () => updateDoc(loja(lojista), { name: 'Loja 1 nova' })],
  ['lojista grava scheduling.enabled', 'passa', () => updateDoc(loja(lojista), { 'scheduling.enabled': true })],
  ['lojista grava splashImageUrl (o painel grava direto hoje)', 'passa', () => updateDoc(loja(lojista), { splashImageUrl: 'https://x/s.webp' })],
  ['lojista grava ofertas com o mesmo valor (set com merge)', 'passa', () => setDoc(loja(lojista), { ofertas: { fundo: { tipo: 'cor', cor: '#FFF4D1' }, lojistaPodeTrocarFundo: false } }, { merge: true })],
  ['lojista de outra loja grava o nome da loja-1', 'recusa', () => updateDoc(loja(outraLoja), { name: 'X' })],
  ['logado le a loja (boot do app)', 'passa', () => getDoc(loja(cliente))],
  ['logado le modelosAparencia', 'recusa', () => getDoc(doc(cliente, 'modelosAparencia/m1'))],
  ['lojista grava modelosAparencia', 'recusa', () => setDoc(doc(lojista, 'modelosAparencia/m2'), { bloco: 'topo' })],
  ['logado le aparenciaPadrao', 'recusa', () => getDoc(doc(cliente, 'aparenciaPadrao/padroes'))],
  ['lojista grava aparenciaPadrao', 'recusa', () => setDoc(doc(lojista, 'aparenciaPadrao/padroes'), { topo: { 2: {} } })],
];

console.log(`Regra: ${path.relative(raiz, arquivoDaRegra) || arquivoDaRegra}`);
let fora = 0;
for (const [nome, esperado, acao] of casos) {
  await semear();
  const obtido = await resultado(acao);
  if (obtido !== esperado) fora += 1;
  console.log(`${obtido === esperado ? 'ok  ' : 'FORA'} | ${nome} | esperado ${esperado}, obtido ${obtido}`);
}
console.log(`${casos.length} casos, ${fora} fora do esperado.`);
process.exit(fora ? 1 : 0);
