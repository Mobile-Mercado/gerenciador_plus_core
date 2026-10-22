// Debito na versao 55 (cola RP-15, item 5): o app novo so mostra o cartao de debito com
// featureFlags.debito ligado. Este script acha as lojas que ja oferecem debito (item do array
// paymentMethods[] com id de debito ativo, que e o que o app de hoje le, ou o documento debito da
// subcolecao paymentMethods ativo) e ainda nao tem featureFlags.debito, e liga a chave nelas.
//
//   node scripts/ligarDebito.js             previa, sem gravar
//   node scripts/ligarDebito.js --gravar    grava featureFlags.debito = true (so nas lojas da previa)
//   --incluir-cartao-combinado              inclui as lojas cujo cartao ativo e "credito/debito" (id
//                                           cartao ou credito, nome com debito): no app 54 esse cartao
//                                           cobria os dois; no 55, sem a chave, o debito some
//
// Grava so featureFlags.debito (update com o caminho pontuado): promotions, banners e
// allBannersTypes ficam. Usa as credenciais do ambiente.
const admin = require('firebase-admin');

const PROJETO = 'appmobileprod-19505';

// Mesmo teste do app do cliente (payment_controller.dart: o id contem debito ou debit).
function ehDebito(id) {
  const texto = String(id || '').toLowerCase();
  return texto.includes('debito') || texto.includes('debit');
}

// Cartao unico "credito/debito" (id sem debito, nome com debito), como o da web antiga.
function cartaoCombinado(loja, documentos) {
  const temDebitoNoNome = (nome) => /d[eé]bito|debit/i.test(String(nome || ''));
  const lista = Array.isArray(loja.paymentMethods) ? loja.paymentMethods : [];
  return lista.some((item) => item && !ehDebito(item.id) && item.isActive === true && temDebitoNoNome(item.name))
    || documentos.some((documento) => !ehDebito(documento.id) && documento.data()?.isActive === true && temDebitoNoNome(documento.data()?.name));
}

function debitoAtivo(loja, documentos) {
  const lista = Array.isArray(loja.paymentMethods) ? loja.paymentMethods : [];
  const noArray = lista.some((item) => item && ehDebito(item.id) && item.isActive === true);
  const naSubcolecao = documentos.some((documento) => ehDebito(documento.id) && documento.data()?.isActive === true);
  return { noArray, naSubcolecao, ativo: noArray || naSubcolecao };
}

async function principal() {
  const gravar = process.argv.includes('--gravar');
  const incluirCombinado = process.argv.includes('--incluir-cartao-combinado');
  admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || PROJETO });
  const db = admin.firestore();
  const lojas = (await db.collection('estabelecimentos').get()).docs;
  const alvo = [];
  for (const loja of lojas) {
    const dados = loja.data() || {};
    if (dados.featureFlags?.debito === true) continue;
    const documentos = (await loja.ref.collection('paymentMethods').get()).docs;
    const debito = debitoAtivo(dados, documentos);
    const combinado = !debito.ativo && cartaoCombinado(dados, documentos);
    if (combinado && !incluirCombinado) {
      console.log(`fora (cartao combinado credito/debito; use --incluir-cartao-combinado): ${loja.id} ${dados.name || ''} ativa=${dados.isActive === true}`);
    }
    if (debito.ativo || (combinado && incluirCombinado)) {
      alvo.push({
        id: loja.id, nome: dados.name || '', ativa: dados.isActive === true, noArray: debito.noArray, naSubcolecao: debito.naSubcolecao, cartaoCombinado: combinado,
        featureFlagsDebito: dados.featureFlags?.debito ?? null,
      });
    }
  }
  console.log(`${gravar ? 'GRAVANDO' : 'PREVIA, sem gravar'} | lojas lidas: ${lojas.length} | com debito ativo e sem featureFlags.debito: ${alvo.length}`);
  alvo.forEach((loja) => console.log(JSON.stringify(loja)));
  if (!gravar) return;
  for (const loja of alvo) {
    await db.collection('estabelecimentos').doc(loja.id).update({ 'featureFlags.debito': true });
  }
  console.log(`gravadas: ${alvo.length} lojas`);
}

principal().catch((erro) => {
  console.error('Falha ao ligar o debito:', erro.message);
  process.exitCode = 1;
});
