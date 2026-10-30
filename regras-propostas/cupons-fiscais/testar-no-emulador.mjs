// Cupons fiscais do cliente (contrato da versao 55, item 8, ajustado em 22/10/2026; cola RP-14 A.4):
// Users/{id do Users}/CuponsFiscais/{chave}. So o dono cria e le; ninguem altera pelo app; documento
// do consumidor sempre mascarado. Roda so no emulador, com projeto demo-*, contra o firestore.rules
// do repositorio e contra a proposta por dono.
//
//   npx firebase-tools@15.30.0 emulators:exec --only firestore --project demo-regras \
//     "node regras-propostas/cupons-fiscais/testar-no-emulador.mjs"
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
const {
  getFirestore, connectFirestoreEmulator, doc, setDoc, getDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp,
} = web('firebase/firestore');
const servidor = createRequire(path.join(raiz, 'package.json'));
const admin = servidor('firebase-admin/app').initializeApp({ projectId: PROJETO }, 'semeador');
const banco = servidor('firebase-admin/firestore').getFirestore(admin);

const conjuntos = [
  { nome: 'firestore.rules', regras: readFileSync(path.join(raiz, 'firestore.rules'), 'utf8') },
  { nome: 'proposta por dono', regras: readFileSync(path.join(raiz, 'regras-propostas/por-dono/firestore.rules'), 'utf8') },
];

const CHAVE = '32261006955576000199651140004285341561368488';
const OUTRA_CHAVE = '32261006955576000199651140004285341561360000';
const caminho = (chave, usuario = 'u-cli') => `Users/${usuario}/CuponsFiscais/${chave}`;
const lido = (extra = {}) => ({
  chaveAcesso: CHAVE,
  urlQr: `https://app.sefaz.es.gov.br/ConsultaNFCe/qrcode.aspx?p=${CHAVE}`,
  origem: 'qr',
  situacao: 'lido',
  uf: 'ES',
  emitente: { nome: 'MERCADO TESTE LTDA', cnpj: '06955576000199', ie: '000000000', endereco: 'Rua A, 10 - Vitória/ES' },
  itens: [{ descricao: 'ARROZ 5KG', codigo: '789', quantidade: 1, unidade: 'UN', valorUnitario: 25.9, valorTotal: 25.9 }],
  total: 25.9,
  pagamentos: [{ forma: 'Pix', valor: 25.9 }],
  tributos: 3.1,
  emitidoEm: Timestamp.fromDate(new Date('2026-10-21T15:00:00Z')),
  numero: '428534',
  serie: '114',
  protocolo: '332260000000000',
  consumidorDocumento: null,
  criadoEm: serverTimestamp(),
  ...extra,
});
const foto = (extra = {}) => ({ origem: 'foto', situacao: 'aguardando', fotoPath: 'cuponsFiscais/u-cli/foto-1.jpg', chaveAcesso: null, criadoEm: serverTimestamp(), ...extra });

async function semear() {
  await fetch(`http://${HOST}/emulator/v1/projects/${PROJETO}/databases/(default)/documents`, { method: 'DELETE' });
  const lote = banco.batch();
  lote.set(banco.doc('Users/u-cli'), { id: 'u-cli', userAuthId: 'uid-cli' });
  lote.set(banco.doc('Users/u-outro'), { id: 'u-outro', userAuthId: 'uid-outro' });
  lote.set(banco.doc(caminho(OUTRA_CHAVE)), { chaveAcesso: OUTRA_CHAVE, origem: 'qr', situacao: 'lido', total: 10 });
  await lote.commit();
}

const TOKENS = {
  cliente: { sub: 'uid-cli', firebase: { sign_in_provider: 'phone' } },
  outro: { sub: 'uid-outro', firebase: { sign_in_provider: 'phone' } },
  anonimo: { sub: 'uid-anon', firebase: { sign_in_provider: 'anonymous' } },
  lojista: { sub: 'uid-dono1', adminOf: 'loja-1', groupId: 'g-admin' },
};

// [descricao, quem, operacao, permitido]
const CASOS = [
  ['dono grava a nota lida da Sefaz (qr, lido)', 'cliente', (db) => setDoc(doc(db, caminho(CHAVE)), lido()), true],
  ['dono le o proprio cupom', 'cliente', (db) => getDoc(doc(db, caminho(OUTRA_CHAVE))), true],
  ['dono grava a foto (aguardando)', 'cliente', (db) => setDoc(doc(db, caminho('foto-1')), foto()), true],
  ['outro cliente le o cupom de alguem', 'outro', (db) => getDoc(doc(db, caminho(OUTRA_CHAVE))), false],
  ['outro cliente grava no Users de alguem', 'outro', (db) => setDoc(doc(db, caminho(CHAVE)), lido()), false],
  ['conta anonima le', 'anonimo', (db) => getDoc(doc(db, caminho(OUTRA_CHAVE))), false],
  ['lojista le o cupom do cliente', 'lojista', (db) => getDoc(doc(db, caminho(OUTRA_CHAVE))), false],
  ['CPF inteiro no consumidor', 'cliente', (db) => setDoc(doc(db, caminho(CHAVE)), lido({ consumidorDocumento: '757.777.891-53' })), false],
  ['CPF mascarado no consumidor', 'cliente', (db) => setDoc(doc(db, caminho(CHAVE)), lido({ consumidorDocumento: '***.***.891-53' })), true],
  ['CNPJ do consumidor mascarado', 'cliente', (db) => setDoc(doc(db, caminho(CHAVE)), lido({ consumidorDocumento: '**.***.***/0001-99' })), true],
  ['id diferente da chave', 'cliente', (db) => setDoc(doc(db, caminho('12345678901234567890123456789012345678901234')), lido()), false],
  ['chave com menos de 44 numeros', 'cliente', (db) => setDoc(doc(db, caminho('3226')), lido({ chaveAcesso: '3226' })), false],
  ['app grava origem pedido (so o servidor)', 'cliente', (db) => setDoc(doc(db, caminho(CHAVE)), lido({ origem: 'pedido' })), false],
  ['qr com situacao aguardando', 'cliente', (db) => setDoc(doc(db, caminho(CHAVE)), lido({ situacao: 'aguardando' })), false],
  ['campo fora do contrato (cpf)', 'cliente', (db) => setDoc(doc(db, caminho(CHAVE)), lido({ cpf: '75777789153' })), false],
  ['nota sem itens', 'cliente', (db) => setDoc(doc(db, caminho(CHAVE)), { ...lido(), itens: 'arroz' }), false],
  ['foto ja como lida', 'cliente', (db) => setDoc(doc(db, caminho('foto-2')), foto({ situacao: 'lido' })), false],
  ['foto com chave valida', 'cliente', (db) => setDoc(doc(db, caminho('foto-3')), foto({ chaveAcesso: CHAVE })), true],
  ['dono altera o cupom (ninguem altera pelo app)', 'cliente', (db) => updateDoc(doc(db, caminho(OUTRA_CHAVE)), { total: 1 }), false],
  ['dono apaga o proprio cupom', 'cliente', (db) => deleteDoc(doc(db, caminho(OUTRA_CHAVE))), true],
];

let falhas = 0;
for (const conjunto of conjuntos) {
  const resposta = await fetch(`http://${HOST}/emulator/v1/projects/${PROJETO}:securityRules`, {
    method: 'PUT', body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: conjunto.regras }] } }),
  });
  if (!resposta.ok) throw new Error(`Regras recusadas (${conjunto.nome}): ${await resposta.text()}`);
  const apps = new Map();
  for (const [descricao, quem, operacao, esperado] of CASOS) {
    await semear();
    if (!apps.has(quem)) {
      const app = initializeApp({ projectId: PROJETO, apiKey: 'demo' }, `app-${conjunto.nome}-${quem}`);
      const db = getFirestore(app);
      connectFirestoreEmulator(db, hostname, Number(porta), { mockUserToken: TOKENS[quem] });
      apps.set(quem, { app, db });
    }
    let permitido = true;
    try {
      await operacao(apps.get(quem).db);
    } catch (erro) {
      if (erro.code !== 'permission-denied') throw erro;
      permitido = false;
    }
    const ok = permitido === esperado;
    if (!ok) falhas += 1;
    console.log(`${ok ? 'ok  ' : 'FORA'} | ${conjunto.nome} | ${descricao} | ${permitido ? 'permite' : 'NEGA'}`);
  }
  await Promise.all([...apps.values()].map(({ app }) => deleteApp(app)));
}
console.log(`\n${conjuntos.length * CASOS.length} casos, ${falhas} fora do esperado.`);
process.exitCode = falhas ? 1 : 0;
