const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

// Id antigo da Zero Grau ("Super Zero Grau") que ficou em chats e mensagens. Nao existe em
// estabelecimentos, entao o marcador, o aviso de mensagem nova e a tela Mensagens nao acham
// a loja nesses chats. Troca so este valor exato, em qualquer campo do chat ou da mensagem.
const ID_ANTIGO = 'yXzD6vYW9KfYihkelsnY413cbIo1';
const ID_ZERO_GRAU = 'jQQjHTCc2zW1tuZMQzGF';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function usage() {
  return [
    'Uso:',
    '  node scripts/corrigirIdAntigoDosChats.js [--gravar --backup PASTA] [--project ID]',
    '',
    'Sem --gravar, so le: mostra quantos chats e mensagens tem o id antigo e em quais campos.',
    'Com --gravar, salva o JSON de cada documento tocado em PASTA e troca o id, numa transacao',
    'por chat que so aplica se o valor antigo ainda estiver la.',
  ].join('\n');
}

// So objetos simples sao percorridos: Timestamp, referencia e GeoPoint ficam como estao.
const ehObjetoSimples = (valor) => valor !== null && typeof valor === 'object'
  && Object.getPrototypeOf(valor) === Object.prototype;

// Caminhos (a.b.0.c) onde o valor e exatamente o id antigo.
function caminhosComIdAntigo(valor, prefixo = '') {
  if (valor === ID_ANTIGO) return [prefixo];
  if (Array.isArray(valor)) return valor.flatMap((item, indice) => caminhosComIdAntigo(item, `${prefixo}.${indice}`));
  if (ehObjetoSimples(valor)) {
    return Object.entries(valor).flatMap(([chave, item]) => caminhosComIdAntigo(item, prefixo ? `${prefixo}.${chave}` : chave));
  }
  return [];
}

function trocar(valor) {
  if (valor === ID_ANTIGO) return ID_ZERO_GRAU;
  if (Array.isArray(valor)) return valor.map(trocar);
  if (ehObjetoSimples(valor)) return Object.fromEntries(Object.entries(valor).map(([chave, item]) => [chave, trocar(item)]));
  return valor;
}

// Campos de primeiro nivel que mudam, com o valor ja trocado (mapas e listas vao inteiros).
function camposTrocados(dados) {
  const campos = {};
  Object.entries(dados || {}).forEach(([campo, valor]) => {
    if (caminhosComIdAntigo(valor).length) campos[campo] = trocar(valor);
  });
  return campos;
}

// Referencia do Firestore que aponta para o id antigo: so avisa, nao troca.
function referenciasAoIdAntigo(valor, prefixo = '') {
  if (valor && typeof valor === 'object' && typeof valor.path === 'string' && typeof valor.collection === 'function') {
    return valor.path.split('/').includes(ID_ANTIGO) ? [prefixo] : [];
  }
  if (Array.isArray(valor)) return valor.flatMap((item, indice) => referenciasAoIdAntigo(item, `${prefixo}.${indice}`));
  if (ehObjetoSimples(valor)) {
    return Object.entries(valor).flatMap(([chave, item]) => referenciasAoIdAntigo(item, prefixo ? `${prefixo}.${chave}` : chave));
  }
  return [];
}

function paraJson(valor) {
  if (valor instanceof admin.firestore.Timestamp) return { _timestamp: valor.toDate().toISOString() };
  if (valor instanceof admin.firestore.DocumentReference) return { _referencia: valor.path };
  if (valor instanceof admin.firestore.GeoPoint) return { _geopoint: [valor.latitude, valor.longitude] };
  if (Array.isArray(valor)) return valor.map(paraJson);
  if (valor && typeof valor === 'object') return Object.fromEntries(Object.entries(valor).map(([chave, item]) => [chave, paraJson(item)]));
  return valor;
}

const contar = (mapa, chave) => mapa.set(chave, (mapa.get(chave) || 0) + 1);

async function main() {
  if (process.argv.includes('--help')) {
    console.log(usage());
    return;
  }
  const gravar = process.argv.includes('--gravar');
  const pastaDeBackup = argument('backup');
  if (gravar && !pastaDeBackup) {
    console.error(usage());
    process.exitCode = 1;
    return;
  }
  const projectId = argument('project') || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  admin.initializeApp(projectId ? { projectId } : undefined);
  const db = admin.firestore();

  const zeroGrau = await db.collection('estabelecimentos').doc(ID_ZERO_GRAU).get();
  if (!zeroGrau.exists) throw new Error(`estabelecimentos/${ID_ZERO_GRAU} nao existe`);

  // Os chats sao poucos: le todos e procura o valor em qualquer campo.
  const chats = (await db.collection('Chats').get()).docs;
  const alvos = [];
  const camposDoChat = new Map();
  const camposDaMensagem = new Map();
  const avisos = [];
  for (const chat of chats) {
    const caminhosDoChat = caminhosComIdAntigo(chat.data());
    if (!caminhosDoChat.length) continue;
    caminhosDoChat.forEach((caminho) => contar(camposDoChat, caminho));
    referenciasAoIdAntigo(chat.data()).forEach((caminho) => avisos.push(`${chat.ref.path}: ${caminho}`));
    const mensagens = (await chat.ref.collection('Messages').get()).docs
      .filter((mensagem) => {
        referenciasAoIdAntigo(mensagem.data()).forEach((caminho) => avisos.push(`${mensagem.ref.path}: ${caminho}`));
        const caminhos = caminhosComIdAntigo(mensagem.data());
        caminhos.forEach((caminho) => contar(camposDaMensagem, caminho));
        return caminhos.length > 0;
      });
    alvos.push({ chat, mensagens });
  }

  const totalDeMensagens = alvos.reduce((soma, alvo) => soma + alvo.mensagens.length, 0);
  console.log(`Chats lidos: ${chats.length}. Com o id antigo ${ID_ANTIGO}: ${alvos.length} chats e ${totalDeMensagens} mensagens.`);
  console.log(`Troca por ${ID_ZERO_GRAU} (${zeroGrau.get('name') || 'sem nome'}).`);
  console.log('\ncampos no chat | documentos');
  [...camposDoChat].sort().forEach(([campo, total]) => console.log(`${campo} | ${total}`));
  console.log('\ncampos na mensagem | documentos');
  [...camposDaMensagem].sort().forEach(([campo, total]) => console.log(`${campo} | ${total}`));
  if (avisos.length) {
    console.log('\nReferencias com o id antigo no caminho (nao sao trocadas):');
    avisos.forEach((aviso) => console.log(`  ${aviso}`));
  }

  if (!gravar) {
    console.log('\nSimulacao: nada foi gravado. Use --gravar --backup PASTA para trocar.');
    return;
  }

  const pasta = path.resolve(pastaDeBackup, `corrigirIdAntigoDosChats-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(pasta, { recursive: true });
  alvos.forEach(({ chat, mensagens }) => {
    const documentos = [chat, ...mensagens].map((documento) => ({ caminho: documento.ref.path, dados: paraJson(documento.data()) }));
    fs.writeFileSync(path.join(pasta, `${chat.id}.json`), JSON.stringify(documentos, null, 2));
  });
  console.log(`\nBackup de ${alvos.length + totalDeMensagens} documentos em ${pasta}`);

  const resultado = { chats: 0, mensagens: 0, semIdAntigo: 0 };
  for (const { chat, mensagens } of alvos) {
    const trocados = await db.runTransaction(async (transacao) => {
      const snapshots = await transacao.getAll(chat.ref, ...mensagens.map((mensagem) => mensagem.ref));
      const mudancas = snapshots
        .filter((snapshot) => snapshot.exists)
        .map((snapshot) => ({ ref: snapshot.ref, campos: camposTrocados(snapshot.data()) }))
        .filter(({ campos }) => Object.keys(campos).length);
      mudancas.forEach(({ ref, campos }) => transacao.update(ref, campos));
      return mudancas;
    });
    if (!trocados.length) {
      resultado.semIdAntigo += 1;
      continue;
    }
    if (trocados.some(({ ref }) => ref.path === chat.ref.path)) resultado.chats += 1;
    resultado.mensagens += trocados.filter(({ ref }) => ref.path !== chat.ref.path).length;
  }
  console.log(`Trocados: ${resultado.chats} chats e ${resultado.mensagens} mensagens. Chats sem o id antigo na hora de gravar: ${resultado.semIdAntigo}.`);
}

main().catch((error) => {
  console.error('[corrigirIdAntigoDosChats] Falha', error.message);
  process.exitCode = 1;
});
