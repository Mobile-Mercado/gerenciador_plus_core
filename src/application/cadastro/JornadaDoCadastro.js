import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { AppError } from '../../domain/errors/AppError.js';
import {
  validarCidadeAcesso, validarHoraDoAparelho, validarInstalacaoId, validarRascunho,
} from '../../domain/cadastro/validacoes.js';

// Jornada do cadastro de loja pelo app gerenciador (ordem nova de 16/10/2026): funil do Admin.
//
//   jornadasCadastro/{instalacaoId}            uma instalacao do app: passos (entrada e saida de
//                                              cada um), dados preenchidos ate onde a pessoa foi
//                                              e situacao (em_andamento, concluido, descartado,
//                                              em_conversa; null enquanto so abriu o app)
//   jornadasCadastro/{instalacaoId}/eventos/*  cada evento com a hora do servidor e a do aparelho;
//                                              expiraEm e o campo da politica de TTL
//   funilCadastro/{aaaa-mm-dd}                 contadores do dia (fuso de Sao Paulo), para o
//                                              funil nao ler a colecao inteira
//
// Eventos nao levam dado pessoal. Dados pessoais entram so pelo rascunho, a partir do passo 1
// com o aceite dos termos. Nunca grava senha nem endereco de rede (o limite por IP guarda so o
// hash, em limitesCadastro, como o resto do cadastro).
export const COLECAO_JORNADAS = 'jornadasCadastro';
export const COLECAO_EVENTOS = 'eventos';
export const COLECAO_FUNIL = 'funilCadastro';
export const TIPOS_DE_EVENTO = Object.freeze(['abertura', 'comecar', 'entrou_passo', 'saiu_passo', 'retomou']);
export const PASSOS = Object.freeze([1, 2, 3]);
export const SITUACAO = Object.freeze({
  EM_ANDAMENTO: 'em_andamento',
  CONCLUIDO: 'concluido',
  DESCARTADO: 'descartado',
  EM_CONVERSA: 'em_conversa',
});
// Situacoes que o Admin marca nos cadastros incompletos (e desmarca de volta para em andamento).
export const SITUACOES_DO_ADMIN = Object.freeze([SITUACAO.EM_ANDAMENTO, SITUACAO.EM_CONVERSA, SITUACAO.DESCARTADO]);
const DIAS_DOS_EVENTOS = 180;
const DIA_MS = 24 * 60 * 60 * 1000;
const TIME_ZONE = 'America/Sao_Paulo';
const formatadorDoDia = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

export const NAO_IDENTIFICADA = 'Não identificada';

// Chave da cidade nos contadores do dia ("Vitória - ES"), sem os caracteres que o Firestore nao
// aceita em nome de campo. Sem cidade: "Não identificada".
export function chaveDaCidade(cidade, uf) {
  const nome = String(cidade || '').replace(/[./[\]*~`]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!nome) return NAO_IDENTIFICADA;
  return uf ? `${nome} - ${uf}` : nome;
}

export function diaDoFunil(data) {
  return formatadorDoDia.format(data);
}

function recusa(mensagem, code, statusCode = 400) {
  return new AppError(mensagem, { statusCode, code });
}

function passoDoEvento(tipo, passo) {
  if (tipo !== 'entrou_passo' && tipo !== 'saiu_passo') return null;
  const numero = Number(passo);
  if (!PASSOS.includes(numero)) throw recusa('Passo do cadastro inválido.', 'cadastro_passo_invalido');
  return numero;
}

function quandoIso(valor) {
  if (!valor) return null;
  if (typeof valor.toDate === 'function') return valor.toDate().toISOString();
  if (valor instanceof Date) return valor.toISOString();
  return null;
}

export class JornadaDoCadastro {
  constructor({
    firestore,
    limites = null,
    clock = () => Date.now(),
    serverTimestamp = () => FieldValue.serverTimestamp(),
    incremento = (valor) => FieldValue.increment(valor),
    paraData = (ms) => Timestamp.fromMillis(ms),
  }) {
    this.firestore = firestore;
    this.limites = limites;
    this.clock = clock;
    this.serverTimestamp = serverTimestamp;
    this.incremento = incremento;
    this.paraData = paraData;
  }

  jornadaRef(instalacaoId) {
    return this.firestore.collection(COLECAO_JORNADAS).doc(instalacaoId);
  }

  funilRef(dia) {
    return this.firestore.collection(COLECAO_FUNIL).doc(dia);
  }

  // Contadores do dia: um set com merge e incremento, sem leitura.
  contadoresDoDia(transacao, contadores) {
    if (!Object.keys(contadores).length) return;
    const dia = diaDoFunil(new Date(this.clock()));
    transacao.set(this.funilRef(dia), { dia, ...contadores, atualizadoEm: this.serverTimestamp() }, { merge: true });
  }

  // `cliente`: { lojaId } quando a abertura veio de lojista logado que ja e cliente da plataforma
  // (ClienteDaPlataforma). Marca a instalacao para o corte dos acessos da tela do Admin.
  async registrarEvento({
    instalacaoId: entradaId, tipo, passo, horaDoAparelho, cidadeAcesso: cidadeEnviada,
  } = {}, { ip = null, cliente = null } = {}) {
    const instalacaoId = validarInstalacaoId(entradaId);
    if (!TIPOS_DE_EVENTO.includes(tipo)) throw recusa('Evento do cadastro inválido.', 'cadastro_evento_invalido');
    const numero = passoDoEvento(tipo, passo);
    const horaAparelho = validarHoraDoAparelho(horaDoAparelho);
    // Cidade do acesso (aproximada), mandada pelo app na abertura. Sem ela, null.
    const cidadeAcesso = tipo === 'abertura' ? validarCidadeAcesso(cidadeEnviada) : null;
    await this.limites?.registrar([{ tipo: 'jornada', valor: ip }]);

    const agoraMs = this.clock();
    const hoje = diaDoFunil(new Date(agoraMs));
    const agora = this.serverTimestamp();
    const ref = this.jornadaRef(instalacaoId);
    await this.firestore.runTransaction(async (transacao) => {
      const atual = await transacao.get(ref);
      const jornada = atual.exists ? atual.data() : null;
      const um = this.incremento(1);
      const mudancas = { instalacaoId, atualizadoEm: agora };
      const contadores = {};
      if (!jornada) {
        Object.assign(mudancas, { situacao: null, criadoEm: agora, aberturas: 0, retomadas: 0 });
        contadores.instalacoesNovas = um;
      }
      if (tipo === 'abertura') {
        // Cidade do acesso como o app mandou ({ cidade, uf }) ou null; nunca o IP.
        Object.assign(mudancas, {
          aberturas: this.incremento(1), ultimaAbertura: agora, ultimaAberturaDia: hoje, cidadeAcesso, ufAcesso: cidadeAcesso?.uf || null,
        });
        if (!jornada?.primeiraAbertura) mudancas.primeiraAbertura = agora;
        contadores.aberturas = um;
        contadores.aberturasPorCidade = { [chaveDaCidade(cidadeAcesso?.cidade, cidadeAcesso?.uf)]: this.incremento(1) };
        if (jornada?.ultimaAberturaDia !== hoje) contadores.instalacoesAbertas = this.incremento(1);
        if (cliente?.lojaId) Object.assign(mudancas, { lojistaCliente: true, lojistaLojaId: cliente.lojaId, lojistaVistoEm: agora });
      }
      const comecando = (tipo === 'comecar' || numero !== null) && !jornada?.situacao;
      if (comecando) {
        mudancas.situacao = SITUACAO.EM_ANDAMENTO;
        if (!jornada?.comecouEm) {
          mudancas.comecouEm = agora;
          contadores.cadastrosComecados = this.incremento(1);
        }
      }
      if (tipo === 'comecar') contadores.comecar = this.incremento(1);
      if (tipo === 'retomou') {
        mudancas.retomadas = this.incremento(1);
        contadores.retomou = this.incremento(1);
      }
      if (numero !== null) {
        const chave = String(numero);
        const anterior = jornada?.passos?.[chave] || {};
        if (tipo === 'entrou_passo') {
          mudancas.passoAtual = numero;
          mudancas.passos = { [chave]: { entradas: this.incremento(1), ultimaEntrada: agora, ...(anterior.primeiraEntrada ? {} : { primeiraEntrada: agora }) } };
          contadores.entrouPasso = { [chave]: this.incremento(1) };
        } else {
          mudancas.passos = { [chave]: { saidas: this.incremento(1), ultimaSaida: agora } };
          contadores.saiuPasso = { [chave]: this.incremento(1) };
        }
      }
      transacao.set(ref, mudancas, { merge: true });
      transacao.set(ref.collection(COLECAO_EVENTOS).doc(), {
        tipo,
        passo: numero,
        horaDoAparelho: horaAparelho,
        em: agora,
        ...(tipo === 'abertura' ? { cidadeAcesso } : {}),
        expiraEm: this.paraData(agoraMs + DIAS_DOS_EVENTOS * DIA_MS),
      });
      this.contadoresDoDia(transacao, contadores);
    });
    return { instalacaoId, tipo, passo: numero };
  }

  async gravarRascunho({ instalacaoId: entradaId, passo, dados } = {}, { ip = null } = {}) {
    const instalacaoId = validarInstalacaoId(entradaId);
    const numero = Number(passo);
    if (!PASSOS.includes(numero)) throw recusa('Passo do cadastro inválido.', 'cadastro_passo_invalido');
    const validos = validarRascunho(numero, dados || {});
    await this.limites?.registrar([{ tipo: 'jornada', valor: ip }]);

    const agora = this.serverTimestamp();
    const ref = this.jornadaRef(instalacaoId);
    await this.firestore.runTransaction(async (transacao) => {
      const atual = await transacao.get(ref);
      const jornada = atual.exists ? atual.data() : null;
      if (numero > 1 && jornada?.dados?.passo1?.aceiteTermos?.aceito !== true) {
        throw recusa('Volte ao passo 1 e aceite os termos para continuar.', 'cadastro_rascunho_sem_aceite', 409);
      }
      if (jornada?.situacao === SITUACAO.CONCLUIDO) {
        throw recusa('Este cadastro já foi concluído.', 'cadastro_rascunho_concluido', 409);
      }
      const passoDados = { ...validos, recebidoEm: agora };
      if (numero === 1) passoDados.aceiteTermos = { ...validos.aceiteTermos, registradoEm: agora };
      const mudancas = {
        instalacaoId,
        atualizadoEm: agora,
        dados: { [`passo${numero}`]: passoDados },
        ultimoPassoComDados: Math.max(numero, Number(jornada?.ultimoPassoComDados) || 0),
      };
      if (!jornada) Object.assign(mudancas, { criadoEm: agora, aberturas: 0, retomadas: 0 });
      // Descartado ou em conversa ficam como o Admin marcou; o resto passa a em andamento.
      if (!jornada?.situacao) mudancas.situacao = SITUACAO.EM_ANDAMENTO;
      if (!jornada?.comecouEm) mudancas.comecouEm = agora;
      if (numero === 2) {
        mudancas.cidadeReceita = validos.receita.endereco.city;
        mudancas.ufReceita = validos.receita.endereco.uf;
      }
      transacao.set(ref, mudancas, { merge: true });
      const primeiraVez = !jornada?.dados?.[`passo${numero}`];
      const contadores = primeiraVez ? { rascunhoPasso: { [String(numero)]: this.incremento(1) } } : {};
      // Quem chega ao passo 2: CNPJs por cidade da Receita, uma vez por instalacao.
      if (numero === 2 && primeiraVez) {
        contadores.cnpjsPorCidade = { [chaveDaCidade(validos.receita.endereco.city, validos.receita.endereco.uf)]: this.incremento(1) };
      }
      this.contadoresDoDia(transacao, contadores);
    });
    return { instalacaoId, passo: numero };
  }

  // Pedido completo criado (POST /loja): a instalacao vira concluido e guarda o id do pedido.
  // A loja so nasce no "Aprovar" do Admin, que grava o id dela (aprovada).
  async concluir(instalacaoId, pedidoId) {
    if (!instalacaoId) return false;
    const agora = this.serverTimestamp();
    const ref = this.jornadaRef(instalacaoId);
    await this.firestore.runTransaction(async (transacao) => {
      const atual = await transacao.get(ref);
      if (atual.exists && atual.data()?.situacao === SITUACAO.CONCLUIDO && atual.data()?.pedidoId === pedidoId) return;
      transacao.set(ref, {
        instalacaoId,
        situacao: SITUACAO.CONCLUIDO,
        pedidoId,
        concluidoEm: agora,
        atualizadoEm: agora,
        ...(atual.exists ? {} : { criadoEm: agora, aberturas: 0, retomadas: 0 }),
      }, { merge: true });
      // Contas criadas por cidade da Receita (a do passo 2; sem ela, "Não identificada").
      const jornada = atual.exists ? atual.data() : {};
      this.contadoresDoDia(transacao, {
        concluidos: this.incremento(1),
        contasPorCidade: { [chaveDaCidade(jornada.cidadeReceita, jornada.ufReceita)]: this.incremento(1) },
      });
    });
    return true;
  }

  // "Aprovar" do Admin: a instalacao guarda o id da loja criada.
  async aprovada(instalacaoId, lojaId) {
    if (!instalacaoId) return false;
    const ref = this.jornadaRef(instalacaoId);
    const atual = await ref.get();
    if (!atual.exists) return false;
    const agora = this.serverTimestamp();
    await ref.set({ lojaId, aprovadaEm: agora, atualizadoEm: agora }, { merge: true });
    return true;
  }

  // Admin: marca "Em conversa" ou "Descartar" (ou volta para em andamento). So marca, nao apaga.
  async marcar(instalacaoId, situacao, ator = {}) {
    if (!SITUACOES_DO_ADMIN.includes(situacao)) throw recusa('Situação inválida.', 'cadastro_situacao_invalida');
    const ref = this.jornadaRef(String(instalacaoId || ''));
    const agora = this.serverTimestamp();
    await this.firestore.runTransaction(async (transacao) => {
      const atual = await transacao.get(ref);
      const jornada = atual.exists ? atual.data() : null;
      if (!jornada?.dados?.passo1) {
        throw recusa('Cadastro incompleto não encontrado.', 'cadastro_incompleto_nao_encontrado', 404);
      }
      if (jornada.situacao === SITUACAO.CONCLUIDO) {
        throw recusa('Este cadastro já virou pedido de loja.', 'cadastro_ja_concluido', 409);
      }
      if (jornada.situacao === situacao) return;
      transacao.set(ref, {
        situacao,
        marcadoPor: ator.uid || null,
        marcadoEm: agora,
        atualizadoEm: agora,
      }, { merge: true });
      const contador = { [SITUACAO.DESCARTADO]: 'descartados', [SITUACAO.EM_CONVERSA]: 'emConversa' }[situacao];
      this.contadoresDoDia(transacao, contador ? { [contador]: this.incremento(1) } : {});
    });
    return linhaDoIncompleto(await ref.get());
  }

  // Lista do Admin: cadastros com dados (a partir do passo 1) que nao viraram pedido.
  async listarIncompletos(lista = 'incompletos') {
    const situacoes = lista === 'descartados' ? [SITUACAO.DESCARTADO] : [SITUACAO.EM_ANDAMENTO, SITUACAO.EM_CONVERSA];
    const resultados = await Promise.all(situacoes.map((situacao) => this.firestore
      .collection(COLECAO_JORNADAS).where('situacao', '==', situacao).get()));
    return resultados.flatMap((resultado) => resultado.docs)
      .filter((documento) => documento.data()?.dados?.passo1)
      .map(linhaDoIncompleto)
      .sort((a, b) => String(b.atualizadoEm || '').localeCompare(String(a.atualizadoEm || '')));
  }
}

export function linhaDoIncompleto(documento) {
  const data = documento.data() || {};
  const passo1 = data.dados?.passo1 || {};
  const passo2 = data.dados?.passo2 || {};
  const passo3 = data.dados?.passo3 || {};
  return {
    tipo: 'incompleto',
    instalacaoId: documento.id,
    situacao: data.situacao || null,
    // Etapa em que parou: o ultimo passo com dados gravados (as bolinhas 1, 2 e 3 do Admin).
    etapa: Number(data.ultimoPassoComDados) || 0,
    passoAtual: Number(data.passoAtual) || null,
    dados: {
      nome: passo1.nome || null,
      celular: passo1.celular || null,
      email: passo1.email || null,
      erp: passo1.erp || null,
      cnpj: passo2.cnpj || null,
      razaoSocial: passo2.receita?.razaoSocial || null,
      nomeFantasia: passo2.receita?.nomeFantasia || null,
      cnpjAtivo: passo2.receita?.ativa ?? null,
      endereco: passo3.endereco || null,
    },
    cidadeReceita: data.cidadeReceita || null,
    ufReceita: data.ufReceita || null,
    cidadeAcesso: data.cidadeAcesso ?? null,
    criadoEm: quandoIso(data.criadoEm),
    comecouEm: quandoIso(data.comecouEm),
    atualizadoEm: quandoIso(data.atualizadoEm),
    ultimaAbertura: quandoIso(data.ultimaAbertura),
    aceiteTermosEm: quandoIso(passo1.aceiteTermos?.registradoEm),
    marcadoEm: quandoIso(data.marcadoEm),
  };
}
