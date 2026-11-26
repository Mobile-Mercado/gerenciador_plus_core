// Cola do Thay B57-13s, item 39: origem de toda acao registrada no Log da equipe (AcoesEquipe) e nos
// lotes (historicoProdutos_N). O Core grava, em cada registro novo:
//   origemDaAcao: { tipo, tela, caminho, rota }
// - tipo: 'web' (Gerenciador Web da loja), 'admin' (telas do Admin, ou o Admin agindo na loja pelo
//   cabecalho X-Loja-Alvo), 'app' (App Gerenciador, que manda tipo: 'app'; cola B57-16b, item 11) ou
//   'rotina' (rotina do Core, sem tela).
// - caminho: os nomes das telas, do menu ate a tela da acao, como o painel mostra ("Produtos" >
//   "Editar produto"); tela: o ultimo deles.
// - rota: o endereco da tela no painel ("/produtos/editar"); null na rotina.
// Ninguem marca a mao: o painel manda o caminho da tela aberta no cabecalho X-Origem (JSON em
// encodeURIComponent: { rota, caminho }), em toda chamada. Sem cabecalho valido, o registro fica sem
// origem, como os antigos. A exibicao nos Logs espera mockup.

const MAX_TELAS = 8;
const MAX_NOME = 80;
const MAX_ROTA = 200;

export function cabecalhoDaOrigem({ tipo, rota = null, caminho = [] } = {}) {
  return encodeURIComponent(JSON.stringify({ ...(tipo ? { tipo } : {}), rota, caminho }));
}

function nomeValido(nome) {
  const texto = typeof nome === 'string' ? nome.replace(/\s+/g, ' ').trim() : '';
  return texto && texto.length <= MAX_NOME ? texto : null;
}

export function origemDoCabecalho(valor, { porAdmin = false } = {}) {
  if (typeof valor !== 'string' || !valor.trim() || valor.length > 2000) return null;
  let lido;
  try {
    lido = JSON.parse(decodeURIComponent(valor));
  } catch {
    return null;
  }
  if (!lido || typeof lido !== 'object' || !Array.isArray(lido.caminho)) return null;
  if (!lido.caminho.length || lido.caminho.length > MAX_TELAS) return null;
  const caminho = lido.caminho.map(nomeValido);
  if (caminho.some((nome) => !nome)) return null;
  let rota = null;
  if (lido.rota !== null && lido.rota !== undefined) {
    if (typeof lido.rota !== 'string' || lido.rota.length > MAX_ROTA || !/^\/[\w\-/]*$/.test(lido.rota)) return null;
    rota = lido.rota;
  }
  const doAdmin = porAdmin || rota === '/admin' || Boolean(rota?.startsWith('/admin/'));
  const tipo = doAdmin ? 'admin' : (lido.tipo === 'app' ? 'app' : 'web');
  return { tipo, tela: caminho[caminho.length - 1], caminho, rota };
}

// Rotina do Core, sem tela: a origem e o nome da rotina (o mesmo do campo `origem` do registro).
export function origemDaRotina(rotina) {
  return { tipo: 'rotina', tela: rotina, caminho: [], rota: null };
}
