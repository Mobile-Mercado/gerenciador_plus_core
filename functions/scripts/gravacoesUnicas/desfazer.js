// Desfaz uma gravacao unica da versao 55 a partir da copia salva por gravar.js (cola RP-76).
//
// Para cada documento da copia, le hoje so os campos da copia e:
//   - todos com o valor gravado (o depois): volta o antes (campo ausente antes e apagado);
//   - todos ja com o antes: nada a fazer;
//   - qualquer outro valor (alguem mexeu depois da gravacao): nao mexe e lista.
// Update so desses campos, com a conferencia pelo updateTime lido. Por padrao so mostra a previa.
//
//   node scripts/gravacoesUnicas/desfazer.js --copia ARQUIVO
//   node scripts/gravacoesUnicas/desfazer.js --copia ARQUIVO --gravar --confirmar appmobileprod-19505
//   --projeto ID     outro projeto (padrao: o da copia)
//   --por-chamada N  documentos por chamada, de 1 a 500 (padrao: 400); --pausa-ms MS entre elas (padrao: 0)
const fs = require('node:fs');
const path = require('node:path');
const { AUSENTE, criarFirestore, iguais, valorNoCaminho } = require('./firestoreRest');
const {
  argumento, carimbo, ehPedido, modoDeGravacao, mostrarChamada, mostrarMudancas, planoDaGravacao, ritmoDosArgumentos,
  salvarJson,
} = require('./comum');

async function principal() {
  const arquivoDaCopia = argumento('copia');
  if (!arquivoDaCopia) throw new Error('Use --copia ARQUIVO (a copia salva por gravar.js).');
  const copia = JSON.parse(fs.readFileSync(arquivoDaCopia, 'utf8'));
  if (!Array.isArray(copia.documentos)) throw new Error('Copia sem a lista de documentos.');
  const projeto = argumento('projeto') || copia.projeto;
  const gravar = modoDeGravacao(projeto);
  const ritmo = ritmoDosArgumentos();
  const firestore = criarFirestore({ projeto, permitirGravacao: gravar, ...ritmo });

  const campos = [...new Set(copia.documentos.flatMap((documento) => Object.keys(documento.antes)))];
  const atuais = await firestore.obter(copia.documentos.map((documento) => documento.caminho), campos);

  const restaurar = [];
  const jaComoAntes = [];
  const mexidos = [];
  const sumidos = [];
  copia.documentos.forEach((documento) => {
    const atual = atuais.get(documento.caminho);
    if (!atual) { sumidos.push(documento.caminho); return; }
    const valorAtual = (campo) => valorNoCaminho(atual.campos, campo) ?? AUSENTE;
    const nomes = Object.keys(documento.antes);
    if (nomes.every((campo) => iguais(valorAtual(campo), documento.depois[campo]))) {
      restaurar.push({
        caminho: documento.caminho,
        rotulo: documento.rotulo,
        updateTime: atual.updateTime,
        antes: Object.fromEntries(nomes.map((campo) => [campo, valorAtual(campo)])),
        depois: documento.antes,
      });
    } else if (nomes.every((campo) => iguais(valorAtual(campo), documento.antes[campo]))) {
      jaComoAntes.push(documento.caminho);
    } else {
      mexidos.push(documento.caminho);
    }
  });

  const contar = (lista) => {
    const pedidos = lista.filter(ehPedido).length;
    return `${lista.length}${pedidos ? ` (${pedidos} pedidos)` : ''}`;
  };
  console.log(`${gravar ? 'DESFAZENDO' : 'PREVIA DO DESFAZER, sem gravar'} | ${projeto}${firestore.emulador ? ' (emulador)' : ''} | copia ${path.basename(arquivoDaCopia)}`);
  console.log(`na copia: ${copia.documentos.length} | a voltar: ${contar(restaurar.map((item) => item.caminho))} | ja como antes: ${contar(jaComoAntes)} | mudaram depois da gravacao (nao mexe): ${contar(mexidos)} | nao existem mais: ${contar(sumidos)}`);
  mexidos.filter((caminho) => !ehPedido(caminho)).forEach((caminho) => console.log(`  mudou depois: ${caminho}`));
  mostrarMudancas(restaurar);

  if (!gravar) {
    console.log('Previa: nada foi gravado.');
    return;
  }
  if (!restaurar.length) {
    console.log('Nada a desfazer.');
    return;
  }
  console.log(`desfazendo ${planoDaGravacao(restaurar.length, firestore.ritmo)}`);
  const resultado = await firestore.gravar(
    restaurar.map(({ caminho, depois, updateTime }) => ({ caminho, valores: depois, updateTime })),
    { aoTerminarChamada: mostrarChamada },
  );
  const falhas = resultado.filter((item) => !item.ok);
  const nome = `${path.basename(arquivoDaCopia, '.json')}-desfeito-${carimbo()}.json`;
  const arquivo = salvarJson(path.dirname(path.resolve(arquivoDaCopia)), nome, { projeto, copia: path.basename(arquivoDaCopia), resultado, mexidos, sumidos });
  console.log(`voltaram: ${resultado.length - falhas.length} | falhas: ${falhas.length} | resultado: ${arquivo}`);
  if (falhas.length || mexidos.length) process.exitCode = 2;
}

principal().catch((erro) => {
  console.error('Falha:', erro.message);
  process.exitCode = 1;
});
