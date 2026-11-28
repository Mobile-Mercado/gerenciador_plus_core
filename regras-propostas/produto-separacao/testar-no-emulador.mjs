// Testa a regra do produto da separação (cola do Thay B57-18e, item 2; testes pedidos na B57-18h,
// item 1) contra as regras de hoje (firestore.rules da branch) e a proposta desta pasta.
// Roda só no emulador do Firestore, com projeto demo-*: nada chega à produção.
//
//   npx firebase-tools@15.30.0 emulators:exec --only firestore --project demo-regras-b57 \
//     "node regras-propostas/produto-separacao/testar-no-emulador.mjs"
//
// As gravações reproduzem item_em_falta.dart (mobile_gerenciador, aplicar e desfazer).
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
const { getFirestore: getAdminFirestore } = servidor('firebase-admin/firestore');
const banco = getAdminFirestore(admin);

const conjuntos = [
  { nome: 'hoje', regras: readFileSync(path.join(raiz, 'firestore.rules'), 'utf8') },
  { nome: 'proposta', regras: readFileSync(path.join(aqui, 'firestore.rules'), 'utf8') },
];

async function carregarRegras(texto) {
  const resposta = await fetch(`http://${HOST}/emulator/v1/projects/${PROJETO}:securityRules`, {
    method: 'PUT',
    body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: texto }] } }),
  });
  if (!resposta.ok) throw new Error(`Regras recusadas pelo emulador: ${await resposta.text()}`);
}

const marcaGravada = (tipo) => ({ tipo, quem: 'uid-x', em: new Date('2026-11-28T12:00:00Z'), pedido: 'p1' });
const produtoBase = { name: 'Biscoito', currentPrice: 5.5, price: 6, stock: 10, isActive: true, isTrashed: false };

// Semeia pelo Admin SDK (o emulador não aplica as regras a ele): grupos e um produto por caso.
async function semear() {
  await fetch(`http://${HOST}/emulator/v1/projects/${PROJETO}/databases/(default)/documents`, { method: 'DELETE' });
  const docs = {
    'estabelecimentos/loja-1': { id: 'loja-1', name: 'Loja 1', isActive: true },
    'estabelecimentos/loja-2': { id: 'loja-2', name: 'Loja 2', isActive: true },
    'estabelecimentos/loja-1/PermissionGroups/g-admin': { isAdmin: true, permissions: [] },
    'estabelecimentos/loja-1/PermissionGroups/g-editor': { isAdmin: false, permissions: ['products.edit'] },
    'estabelecimentos/loja-1/PermissionGroups/g-repor': { isAdmin: false, permissions: ['requests.remove_item', 'requests.hide_until_restock'] },
    'estabelecimentos/loja-1/PermissionGroups/g-lixeira': { isAdmin: false, permissions: ['requests.remove_item', 'requests.trash_discontinued'] },
    'estabelecimentos/loja-1/PermissionGroups/g-nada': { isAdmin: false, permissions: ['requests.remove_item'] },
    'estabelecimentos/loja-2/PermissionGroups/g-repor': { isAdmin: false, permissions: ['requests.hide_until_restock'] },
  };
  for (const caso of CASOS) docs[`estabelecimentos/loja-1/Products/${caso.produto}`] = caso.semente ?? produtoBase;
  const lote = banco.batch();
  Object.entries(docs).forEach(([caminho, dados]) => lote.set(banco.doc(caminho), dados));
  await lote.commit();
}

const TOKENS = {
  repor: { sub: 'uid-repor', adminOf: 'loja-1', groupId: 'g-repor' },
  lixeira: { sub: 'uid-lixeira', adminOf: 'loja-1', groupId: 'g-lixeira' },
  nada: { sub: 'uid-nada', adminOf: 'loja-1', groupId: 'g-nada' },
  editor: { sub: 'uid-editor', adminOf: 'loja-1', groupId: 'g-editor' },
  admin: { sub: 'uid-admin', adminOf: 'loja-1', groupId: 'g-admin' },
  reporOutraLoja: { sub: 'uid-repor2', adminOf: 'loja-2', groupId: 'g-repor' },
};

let contadorDeApps = 0;
function conectar(quem) {
  const app = initializeApp({ projectId: PROJETO, apiKey: 'demo' }, `app-${(contadorDeApps += 1)}`);
  const db = fs.getFirestore(app);
  fs.connectFirestoreEmulator(db, hostname, Number(porta), { mockUserToken: TOKENS[quem] });
  return { app, db };
}

const { doc, updateDoc, setDoc, deleteDoc, serverTimestamp, deleteField } = fs;
// aplicar (item_em_falta.dart:204-212) e desfazer (item_em_falta.dart:223-227), campos exatos.
const aplicar = (tipo, extra = {}) => ({
  ...(tipo === 'ateRepor' ? { isActive: false } : { isTrashed: true }),
  retiradoPelaEquipe: { tipo, quem: 'uid-x', em: serverTimestamp(), pedido: 'p1' },
  ...extra,
});
const desfazer = (antes) => ({ isActive: antes.isActive, isTrashed: antes.isTrashed, retiradoPelaEquipe: deleteField() });

// teste, caso, quem, hoje, proposta, operação(db, ref), semente opcional
let n = 0;
const caso = (teste, nome, quem, hoje, proposta, operacao, semente) =>
  ({ teste, nome, quem, hoje, proposta, operacao, semente, produto: `prod-${(n += 1)}` });
const CASOS = [
  caso(1, 'Até repor: isActive false + marca', 'repor', false, true, (r) => updateDoc(r, aplicar('ateRepor'))),
  caso(2, 'Até repor + name', 'repor', false, false, (r) => updateDoc(r, aplicar('ateRepor', { name: 'Outro' }))),
  caso(2, 'Até repor + currentPrice', 'repor', false, false, (r) => updateDoc(r, aplicar('ateRepor', { currentPrice: 0.01 }))),
  caso(2, 'Até repor + stock', 'repor', false, false, (r) => updateDoc(r, aplicar('ateRepor', { stock: 999 }))),
  caso(2, 'Até repor + promotionPrice', 'repor', false, false, (r) => updateDoc(r, aplicar('ateRepor', { promotionPrice: 1 }))),
  caso(2, 'Até repor tentando isTrashed', 'repor', false, false, (r) => updateDoc(r, aplicar('lixeira'))),
  caso(2, 'Até repor: criar produto', 'repor', false, false, (_r, db) => setDoc(doc(db, 'estabelecimentos/loja-1/Products/novo-repor'), { isActive: false })),
  caso(2, 'Até repor: apagar produto', 'repor', false, false, (r) => deleteDoc(r)),
  caso(2, 'Até repor com claim de outra loja', 'reporOutraLoja', false, false, (r) => updateDoc(r, aplicar('ateRepor'))),
  caso(3, 'Não vendemos mais: isTrashed true + marca', 'lixeira', false, true, (r) => updateDoc(r, aplicar('lixeira'))),
  caso(3, 'Não vendemos mais + isActive', 'lixeira', false, false, (r) => updateDoc(r, aplicar('lixeira', { isActive: false }))),
  caso(4, 'Desfazer Até repor (volta isActive, apaga marca)', 'repor', false, true,
    (r) => updateDoc(r, desfazer({ isActive: true, isTrashed: false })),
    { ...produtoBase, isActive: false, retiradoPelaEquipe: marcaGravada('ateRepor') }),
  caso(4, 'Desfazer Não vendemos mais (volta isTrashed, apaga marca)', 'lixeira', false, true,
    (r) => updateDoc(r, desfazer({ isActive: true, isTrashed: false })),
    { ...produtoBase, isTrashed: true, retiradoPelaEquipe: marcaGravada('lixeira') }),
  caso(5, 'Sem nenhuma das chaves: Até repor', 'nada', false, false, (r) => updateDoc(r, aplicar('ateRepor'))),
  caso(5, 'Sem nenhuma das chaves: Não vendemos mais', 'nada', false, false, (r) => updateDoc(r, aplicar('lixeira'))),
  caso(5, 'Sem nenhuma das chaves: desfazer', 'nada', false, false,
    (r) => updateDoc(r, desfazer({ isActive: true, isTrashed: false })),
    { ...produtoBase, isActive: false, retiradoPelaEquipe: marcaGravada('ateRepor') }),
  caso(6, 'products.edit: Até repor', 'editor', true, true, (r) => updateDoc(r, aplicar('ateRepor'))),
  caso(6, 'products.edit: name, currentPrice, stock', 'editor', true, true, (r) => updateDoc(r, { name: 'Novo', currentPrice: 4, stock: 3 })),
  caso(6, 'products.edit: criar produto', 'editor', true, true, (_r, db) => setDoc(doc(db, 'estabelecimentos/loja-1/Products/novo-editor'), produtoBase)),
  caso(6, 'grupo isAdmin: Não vendemos mais + preço', 'admin', true, true, (r) => updateDoc(r, aplicar('lixeira', { currentPrice: 2 }))),
  // Fora dos 6 da proposta: o desfazer grava isActive e isTrashed juntos. Num produto sem o campo
  // isTrashed, o desfazer do "Até repor" acrescenta isTrashed: false, que conta como mudança.
  caso('extra', 'Desfazer Até repor em produto sem o campo isTrashed', 'repor', false, false,
    (r) => updateDoc(r, desfazer({ isActive: true, isTrashed: false })),
    { name: 'Sem isTrashed', currentPrice: 3, isActive: false, retiradoPelaEquipe: marcaGravada('ateRepor') }),
];

async function rodar(conjunto) {
  await carregarRegras(conjunto.regras);
  await semear();
  const apps = new Map();
  const resultados = [];
  for (const c of CASOS) {
    if (!apps.has(c.quem)) apps.set(c.quem, conectar(c.quem));
    const { db } = apps.get(c.quem);
    let permitido = true;
    try {
      await c.operacao(doc(db, 'estabelecimentos', 'loja-1', 'Products', c.produto), db);
    } catch (falha) {
      permitido = false;
      const erro = falha.code || falha.message;
      if (erro !== 'permission-denied') throw new Error(`${c.nome}: erro inesperado ${erro}`);
    }
    resultados.push(permitido);
  }
  await Promise.all([...apps.values()].map(({ app }) => deleteApp(app)));
  return resultados;
}

const obtido = {};
for (const conjunto of conjuntos) obtido[conjunto.nome] = await rodar(conjunto);

const sim = (valor) => (valor ? 'permite' : 'NEGA');
let falhas = 0;
console.log('| teste | caso | quem | hoje | proposta | resultado |');
console.log('|---|---|---|---|---|---|');
CASOS.forEach((c, i) => {
  const confere = obtido.hoje[i] === c.hoje && obtido.proposta[i] === c.proposta;
  if (!confere) falhas += 1;
  console.log(`| ${c.teste} | ${c.nome} | ${c.quem} | ${sim(obtido.hoje[i])} | ${sim(obtido.proposta[i])} | ${confere ? 'passou' : `FALHOU (esperado hoje ${sim(c.hoje)} / proposta ${sim(c.proposta)})`} |`);
});
console.log(`\n${CASOS.length} casos, ${falhas} fora do esperado.`);
process.exitCode = falhas ? 1 : 0;
