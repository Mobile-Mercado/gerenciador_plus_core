// Leitura de Coupons por tipo (cola RP-15, item 4): "para todos" para qualquer conta logada, "para
// um cliente" so para o destinatario. Carrega o firestore.rules do repositorio com o bloco Coupons
// trocado por coupons.rules (esta pasta) e testa as consultas do app, a de hoje e as novas.
// Roda so no emulador, com projeto demo-*:
//
//   npx firebase-tools@15.30.0 emulators:exec --only firestore --project demo-regras \
//     "node regras-propostas/cupons/testar-no-emulador.mjs"
//
// O firebase-tools 15 pede Java 21. O SDK web vem de ../web_gerenciador_plus/node_modules.
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
const {
  getFirestore, connectFirestoreEmulator, collection, doc, getDoc, getDocs, query, where, Timestamp,
} = web('firebase/firestore');
const servidor = createRequire(path.join(raiz, 'package.json'));
const admin = servidor('firebase-admin/app').initializeApp({ projectId: PROJETO }, 'semeador');
const { getFirestore: firestoreAdmin, Timestamp: TimestampAdmin } = servidor('firebase-admin/firestore');
const banco = firestoreAdmin(admin);

// firestore.rules com o bloco Coupons da proposta.
const regrasDoRepositorio = readFileSync(path.join(raiz, 'firestore.rules'), 'utf8').replace(/\r\n/g, '\n');
const inicio = regrasDoRepositorio.indexOf('    match /Coupons/{couponId} {');
const fim = regrasDoRepositorio.indexOf('    // CouponRequests');
if (inicio < 0 || fim < inicio) throw new Error('Bloco Coupons nao encontrado no firestore.rules.');
const regras = `${regrasDoRepositorio.slice(0, inicio)}${readFileSync(path.join(aqui, 'coupons.rules'), 'utf8').replace(/\r\n/g, '\n')}\n${regrasDoRepositorio.slice(fim)}`;

const futuro = TimestampAdmin.fromDate(new Date('2027-01-01T00:00:00Z'));
const base = { active: true, establishmentIds: ['loja-1'], endAt: futuro, code: 'X' };
async function semear() {
  await fetch(`http://${HOST}/emulator/v1/projects/${PROJETO}/databases/(default)/documents`, { method: 'DELETE' });
  const lote = banco.batch();
  lote.set(banco.doc('Coupons/todos-1'), { ...base, code: 'TODOS1', tipo: 'todos', destinatario: null });
  lote.set(banco.doc('Coupons/ana-1'), { ...base, code: 'SO-ANA', tipo: 'cliente', destinatario: { userId: 'u-ana', userAuthId: 'uid-ana' }, targetClientId: 'u-ana' });
  lote.set(banco.doc('Coupons/bia-1'), { ...base, code: 'SO-BIA', tipo: 'cliente', destinatario: { userId: 'u-bia', userAuthId: 'uid-bia' }, targetClientId: 'u-bia' });
  lote.set(banco.doc('Coupons/antigo-1'), { ...base, code: 'ANTIGO' });
  await lote.commit();
}

const TOKENS = {
  ana: { sub: 'uid-ana', firebase: { sign_in_provider: 'phone' } },
  bia: { sub: 'uid-bia', firebase: { sign_in_provider: 'phone' } },
  anonimo: { sub: 'uid-anon', firebase: { sign_in_provider: 'anonymous' } },
  semLogin: null,
};

// Filtros de hoje do app (coupon_list_repository.dart:106-110).
const filtrosDeHoje = () => [where('active', '==', true), where('establishmentIds', 'array-contains', 'loja-1'), where('endAt', '>', Timestamp.now())];
const consultaDeHoje = (db) => getDocs(query(collection(db, 'Coupons'), ...filtrosDeHoje()));
const consultaTodos = (db) => getDocs(query(collection(db, 'Coupons'), where('tipo', '==', 'todos'), ...filtrosDeHoje()));
const consultaMeus = (db, uid) => getDocs(query(collection(db, 'Coupons'), where('destinatario.userAuthId', '==', uid), ...filtrosDeHoje()));
const codigos = (snapshot) => snapshot.docs.map((documento) => documento.get('code')).sort().join(',');

// [descricao, quem, operacao, permitido, codigos esperados (consultas)]
const CASOS = [
  ['consulta de hoje, sem filtro de tipo (apps atuais)', 'ana', consultaDeHoje, false],
  ['consulta "para todos" (tipo == todos)', 'ana', consultaTodos, true, 'TODOS1'],
  ['consulta "meus" (destinatario.userAuthId == meu uid)', 'ana', (db) => consultaMeus(db, 'uid-ana'), true, 'SO-ANA'],
  ['consulta "meus" com o uid de outra pessoa', 'ana', (db) => consultaMeus(db, 'uid-bia'), false],
  ['conta anonima: consulta "para todos"', 'anonimo', consultaTodos, true, 'TODOS1'],
  ['sem login: consulta "para todos"', 'semLogin', consultaTodos, false],
  ['destinatario abre o proprio cupom', 'ana', (db) => getDoc(doc(db, 'Coupons/ana-1')), true],
  ['outro cliente abre o cupom pessoal', 'bia', (db) => getDoc(doc(db, 'Coupons/ana-1')), false],
  ['qualquer conta abre o cupom para todos', 'bia', (db) => getDoc(doc(db, 'Coupons/todos-1')), true],
  ['cupom antigo sem tipo (precisa ganhar o tipo antes de publicar)', 'ana', (db) => getDoc(doc(db, 'Coupons/antigo-1')), false],
];

await fetch(`http://${HOST}/emulator/v1/projects/${PROJETO}:securityRules`, {
  method: 'PUT', body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: regras }] } }),
}).then(async (resposta) => { if (!resposta.ok) throw new Error(`Regras recusadas: ${await resposta.text()}`); });
await semear();

const apps = new Map();
let falhas = 0;
for (const [descricao, quem, operacao, esperado, codigosEsperados] of CASOS) {
  if (!apps.has(quem)) {
    const app = initializeApp({ projectId: PROJETO, apiKey: 'demo' }, `app-${quem}`);
    const db = getFirestore(app);
    connectFirestoreEmulator(db, hostname, Number(porta), TOKENS[quem] ? { mockUserToken: TOKENS[quem] } : {});
    apps.set(quem, { app, db });
  }
  let permitido = true;
  let obtidos = null;
  try {
    const resultado = await operacao(apps.get(quem).db);
    if (resultado?.docs) obtidos = codigos(resultado);
  } catch (erro) {
    if (erro.code !== 'permission-denied') throw erro;
    permitido = false;
  }
  const ok = permitido === esperado && (codigosEsperados === undefined || obtidos === codigosEsperados);
  if (!ok) falhas += 1;
  console.log(`${ok ? 'ok  ' : 'FORA'} | ${descricao} | ${permitido ? 'permite' : 'NEGA'}${obtidos !== null ? ` | ${obtidos || '(vazio)'}` : ''}`);
}
await Promise.all([...apps.values()].map(({ app }) => deleteApp(app)));
console.log(`\n${CASOS.length} casos, ${falhas} fora do esperado.`);
process.exitCode = falhas ? 1 : 0;
