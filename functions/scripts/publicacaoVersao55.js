// Gravacoes unicas da publicacao da versao 55 (cola RP-16, item 2; decisoes do Thay de 22/10/2026).
// Uma tarefa por vez. Por padrao so mostra a previa (antes e depois); grava so com --gravar. Em
// toda execucao guarda uma copia do que vai mudar (o antes) em JSON, antes de qualquer gravacao.
//
//   node scripts/publicacaoVersao55.js --tarefa cupons       cupons sem tipo ganham tipo 'todos'
//   node scripts/publicacaoVersao55.js --tarefa debito       featureFlags.debito so na Mercearia Ze Elias
//   node scripts/publicacaoVersao55.js --tarefa cartao-gs    G&S: o cartao passa a se chamar "Cartao de credito"
//   --gravar                                               grava (sem ele, so a previa)
//   --copias DIR                                           pasta das copias (padrao: copias-versao-55 ao lado do repositorio)
//
// Usa as credenciais do ambiente. Cada gravacao e um update so dos campos da tarefa.
const fs = require('node:fs');
const path = require('node:path');
const admin = require('firebase-admin');

const PROJETO = 'appmobileprod-19505';
const ZE_ELIAS = 'b3XQWKJ8p0clDrRRXoURvD1DVM43';
const G_E_S = 'GkFYWdOBKD1vbzYoem9K';
const NOME_DO_CARTAO = 'Cartão de crédito';

const argumento = (nome) => {
  const indice = process.argv.indexOf(`--${nome}`);
  return indice >= 0 ? process.argv[indice + 1] : null;
};

// Copia JSON-segura: Timestamp vira ISO, referencia vira caminho.
function paraJson(valor) {
  if (valor === null || valor === undefined) return valor ?? null;
  if (typeof valor.toDate === 'function') return { _timestamp: valor.toDate().toISOString() };
  if (valor.path && valor.firestore) return { _referencia: valor.path };
  if (Array.isArray(valor)) return valor.map(paraJson);
  if (typeof valor === 'object') return Object.fromEntries(Object.entries(valor).map(([chave, item]) => [chave, paraJson(item)]));
  return valor;
}

// Tarefa a: cupons sem tipo ganham tipo 'todos' (a leitura por tipo da regra proposta nao le
// cupom sem tipo). Cupom sem tipo mas com destinatario ou targetClientId fica de fora e e avisado.
async function cupons(db) {
  const documentos = (await db.collection('Coupons').get()).docs;
  const mudancas = [];
  const avisos = [];
  documentos.forEach((cupom) => {
    const dados = cupom.data() || {};
    if (dados.tipo) return;
    if (dados.destinatario || dados.targetClientId) {
      avisos.push(`cupom ${cupom.id} sem tipo, mas com destinatario/targetClientId: fica de fora (decidir a mao)`);
      return;
    }
    mudancas.push({
      ref: cupom.ref, caminho: cupom.ref.path, rotulo: `cupom ${dados.code || ''}`,
      antes: { tipo: dados.tipo ?? null }, depois: { tipo: 'todos' }, copia: paraJson(dados),
    });
  });
  return { lidos: documentos.length, mudancas, avisos };
}

// Tarefa b: featureFlags.debito so na Mercearia Ze Elias (cartao unico credito/debito no app 54).
// A G&S nao: Safrapay sem debito e pagamento so pelo app.
async function debito(db) {
  const loja = await db.collection('estabelecimentos').doc(ZE_ELIAS).get();
  if (!loja.exists) return { lidos: 0, mudancas: [], avisos: [`loja ${ZE_ELIAS} nao encontrada`] };
  const dados = loja.data() || {};
  const atual = dados.featureFlags?.debito ?? null;
  if (atual === true) return { lidos: 1, mudancas: [], avisos: ['featureFlags.debito ja esta ligado'] };
  return {
    lidos: 1,
    avisos: [],
    mudancas: [{
      ref: loja.ref, caminho: loja.ref.path, rotulo: dados.name || ZE_ELIAS,
      antes: { 'featureFlags.debito': atual }, depois: { 'featureFlags.debito': true }, copia: paraJson({ featureFlags: dados.featureFlags ?? null }),
    }],
  };
}

// Tarefa c: G&S, o cartao passa a se chamar "Cartao de credito" no array paymentMethods[] e na
// subcolecao paymentMethods (hoje "Cartao de credito/debito": a loja nao aceita debito).
const nomeComDebito = (nome) => /d[eé]bito|debit/i.test(String(nome || ''));
async function cartaoGs(db) {
  const loja = await db.collection('estabelecimentos').doc(G_E_S).get();
  if (!loja.exists) return { lidos: 0, mudancas: [], avisos: [`loja ${G_E_S} nao encontrada`] };
  const dados = loja.data() || {};
  const mudancas = [];
  const lista = Array.isArray(dados.paymentMethods) ? dados.paymentMethods : [];
  if (lista.some((item) => item && nomeComDebito(item.name))) {
    const nova = lista.map((item) => (item && nomeComDebito(item.name) ? { ...item, name: NOME_DO_CARTAO } : item));
    mudancas.push({
      ref: loja.ref, caminho: `${loja.ref.path} (paymentMethods[])`, rotulo: dados.name || G_E_S,
      antes: { paymentMethods: lista.map((item) => item?.name ?? null) }, depois: { paymentMethods: nova.map((item) => item?.name ?? null) },
      gravacao: { paymentMethods: nova }, copia: paraJson({ paymentMethods: lista }),
    });
  }
  const documentos = (await loja.ref.collection('paymentMethods').get()).docs;
  documentos.filter((documento) => nomeComDebito(documento.data()?.name)).forEach((documento) => {
    mudancas.push({
      ref: documento.ref, caminho: documento.ref.path, rotulo: `${dados.name || G_E_S} / ${documento.id}`,
      antes: { name: documento.data().name }, depois: { name: NOME_DO_CARTAO }, copia: paraJson(documento.data()),
    });
  });
  const avisos = mudancas.length ? [] : ['nenhum cartao com debito no nome: nada a mudar'];
  return { lidos: 1 + documentos.length, mudancas, avisos };
}

const TAREFAS = { cupons, debito, 'cartao-gs': cartaoGs };

async function principal() {
  const tarefa = argumento('tarefa');
  if (!TAREFAS[tarefa]) throw new Error(`Use --tarefa ${Object.keys(TAREFAS).join(' | ')}`);
  const gravar = process.argv.includes('--gravar');
  admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || PROJETO });
  const db = admin.firestore();
  const { lidos, mudancas, avisos } = await TAREFAS[tarefa](db);

  console.log(`${gravar ? 'GRAVANDO' : 'PREVIA, sem gravar'} | tarefa ${tarefa} | documentos lidos: ${lidos} | a mudar: ${mudancas.length}`);
  avisos.forEach((aviso) => console.log(`aviso: ${aviso}`));
  mudancas.forEach((mudanca) => {
    console.log(`- ${mudanca.caminho} (${mudanca.rotulo})`);
    console.log(`    antes:  ${JSON.stringify(mudanca.antes)}`);
    console.log(`    depois: ${JSON.stringify(mudanca.depois)}`);
  });

  if (mudancas.length) {
    const pasta = argumento('copias') || path.resolve(__dirname, '../../../copias-versao-55');
    fs.mkdirSync(pasta, { recursive: true });
    const arquivo = path.join(pasta, `${tarefa}-${new Date().toISOString().replace(/[:.]/g, '-')}${gravar ? '' : '-previa'}.json`);
    fs.writeFileSync(arquivo, JSON.stringify(mudancas.map(({ caminho, antes, depois, copia }) => ({ caminho, antes, depois, copia })), null, 2));
    console.log(`copia do antes: ${arquivo}`);
  }
  if (!gravar) return;
  for (const mudanca of mudancas) {
    await mudanca.ref.update(mudanca.gravacao || mudanca.depois);
  }
  console.log(`gravados: ${mudancas.length}`);
}

principal().catch((erro) => {
  console.error('Falha:', erro.message);
  process.exitCode = 1;
});
