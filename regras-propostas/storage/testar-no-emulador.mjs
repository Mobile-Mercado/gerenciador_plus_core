// Proposta da regra do Storage (cola RP-15, item 3): fotos de cupom fiscal em cuponsFiscais/{uid}/.
// Roda so no emulador do Storage, com projeto demo-* e esta pasta como configuracao:
//
//   npx firebase-tools@15.30.0 emulators:exec --only storage --project demo-regras \
//     --config regras-propostas/storage/firebase.json "node regras-propostas/storage/testar-no-emulador.mjs"
//
// O firebase-tools 15 pede Java 21. O SDK web vem de ../web_gerenciador_plus/node_modules
// (FIREBASE_WEB_SDK_DIR muda).
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const raiz = path.resolve(aqui, '../..');
const PROJETO = process.env.GCLOUD_PROJECT || 'demo-regras';
const HOST = process.env.FIREBASE_STORAGE_EMULATOR_HOST || process.env.STORAGE_EMULATOR_HOST;
if (!HOST) throw new Error('Rode dentro de "firebase emulators:exec --only storage".');
if (!PROJETO.startsWith('demo-')) throw new Error('Use um projeto demo-*: este teste nunca fala com produção.');
const [hostname, porta] = HOST.replace(/^https?:\/\//, '').split(':');

const web = createRequire(path.join(process.env.FIREBASE_WEB_SDK_DIR || path.resolve(raiz, '../web_gerenciador_plus'), 'package.json'));
const { initializeApp, deleteApp } = web('firebase/app');
const { getStorage, connectStorageEmulator, ref, uploadBytes, getMetadata, deleteObject } = web('firebase/storage');

const BUCKET = `${PROJETO}.appspot.com`;
const TOKENS = {
  cliente: { sub: 'uid-cli', firebase: { sign_in_provider: 'phone' } },
  outro: { sub: 'uid-outro', firebase: { sign_in_provider: 'phone' } },
  lojista: { sub: 'uid-dono1', adminOf: 'loja-1' },
  semLogin: null,
};
const apps = new Map();
function storage(quem) {
  if (!apps.has(quem)) {
    const app = initializeApp({ projectId: PROJETO, apiKey: 'demo', storageBucket: BUCKET }, `app-${quem}`);
    const st = getStorage(app);
    connectStorageEmulator(st, hostname, Number(porta), TOKENS[quem] ? { mockUserToken: TOKENS[quem] } : {});
    apps.set(quem, { app, st });
  }
  return apps.get(quem).st;
}
const imagem = (bytes = 1024) => new Uint8Array(bytes).fill(7);
const enviar = (quem, caminho, { bytes = 1024, tipo = 'image/jpeg' } = {}) => uploadBytes(ref(storage(quem), caminho), imagem(bytes), { contentType: tipo });
const ler = (quem, caminho) => getMetadata(ref(storage(quem), caminho));

// [descricao, operacao, permitido]
const CASOS = [
  ['dono envia a foto do cupom (jpeg)', () => enviar('cliente', 'cuponsFiscais/uid-cli/foto-1.jpg'), true],
  ['dono le a propria foto', () => ler('cliente', 'cuponsFiscais/uid-cli/foto-1.jpg'), true],
  ['outro cliente le a foto', () => ler('outro', 'cuponsFiscais/uid-cli/foto-1.jpg'), false],
  ['sem login le a foto (a regra geral nao vale para a pasta)', () => ler('semLogin', 'cuponsFiscais/uid-cli/foto-1.jpg'), false],
  ['lojista le a foto', () => ler('lojista', 'cuponsFiscais/uid-cli/foto-1.jpg'), false],
  ['outro cliente grava na pasta de alguem', () => enviar('outro', 'cuponsFiscais/uid-cli/foto-2.jpg'), false],
  ['dono sobrescreve a foto', () => enviar('cliente', 'cuponsFiscais/uid-cli/foto-1.jpg'), false],
  ['dono envia PDF', () => enviar('cliente', 'cuponsFiscais/uid-cli/nota.pdf', { tipo: 'application/pdf' }), false],
  ['dono envia foto acima de 8 MB', () => enviar('cliente', 'cuponsFiscais/uid-cli/grande.jpg', { bytes: 8 * 1024 * 1024 + 1 }), false],
  ['dono envia png', () => enviar('cliente', 'cuponsFiscais/uid-cli/foto-3.png', { tipo: 'image/png' }), true],
  ['dono grava em subpasta (fora do formato)', () => enviar('cliente', 'cuponsFiscais/uid-cli/sub/foto.jpg'), false],
  ['outro cliente apaga a foto', () => deleteObject(ref(storage('outro'), 'cuponsFiscais/uid-cli/foto-3.png')), false],
  ['dono apaga a foto', () => deleteObject(ref(storage('cliente'), 'cuponsFiscais/uid-cli/foto-3.png')), true],
  // O resto do bucket continua como esta no ar.
  ['loja envia banner (regra geral)', () => enviar('lojista', 'Banners/loja-1/banner.jpg'), true],
  ['sem login le o banner (leitura publica)', () => ler('semLogin', 'Banners/loja-1/banner.jpg'), true],
  ['sem login grava imagem de produto (dossie item 3, fechado)', () => enviar('semLogin', 'Products/p1/images/i1.jpg'), false],
  ['loja grava imagem de produto', () => enviar('lojista', 'Products/p1/images/i1.jpg'), true],
  ['arquivo na raiz do bucket: loja grava', () => enviar('lojista', 'logo.png', { tipo: 'image/png' }), true],
  ['arquivo na raiz do bucket: sem login le', () => ler('semLogin', 'logo.png'), true],
];

let falhas = 0;
for (const [descricao, operacao, esperado] of CASOS) {
  let permitido = true;
  try {
    await operacao();
  } catch (erro) {
    if (!['storage/unauthorized', 'storage/unauthenticated'].includes(erro.code)) throw erro;
    permitido = false;
  }
  const ok = permitido === esperado;
  if (!ok) falhas += 1;
  console.log(`${ok ? 'ok  ' : 'FORA'} | ${descricao} | ${permitido ? 'permite' : 'NEGA'}`);
}
await Promise.all([...apps.values()].map(({ app }) => deleteApp(app)));
console.log(`\n${CASOS.length} casos, ${falhas} fora do esperado.`);
process.exitCode = falhas ? 1 : 0;
