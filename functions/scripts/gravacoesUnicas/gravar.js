// Gravacoes unicas do dia da publicacao da versao 55 (cola RP-76). Uma tarefa por vez.
//
// Por padrao so le e mostra a previa: quantos documentos mudam, os ids (de pedido, so a contagem)
// e o antes e o depois. Em toda execucao com mudancas, salva a copia dos valores atuais dos campos
// que vao mudar (o antes), antes de qualquer gravacao.
//
//   node scripts/gravacoesUnicas/gravar.js --tarefa NOME            previa, sem gravar
//   node scripts/gravacoesUnicas/gravar.js --tarefa NOME --gravar --confirmar appmobileprod-19505
//                                                                   grava (so no dia, com o ok do Thay)
//   --projeto ID       outro projeto (padrao: appmobileprod-19505)
//   --copias PASTA     pasta das copias (padrao: ambiente-local-rp44/seguranca-v55/gravacoes-unicas)
//
// Tarefas: veja TAREFAS abaixo. Acesso: FIRESTORE_TOKEN (gcloud auth print-access-token) ou
// FIRESTORE_EMULATOR_HOST. Para desfazer: desfazer.js --copia ARQUIVO (mesma chave para gravar).
const { criarFirestore } = require('./firestoreRest');
const {
  PASTA_DAS_COPIAS, argumento, carimbo, ehPedido, modoDeGravacao, mostrarMudancas, projetoEmUso, salvarJson,
} = require('./comum');

const TAREFAS = {
  cupons: require('./tarefas/cupons'),
  'cartao-gs': require('./tarefas/cartaoGs'),
  'grupos-dos-pedidos': require('./tarefas/gruposDosPedidos'),
};

async function principal() {
  const nome = argumento('tarefa');
  const tarefa = TAREFAS[nome];
  if (!tarefa) throw new Error(`Use --tarefa ${Object.keys(TAREFAS).join(' | ')}`);
  const projeto = projetoEmUso();
  const gravar = modoDeGravacao(projeto);
  const firestore = criarFirestore({ projeto, permitirGravacao: gravar });
  const lote = argumento('lote');

  const { lidos, mudancas, avisos = [], bloqueio = null, sufixo = '' } = await tarefa.executar({ firestore, gravar, lote });
  const rotulo = `${nome}${sufixo ? `-${sufixo}` : ''}`;
  console.log(`${gravar ? 'GRAVANDO' : 'PREVIA, sem gravar'} | ${projeto}${firestore.emulador ? ' (emulador)' : ''} | tarefa ${rotulo}`);
  console.log(`documentos lidos: ${lidos} | a mudar: ${mudancas.length}`);
  avisos.forEach((aviso) => console.log(`aviso: ${aviso}`));
  mostrarMudancas(mudancas, { detalhe: tarefa.detalheNaTela !== false });

  if (mudancas.length) {
    const copia = {
      tarefa: nome,
      lote: lote || null,
      projeto,
      modo: gravar ? 'gravacao' : 'previa',
      geradaEm: new Date().toISOString(),
      descricao: tarefa.descricao,
      documentos: mudancas.map(({ caminho, rotulo: nomeDoDocumento, updateTime, antes, depois }) => ({
        caminho, rotulo: nomeDoDocumento || null, updateTime, antes, depois,
      })),
    };
    const arquivo = salvarJson(argumento('copias') || PASTA_DAS_COPIAS, `${rotulo}-${carimbo()}-${copia.modo}.json`, copia);
    console.log(`copia do antes: ${arquivo}`);
  }

  if (!gravar) {
    console.log('Previa: nada foi gravado.');
    return;
  }
  if (bloqueio) throw new Error(`Gravacao recusada: ${bloqueio}`);
  if (!mudancas.length) {
    console.log('Nada a gravar.');
    return;
  }
  const resultado = await firestore.gravar(mudancas.map(({ caminho, depois, updateTime }) => ({ caminho, valores: depois, updateTime })));
  const falhas = resultado.filter((item) => !item.ok);
  const arquivo = salvarJson(argumento('copias') || PASTA_DAS_COPIAS, `${rotulo}-${carimbo()}-resultado.json`, { projeto, tarefa: nome, lote: lote || null, resultado });
  console.log(`gravados: ${resultado.length - falhas.length} | falhas: ${falhas.length} | resultado: ${arquivo}`);
  falhas.filter((falha) => !ehPedido(falha.caminho)).forEach((falha) => console.log(`  falha ${falha.caminho}: ${falha.erro}`));
  if (falhas.length) {
    console.log('As falhas (documento mudou depois da leitura) nao foram gravadas: rode a previa de novo.');
    process.exitCode = 2;
  }
}

principal().catch((erro) => {
  console.error('Falha:', erro.message);
  process.exitCode = 1;
});
