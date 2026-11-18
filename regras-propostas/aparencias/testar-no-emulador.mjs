// Regra de estabelecimentos/{loja} das Aparencias (cola B56-21, Passo 0; regra da cola B56-04):
// o lojista (claim adminOf) nao grava ofertas, abertura nem primeiraTela, como ja nao grava
// aparencia, aparenciaHome, featureFlags e offerColor; so o Core grava, pelo Admin SDK, que nao passa
// pela regra. modelosAparencia e aparenciaPadrao ficam fechados para app e painel. O que o lojista
// grava hoje na loja (o resto do documento, inclusive o splashImageUrl que o painel grava direto)
// continua aceito. Roda so no emulador, com projeto demo-*, contra o firestore.rules do repositorio
// (REGRAS_ARQUIVO troca o arquivo, para comparar com a regra no ar).
// Cola B56-24 (A2): o lojista tambem nao grava os blocos da jornada Primeiro acesso (boasVindas,
// login, codigoSms, folhaNome, folhaEndereco), e aparenciaPadrao/abertura (a animacao padrao) tem
// leitura aberta, ate sem login, e gravacao fechada; o resto de aparenciaPadrao continua fechado.
// Cola B56-25 (item 8): o lojista tambem nao grava primaryColor nem secondaryColor (so o Admin muda
// as cores da loja), e aparenciaPadrao/cores (cores das lojas novas) fica fechado.
// Cola B57-01b (item C6): o lojista tambem nao grava discountBadgeColor (cor do selo de desconto).
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
const semLogin = conectar(null);

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
    boasVindas: { titulo: 'Bem-vindo' },
    primaryColor: '#2E4BD6', secondaryColor: '#1F9D4E', discountBadgeColor: '#1F9D4E',
    login: { googleLigado: true },
  });
  lote.set(banco.doc('estabelecimentos/loja-1/PermissionGroups/g-admin'), { isAdmin: true, permissions: [] });
  lote.set(banco.doc('modelosAparencia/m1'), { bloco: 'topo', nome: 'Topo X', base: 2, ajustes: {} });
  lote.set(banco.doc('aparenciaPadrao/padroes'), { topo: {} });
  lote.set(banco.doc('aparenciaPadrao/cores'), { loja: '#2E4BD6', sistema: '#1F9D4E' });
  lote.set(banco.doc('aparenciaPadrao/abertura'), { nome: 'carregando.json', animacaoUrl: 'https://x/a.json' });
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
  ['lojista grava boasVindas.titulo', 'recusa', () => updateDoc(loja(lojista), { 'boasVindas.titulo': 'Oi' })],
  ['lojista grava login.googleLigado', 'recusa', () => updateDoc(loja(lojista), { 'login.googleLigado': false })],
  ['lojista grava codigoSms.tempo', 'recusa', () => updateDoc(loja(lojista), { 'codigoSms.tempo': 60 })],
  ['lojista grava folhaNome (set com merge)', 'recusa', () => setDoc(loja(lojista), { folhaNome: { titulo: 'Nome?' } }, { merge: true })],
  ['lojista grava folhaEndereco.pularLigado', 'recusa', () => updateDoc(loja(lojista), { 'folhaEndereco.pularLigado': false })],
  ['lojista apaga o mapa boasVindas', 'recusa', () => updateDoc(loja(lojista), { boasVindas: null })],
  ['lojista grava boasVindas e login com o mesmo valor (set com merge)', 'passa', () => setDoc(loja(lojista), { boasVindas: { titulo: 'Bem-vindo' }, login: { googleLigado: true } }, { merge: true })],
  ['lojista grava primaryColor', 'recusa', () => updateDoc(loja(lojista), { primaryColor: '#000000' })],
  ['lojista grava secondaryColor', 'recusa', () => updateDoc(loja(lojista), { secondaryColor: '#000000' })],
  ['lojista apaga primaryColor', 'recusa', () => updateDoc(loja(lojista), { primaryColor: null })],
  ['lojista grava as cores com o mesmo valor e o nome (set com merge)', 'passa', () => setDoc(loja(lojista), { name: 'Loja 1 b', primaryColor: '#2E4BD6', secondaryColor: '#1F9D4E' }, { merge: true })],
  ['controle: lojista grava aparenciaHome.topo (ja era so do Admin)', 'recusa', () => updateDoc(loja(lojista), { 'aparenciaHome.topo': 3 })],
  ['controle: lojista grava offerColor (ja era so do Admin)', 'recusa', () => updateDoc(loja(lojista), { offerColor: '#000000' })],
  ['lojista grava discountBadgeColor', 'recusa', () => updateDoc(loja(lojista), { discountBadgeColor: '#000000' })],
  ['lojista apaga discountBadgeColor', 'recusa', () => updateDoc(loja(lojista), { discountBadgeColor: null })],
  ['lojista grava discountBadgeColor com o mesmo valor e o nome (set com merge)', 'passa', () => setDoc(loja(lojista), { name: 'Loja 1 c', discountBadgeColor: '#1F9D4E' }, { merge: true })],
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
  ['sem login le aparenciaPadrao/abertura (o app antes do login)', 'passa', () => getDoc(doc(semLogin, 'aparenciaPadrao/abertura'))],
  ['logado le aparenciaPadrao/abertura', 'passa', () => getDoc(doc(cliente, 'aparenciaPadrao/abertura'))],
  ['sem login le aparenciaPadrao/padroes', 'recusa', () => getDoc(doc(semLogin, 'aparenciaPadrao/padroes'))],
  ['lojista grava aparenciaPadrao/abertura', 'recusa', () => setDoc(doc(lojista, 'aparenciaPadrao/abertura'), { animacaoUrl: 'https://x/b.json' })],
  ['logado le aparenciaPadrao/cores', 'recusa', () => getDoc(doc(cliente, 'aparenciaPadrao/cores'))],
  ['lojista grava aparenciaPadrao/cores', 'recusa', () => setDoc(doc(lojista, 'aparenciaPadrao/cores'), { loja: '#000000' })],
  ['logado grava aparenciaPadrao/abertura', 'recusa', () => setDoc(doc(cliente, 'aparenciaPadrao/abertura'), { animacaoUrl: 'https://x/b.json' })],
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
