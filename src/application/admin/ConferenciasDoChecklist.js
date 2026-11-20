// Conferencias automaticas da aba "Alertas" do Admin, nesta rodada so os itens 3, 6 e 14 do
// checklist de funcionamento (cola do Thay B57-03c, item 8). Todas so leem e nenhuma pede
// permissao nova, chave ou custo: o registro de tentativas de login (pela leitura de
// functions/tentativasDeLogin.js, o unico arquivo que toca nele, regra RP-175) e os pedidos
// (PurchaseRequests), que o Core ja le, e uma chamada aos tres sites.
//
// Os limites que abrem cada alerta ficam aqui, com nome, para o Thay confirmar (relatorio B57-03c).

import tentativasDeLoginModulo from '../../../functions/tentativasDeLogin.js';

const { carregarRegistrosEntre } = tentativasDeLoginModulo;
const HORA_MS = 60 * 60 * 1000;
// Folga do relogio do aparelho, como o registro aceita (5 minutos).
const FOLGA_DO_RELOGIO_MS = 5 * 60 * 1000;

// ---- Item 3: tentativas de login que falharam ----

export const JANELA_DOS_LOGINS_MS = HORA_MS;
// Abre com pelo menos 5 tentativas que falharam e metade ou mais das tentativas com resultado
// falhando, na ultima hora. A tentativa cancelada pela pessoa nao conta como falha.
export const MINIMO_DE_LOGINS_QUE_FALHARAM = 5;
export const PARTE_DE_LOGINS_QUE_FALHARAM = 0.5;

// Motivo em portugues de cada codigo conhecido (cola B57-03d, item 2; textos para aprovacao no
// relatorio). Codigo desconhecido aparece como veio. Os codigos sao os do Firebase Auth e os do
// Google e da Apple que o app grava, em minusculas (loginErrorCode do mobile_core).
export const MOTIVOS_DO_LOGIN = Object.freeze({
  'billing-not-enabled': 'cobrança do Firebase desativada',
  'quota-exceeded': 'cota de SMS do Firebase esgotada',
  'too-many-requests': 'muitas tentativas seguidas, bloqueadas pelo Firebase',
  'invalid-verification-code': 'código do SMS errado',
  'session-expired': 'código do SMS vencido',
  'invalid-phone-number': 'número de celular inválido',
  'missing-phone-number': 'número de celular em branco',
  'captcha-check-failed': 'verificação do reCAPTCHA falhou',
  'web-context-cancelled': 'verificação no navegador cancelada',
  'app-not-authorized': 'app não autorizado no Firebase',
  'invalid-app-credential': 'credencial do app recusada pelo Firebase',
  'missing-client-identifier': 'verificação do aparelho falhou',
  'invalid-recaptcha-token': 'verificação do aparelho falhou',
  'missing-recaptcha-token': 'verificação do aparelho falhou',
  'operation-not-allowed': 'forma de entrar desligada no Firebase',
  'user-disabled': 'conta desativada',
  'network-request-failed': 'aparelho sem internet',
  'internal-error': 'erro interno do Firebase',
  'account-exists-with-different-credential': 'e-mail já usado com outra forma de entrar',
  'invalid-credential': 'credencial recusada pelo Firebase',
  'credential-already-in-use': 'número já está em outra conta',
  'requires-recent-login': 'login antigo, a pessoa precisa entrar de novo',
  'conta-nao-permitida': 'conta não permitida no app',
  'google/interrupted': 'login do Google interrompido',
  'google/clientconfigurationerror': 'configuração do Google no app',
  'google/providerconfigurationerror': 'configuração do Google no Firebase',
  'google/uiunavailable': 'tela do Google indisponível',
  'google/usermismatch': 'conta do Google diferente da escolhida',
  'google/sem-id-token': 'o Google não devolveu o login',
  'apple/failed': 'login da Apple falhou',
  'apple/invalidresponse': 'resposta inválida da Apple',
  'apple/nothandled': 'pedido não tratado pela Apple',
  'apple/nao-suportado': '"Entrar com Apple" indisponível no aparelho',
  'apple/credencial': 'credencial da Apple recusada',
});

export function motivoDoLogin(codigo) {
  return MOTIVOS_DO_LOGIN[String(codigo || '')] || codigo;
}

const NOMES_DOS_METODOS = { telefone: 'SMS', google: 'Google', apple: 'Apple', email: 'e-mail', anonimo: 'anônima' };

function paraData(valor) {
  if (!valor) return null;
  if (typeof valor.toDate === 'function') return valor.toDate();
  const data = valor instanceof Date ? valor : new Date(valor);
  return Number.isNaN(data.getTime()) ? null : data;
}

function cancelada(erro) {
  return /(^|[/_.-])cancel(ed|led)?$/.test(String(erro || ''));
}

function maisComum(contagem) {
  return [...contagem.entries()].sort(([a, x], [b, y]) => y - x || a.localeCompare(b))[0]?.[0] || null;
}

export function conferenciaDosLogins({ firestore }) {
  return async ({ agora }) => {
    const desde = new Date(agora.getTime() - JANELA_DOS_LOGINS_MS);
    const fim = new Date(agora.getTime() + FOLGA_DO_RELOGIO_MS);
    const registros = (await carregarRegistrosEntre({ db: firestore, inicio: desde, fim })).map((dados) => dados || {});
    const tentativas = new Map();
    registros.forEach((registro) => {
      if (!registro.tentativa) return;
      const tentativa = tentativas.get(registro.tentativa) || { metodo: registro.metodo, entrou: false, erros: [] };
      if (registro.etapa === 'entrou') tentativa.entrou = true;
      if (registro.etapa === 'falhou') tentativa.erros.push(registro.erro || 'sem-codigo');
      tentativas.set(registro.tentativa, tentativa);
    });
    let comResultado = 0;
    let falharam = 0;
    const motivos = new Map();
    const metodos = new Map();
    tentativas.forEach((tentativa) => {
      if (tentativa.entrou) { comResultado += 1; return; }
      const erros = tentativa.erros.filter((erro) => !cancelada(erro));
      if (!erros.length) return;
      comResultado += 1;
      falharam += 1;
      const erro = erros.at(-1);
      motivos.set(erro, (motivos.get(erro) || 0) + 1);
      metodos.set(tentativa.metodo, (metodos.get(tentativa.metodo) || 0) + 1);
    });
    if (falharam < MINIMO_DE_LOGINS_QUE_FALHARAM || falharam / comResultado < PARTE_DE_LOGINS_QUE_FALHARAM) return { ok: true };
    const metodo = maisComum(metodos);
    const motivo = maisComum(motivos);
    return {
      ok: false,
      alertas: [{
        alcance: { tipo: 'todas' },
        gravidade: 'grave',
        titulo: metodo === 'telefone' ? 'SMS do login falhando' : `Login por ${NOMES_DOS_METODOS[metodo] || metodo} falhando`,
        texto: `${falharam} de ${comResultado} tentativas de entrar falharam na última hora. Motivo mais comum: ${motivoDoLogin(motivo)}.`,
        detalhes: [...motivos.entries()].sort(([, a], [, b]) => b - a).map(([erro, vezes]) => `${motivoDoLogin(erro)}: ${vezes}`),
      }],
    };
  };
}

// ---- Item 6: pagamento SafraPay do comeco ao fim ----

export const JANELA_DA_SAFRAPAY_MS = 24 * HORA_MS;
// Abre por loja quando:
// - pelo menos 3 pedidos tentaram pagar online nas ultimas 24 horas e nenhum foi pago; ou
// - um pedido pago continua esperando o pagamento (waitingForOrderPayment) 30 minutos depois de
//   criado, ou seja, o cliente pagou e o pedido nao andou.
export const MINIMO_DE_PEDIDOS_SEM_PAGAR = 3;
export const ESPERA_DO_PEDIDO_PAGO_MS = 30 * 60 * 1000;

const PAGOS = new Set(['paid', 'paidawaitingconfirmation']);

function status(valor) {
  return String(valor || '').replace(/^PurchaseStatus\./i, '').trim().toLowerCase();
}

function idDaLoja(referencia) {
  if (!referencia) return null;
  if (typeof referencia === 'string') return referencia.split('/').filter(Boolean).at(-1) || null;
  return referencia.id || null;
}

export function conferenciaDaSafrapay({ firestore }) {
  return async ({ agora }) => {
    const desde = new Date(agora.getTime() - JANELA_DA_SAFRAPAY_MS);
    const pedidos = (await firestore.collection('PurchaseRequests').where('createdAt', '>=', desde).get()).docs;
    const porLoja = new Map();
    pedidos.forEach((doc) => {
      const pedido = doc.data() || {};
      const pagamento = pedido.purchasePayment || {};
      if (pedido.isTest === true || pedido.isTestAccount === true) return;
      if (String(pagamento.provider || '').toLowerCase() !== 'safrapay' || String(pagamento.mode || '').toLowerCase() !== 'online') return;
      const loja = idDaLoja(pedido.companyReference);
      if (!loja) return;
      const conta = porLoja.get(loja) || { tentaram: 0, pagos: 0, parados: [] };
      conta.tentaram += 1;
      const pago = PAGOS.has(String(pagamento.paymentStatus || '').toLowerCase());
      if (pago) conta.pagos += 1;
      const criadoEm = paraData(pedido.createdAt);
      if (pago && status(pedido.currentPurchaseStatus) === 'waitingfororderpayment' && criadoEm
        && agora.getTime() - criadoEm.getTime() >= ESPERA_DO_PEDIDO_PAGO_MS) {
        conta.parados.push(doc.id);
      }
      porLoja.set(loja, conta);
    });

    const alertas = [];
    for (const [lojaId, conta] of porLoja) {
      const semPagar = conta.tentaram >= MINIMO_DE_PEDIDOS_SEM_PAGAR && conta.pagos === 0;
      if (!semPagar && !conta.parados.length) continue;
      const loja = await firestore.collection('estabelecimentos').doc(lojaId).get();
      const nome = loja.data()?.name || loja.data()?.nomeEstabelecimento || lojaId;
      const textos = [];
      if (semPagar) textos.push(`${conta.tentaram} pedidos tentaram pagar online nas últimas 24 horas e nenhum foi pago.`);
      if (conta.parados.length) textos.push(`${conta.parados.length} ${conta.parados.length === 1 ? 'pedido pago continua' : 'pedidos pagos continuam'} esperando o pagamento há mais de 30 minutos.`);
      alertas.push({
        alcance: { tipo: 'loja', lojaId, nome },
        gravidade: 'grave',
        titulo: 'Pagamento pela SafraPay sem andar',
        texto: textos.join(' '),
        detalhes: conta.parados.map((id) => `Pedido ${id}`),
      });
    }
    return alertas.length ? { ok: false, alertas } : { ok: true };
  };
}

// ---- Item 14: sites no ar ----

export const SITES_CONFERIDOS = Object.freeze([
  { nome: 'mobilegerenciador.com.br', endereco: 'https://mobilegerenciador.com.br/' },
  { nome: 'mobilemercado.com.br', endereco: 'https://mobilemercado.com.br/' },
  { nome: 'Admin', endereco: 'https://gerenciadormobile.web.app/admin' },
]);
export const ESPERA_DO_SITE_MS = 15 * 1000;

export function conferenciaDosSites({ buscar = globalThis.fetch, sites = SITES_CONFERIDOS } = {}) {
  return async () => {
    const fora = [];
    for (const site of sites) {
      try {
        const resposta = await buscar(site.endereco, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(ESPERA_DO_SITE_MS) });
        if (resposta.status >= 400) fora.push({ site, motivo: `respondeu ${resposta.status}` });
      } catch (erro) {
        fora.push({ site, motivo: erro?.name === 'TimeoutError' ? 'não respondeu em 15 segundos' : 'não respondeu' });
      }
    }
    if (!fora.length) return { ok: true };
    return {
      ok: false,
      alertas: [{
        alcance: { tipo: 'todas' },
        gravidade: 'grave',
        titulo: fora.length === 1 ? `Site fora do ar: ${fora[0].site.nome}` : 'Sites fora do ar',
        texto: fora.map(({ site, motivo }) => `${site.nome} ${motivo}.`).join(' '),
        detalhes: fora.map(({ site }) => site.endereco),
      }],
    };
  };
}

export function conferenciasDoChecklist({ firestore, buscar } = {}) {
  return {
    logins: conferenciaDosLogins({ firestore }),
    safrapay: conferenciaDaSafrapay({ firestore }),
    sites: conferenciaDosSites({ buscar }),
  };
}
