// Aviso ao lojista quando o cliente toca no sino da tela de cupons do app (cola RP-179, item 7).
//
// O app do cliente grava CouponRequests/{id} = { establishmentId, userId, userName,
// requestedAt } (mobile_cliente, coupon_request_repository.dart). O gatilho
// avisarPedidoDeCupom (functions/index.js) chama avisarPedidoDeCupomUmaVez, que:
//   0. ignora o pedido sem nome (userName ausente, vazio ou so espacos), que a versao 1.0.36
//      do app ainda grava;
//   1. le o nome do cliente no cadastro (Users/{userId}.name); sem nome, nao avisa;
//   2. le a loja (estabelecimentos/{loja}) e o dono dela (userReference);
//   3. reserva o aviso do dia: cria AvisosDePedidoDeCupom/{loja}_{cliente}_{dia}, com create(),
//      que falha se ja existe. No maximo um aviso por cliente e loja por dia (fuso de Sao
//      Paulo), mesmo com dois toques ao mesmo tempo. A colecao so e lida e gravada pelo
//      servidor: a regra do banco nao tem match para ela e cai no bloqueio geral;
//   4. manda o push ao App Gerenciador do dono e dos funcionarios ativos com "Ver pedidos" ou
//      Administrador (destinatariosDaLoja.js, cola B57-18g, item 1; como o "Voce vendeu!" do
//      mobile_old_web_platform) e o aviso do navegador do gerenciador web
//      (enviarAvisoParaLoja, url /cupons). Um envio que falha nao impede o outro.
//
// Arquivo puro: o banco, o FieldValue, o messaging e o contador chegam por parametro.

const { diaDe } = require('./buscasResumo');
const { contarEnvios, contarFalhaGeral, semToken } = require('./pushResumo');
const { tokensDaLoja } = require('./destinatariosDaLoja');

const ORIGEM = 'avisarPedidoDeCupom';
const COLECAO_DE_AVISOS = 'AvisosDePedidoDeCupom';
// Texto aprovado pelo Thay em 14/11 (mockups-RP-179, secao 4).
const TEXTO_DO_AVISO = 'Quando houver cupons disponíveis.';
const SUFIXO_DO_TITULO = ' quer cupom';
// data.kind do push: o App Gerenciador a partir do proximo build abre a tela de Cupons por ele
// (shared/lib/src/notification_manager.dart). O build de hoje so conhece click_action, que o
// aviso nao leva: tocar so abre o app.
const KIND_DO_AVISO = 'pedido_de_cupom';
const URL_DO_PAINEL = '/cupons';
const COR_DA_NOTIFICACAO = '#0B0CF2';
// Codigo gRPC ALREADY_EXISTS, devolvido pelo create() do Admin SDK quando o documento existe.
const JA_EXISTE = 6;
const MAX_TOKENS_POR_ENVIO = 500;
// Ids de documento como o banco grava (letras, digitos, "_" e "-"). O pedido vem do app do
// cliente: id em outro formato nao vira caminho de documento.
const ID_VALIDO = /^[A-Za-z0-9_-]{1,128}$/;

function idValido(valor) {
  return typeof valor === 'string' && ID_VALIDO.test(valor);
}

function idDeReferencia(valor) {
  if (!valor) return '';
  if (typeof valor === 'string') return valor.split('/').filter(Boolean).at(-1) || '';
  if (valor.id) return String(valor.id);
  if (valor.path) return String(valor.path).split('/').filter(Boolean).at(-1) || '';
  return '';
}

// Nome como esta no cadastro do cliente (Users/{id}.name; cadastro antigo: nome). So tira tags,
// caracteres de controle e espacos repetidos; acento e apostrofo ficam. Sem nome: ''.
function nomeDoCadastro(usuario = {}) {
  const nome = [usuario?.name, usuario?.nome].find((valor) => typeof valor === 'string' && valor.trim());
  if (!nome) return '';
  return nome
    .replace(/<[^>]*>/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

// O pedido traz o userName que o app mandou. Sem ele (ausente, vazio ou so espacos), o pedido e
// ignorado: a versao 1.0.36 do app ainda grava pedidos assim (Thay, 14/11). O titulo continua
// com o nome do cadastro.
function pedidoTemNome(pedido = {}) {
  return typeof pedido?.userName === 'string' && pedido.userName.trim().length > 0;
}

function avisoDePedidoDeCupom(nome) {
  return { title: `${nome}${SUFIXO_DO_TITULO}`, body: TEXTO_DO_AVISO };
}

function chaveDoAviso({ lojaId, clienteId, dia }) {
  return `${lojaId}_${clienteId}_${dia}`;
}

// Push ao App Gerenciador. Som padrao do aparelho (opcao A, aprovada em 14/11):
// - iPhone: aps.sound "default";
// - Android: sem channelId e sem sound, com defaultSound. O App Gerenciador nao declara canal
//   padrao no AndroidManifest, entao, com o app fechado ou em segundo plano, o Android usa o
//   canal de reserva do FCM, que toca o som padrao do aparelho. Com o app aberto, quem mostra e o
//   proprio app (showFlutterNotification), que hoje toca o ding (aceito).
// Sem click_action: o build de hoje so abre o app; o proximo le data.kind e abre Cupons.
function mensagemDoAppDoLojista(tokens, { title, body, data }) {
  return {
    tokens,
    data,
    notification: { title, body },
    android: {
      notification: {
        title,
        body,
        color: COR_DA_NOTIFICACAO,
        defaultSound: true,
        priority: 'max',
        visibility: 'public',
      },
      data,
    },
    apns: {
      payload: {
        aps: { sound: 'default' },
      },
    },
  };
}

// Reserva o aviso do dia. true para quem criou; false se ja havia aviso desse cliente para essa
// loja no dia (outro toque, ou entrega repetida do mesmo evento). Outros erros sobem.
async function reservarAvisoDoDia({ db, FieldValue, lojaId, clienteId, dia, pedidoId }) {
  const marca = db.collection(COLECAO_DE_AVISOS).doc(chaveDoAviso({ lojaId, clienteId, dia }));
  try {
    await marca.create({ lojaId, clienteId, dia, pedidoId: pedidoId || null, avisadoEm: FieldValue.serverTimestamp() });
    return true;
  } catch (error) {
    if (error?.code === JA_EXISTE || error?.code === 'already-exists') return false;
    throw error;
  }
}

// Envia ao App Gerenciador do dono e dos funcionarios ativos com "Ver pedidos" ou Administrador
// (tokensDaLoja, cola B57-18g, item 1; o mesmo do "Voce vendeu!" do mobile_old_web_platform).
// A contagem em PushResumo vai por `contar`, que nao espera a gravacao (contarSemEsperar em
// index.js): o envio nunca espera a contagem. O valor do token nunca vai para o log.
async function enviarAoAppDoLojista({
  db, messaging, contar, lojaId, donoId, title, body, data, origem = ORIGEM,
}) {
  const { tokens, plataformas } = await tokensDaLoja(db, lojaId, donoId);
  if (!tokens.length) {
    console.log(`[${origem}] Dono da loja ${lojaId} sem aparelho para o App Gerenciador`);
    contar({ loja: lojaId, origem, audiencia: 'lojista', ...semToken() });
    return { totalSuccess: 0, totalFailures: 0 };
  }
  let totalSuccess = 0;
  let totalFailures = 0;
  for (let inicio = 0; inicio < tokens.length; inicio += MAX_TOKENS_POR_ENVIO) {
    const bloco = tokens.slice(inicio, inicio + MAX_TOKENS_POR_ENVIO);
    const plataformasDoBloco = plataformas.slice(inicio, inicio + MAX_TOKENS_POR_ENVIO);
    try {
      const resposta = await messaging.sendEachForMulticast(mensagemDoAppDoLojista(bloco, { title, body, data }));
      totalSuccess += resposta.successCount;
      totalFailures += resposta.failureCount;
      try {
        contar({ loja: lojaId, origem, audiencia: 'lojista', ...contarEnvios(resposta.responses, plataformasDoBloco) });
      } catch (error) {
        console.error(`[${origem}] Contagem do envio nao feita`, error?.message || String(error));
      }
    } catch (error) {
      console.error(`[${origem}] Erro ao enviar ao App Gerenciador`, error?.code || error?.message || String(error));
      totalFailures += bloco.length;
      try {
        contar({ loja: lojaId, origem, audiencia: 'lojista', ...contarFalhaGeral(error?.code || 'desconhecido', plataformasDoBloco) });
      } catch (erroDaContagem) {
        console.error(`[${origem}] Contagem do envio nao feita`, erroDaContagem?.message || String(erroDaContagem));
      }
    }
  }
  console.log(`[${origem}] App Gerenciador: ${totalSuccess} aceitos, ${totalFailures} falhas`);
  return { totalSuccess, totalFailures };
}

// O fluxo inteiro do gatilho. Devolve { enviado, motivo } para o log e os testes.
async function avisarPedidoDeCupomUmaVez({
  db, FieldValue, messaging, contar, enviarAvisoParaLoja, pedido = {}, pedidoId, agora = new Date(), origem = ORIGEM,
}) {
  const lojaId = pedido?.establishmentId;
  const clienteId = pedido?.userId;
  if (!idValido(lojaId) || !idValido(clienteId)) {
    console.warn(`[${origem}] Pedido de cupom ${pedidoId} sem loja ou cliente validos; nao avisa`);
    return { enviado: false, motivo: 'pedido_invalido' };
  }
  // Pedido sem nome (userName ausente, vazio ou so espacos): ignorado, sem aviso e sem reservar o
  // dia. Ainda chegam assim da versao 1.0.36 do app (decisao do Thay, 14/11).
  if (!pedidoTemNome(pedido)) {
    console.warn(`[${origem}] Pedido de cupom ${pedidoId} sem nome; ignorado, nao avisa a loja ${lojaId}`);
    return { enviado: false, motivo: 'pedido_sem_nome' };
  }

  const usuario = await db.collection('Users').doc(clienteId).get();
  const nome = usuario?.exists ? nomeDoCadastro(usuario.data()) : '';
  if (!nome) {
    console.warn(`[${origem}] Cliente do pedido de cupom ${pedidoId} sem nome no cadastro; nao avisa a loja ${lojaId}`);
    return { enviado: false, motivo: 'sem_nome' };
  }

  const loja = await db.collection('estabelecimentos').doc(lojaId).get();
  if (!loja?.exists) {
    console.warn(`[${origem}] Loja ${lojaId} do pedido de cupom ${pedidoId} nao existe; nao avisa`);
    return { enviado: false, motivo: 'loja_inexistente' };
  }

  const dia = diaDe(agora);
  const reservado = await reservarAvisoDoDia({ db, FieldValue, lojaId, clienteId, dia, pedidoId });
  if (!reservado) {
    console.log(`[${origem}] Loja ${lojaId} ja avisada hoje deste cliente; nao repete`);
    return { enviado: false, motivo: 'ja_avisado_hoje' };
  }

  const { title, body } = avisoDePedidoDeCupom(nome);
  const data = { kind: KIND_DO_AVISO, companyId: lojaId };

  const donoId = idDeReferencia(loja.data()?.userReference);
  if (idValido(donoId)) {
    try {
      await enviarAoAppDoLojista({ db, messaging, contar, lojaId, donoId, title, body, data, origem });
    } catch (error) {
      console.error(`[${origem}] Falha no envio ao App Gerenciador da loja ${lojaId}`, error?.message || String(error));
    }
  } else {
    console.warn(`[${origem}] Loja ${lojaId} sem dono (userReference); sem push ao App Gerenciador`);
  }

  try {
    await enviarAvisoParaLoja({
      companyId: lojaId,
      title,
      body,
      url: URL_DO_PAINEL,
      tag: `pedido-de-cupom-${pedidoId}`,
      data,
      origem,
    });
  } catch (error) {
    console.error(`[${origem}] Falha no aviso do navegador da loja ${lojaId}`, error?.message || String(error));
  }

  return { enviado: true, motivo: null };
}

module.exports = {
  COLECAO_DE_AVISOS,
  KIND_DO_AVISO,
  ORIGEM,
  TEXTO_DO_AVISO,
  URL_DO_PAINEL,
  avisarPedidoDeCupomUmaVez,
  avisoDePedidoDeCupom,
  chaveDoAviso,
  enviarAoAppDoLojista,
  mensagemDoAppDoLojista,
  nomeDoCadastro,
  reservarAvisoDoDia,
};
