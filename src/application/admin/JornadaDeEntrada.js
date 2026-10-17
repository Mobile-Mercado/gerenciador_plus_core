import { AppError } from '../../domain/errors/AppError.js';
import { COLECAO_PEDIDOS } from '../cadastro/CadastroDeLoja.js';
import { COLECAO_JORNADAS, SITUACAO } from '../cadastro/JornadaDoCadastro.js';
import { NAO_IDENTIFICADA, chaveDoMunicipio, iniciaisMaiusculas } from '../../domain/cadastro/municipio.js';

// Tela "Jornada de entrada (App Gerenciador)" do Admin (cola 23.1, 17/10/2026). So leitura do que
// a jornada do cadastro ja grava: nenhuma gravacao ao abrir a tela.
//
// Turma do periodo: instalacoes cuja jornada nasceu (criadoEm) nos ultimos 7, 30 ou 90 dias.
// Todas as contas da tela saem dessa mesma turma, para a perda entre as telas fechar.
//
// Corte dos acessos (regra do Thay de 17/10): instalacao de lojista que ja e cliente da plataforma
// nao conta. Sinal: abertura feita com o app logado numa conta com loja aprovada (ou loja antiga,
// sem status), marcada na jornada como lojistaCliente (ClienteDaPlataforma). Instalacao que fez o
// proprio cadastro pelo app conta sempre, mesmo que depois vire cliente.
export const PERIODOS = Object.freeze([7, 30, 90]);
const DIA_MS = 24 * 60 * 60 * 1000;
const EMAIL_CONFIRMADO = new Set(['em_analise', 'em_conversa', 'aprovada', 'recusada']);

const TELAS = Object.freeze([
  { chave: 'abertura', tela: 'Abertura' },
  { chave: 'dados', tela: 'Dados do dono' },
  { chave: 'cnpj', tela: 'CNPJ e senha' },
  { chave: 'endereco', tela: 'Endereço e fachada' },
  { chave: 'pedido', tela: 'Pedido enviado' },
  { chave: 'email', tela: 'E-mail confirmado' },
  { chave: 'aprovado', tela: 'Aprovado' },
]);

function emMs(valor) {
  if (!valor) return null;
  if (typeof valor.toMillis === 'function') return valor.toMillis();
  if (typeof valor.toDate === 'function') return valor.toDate().getTime();
  if (valor instanceof Date) return valor.getTime();
  return null;
}

function emIso(valor) {
  const ms = emMs(valor);
  return ms === null ? null : new Date(ms).toISOString();
}

function media(lista) {
  const validos = lista.filter((valor) => Number.isFinite(valor) && valor >= 0);
  if (!validos.length) return null;
  return Math.round(validos.reduce((soma, valor) => soma + valor, 0) / validos.length / 1000);
}

// Cidade do acesso (aproximada), mandada pelo app; vem em minusculas e as vezes sem acento.
function localDoAcesso(jornada) {
  const acesso = jornada.cidadeAcesso;
  if (acesso && typeof acesso === 'object') return { cidade: acesso.cidade || null, uf: acesso.uf || jornada.ufAcesso || null };
  return { cidade: typeof acesso === 'string' ? acesso : null, uf: jornada.ufAcesso || null };
}

// Agrupa pela chave do municipio (sem acento e sem maiuscula). Nome na tela: o da Receita quando
// ha o mesmo municipio; sem par, iniciais maiusculas.
function contarPorLocal(itens, nomesDaReceita = new Map()) {
  const contagem = new Map();
  itens.forEach((local) => {
    const chave = chaveDoMunicipio(local.cidade, local.uf);
    const nome = local.cidade ? nomesDaReceita.get(chave) || iniciaisMaiusculas(local.cidade) : NAO_IDENTIFICADA;
    const atual = contagem.get(chave) || { cidade: nome, uf: local.cidade ? String(local.uf || '').toUpperCase() || null : null, quantidade: 0 };
    // Sem par na Receita, fica a grafia com acento quando alguma abertura a trouxe.
    const acentos = (texto) => (String(texto).normalize('NFD').match(/[̀-ͯ]/g) || []).length;
    if (local.cidade && !nomesDaReceita.has(chave) && acentos(nome) > acentos(atual.cidade)) atual.cidade = nome;
    atual.quantidade += 1;
    contagem.set(chave, atual);
  });
  return [...contagem.values()].sort((a, b) => b.quantidade - a.quantidade || String(a.cidade).localeCompare(String(b.cidade)));
}

export class JornadaDeEntrada {
  constructor({ firestore, clock = () => Date.now() }) {
    this.firestore = firestore;
    this.clock = clock;
  }

  async ler({ periodo = 30, uf = null } = {}) {
    const dias = Number(periodo);
    if (!PERIODOS.includes(dias)) throw new AppError('Período inválido.', { statusCode: 400, code: 'jornada_periodo_invalido' });
    const estado = uf ? String(uf).trim().toUpperCase() : null;
    if (estado && !/^[A-Z]{2}$/.test(estado)) throw new AppError('Estado inválido.', { statusCode: 400, code: 'jornada_estado_invalido' });

    const ate = this.clock();
    const desde = ate - dias * DIA_MS;
    const snapshot = await this.firestore.collection(COLECAO_JORNADAS).where('criadoEm', '>=', new Date(desde)).get();
    const todas = snapshot.docs.map((documento) => ({ id: documento.id, ...documento.data() }));

    // Estado: o da Receita (a partir do CNPJ) ou, sem ele, o do acesso.
    const ufDaJornada = (jornada) => jornada.ufReceita || localDoAcesso(jornada).uf || null;
    const doEstado = estado ? todas.filter((jornada) => ufDaJornada(jornada) === estado) : todas;
    const cortada = (jornada) => jornada.lojistaCliente === true && !jornada.comecouEm;
    const turma = doEstado.filter((jornada) => !cortada(jornada));

    // Pedido de loja de quem criou a conta (pedidosDeLoja): e-mail confirmado (enviadoEm) e
    // aprovado (status e aprovadoEm) saem dele. A loja so existe depois do "Aprovar".
    const pedidoIds = [...new Set(turma.map((jornada) => jornada.pedidoId).filter(Boolean))];
    const pedidos = new Map();
    if (pedidoIds.length) {
      const leituras = await this.firestore.getAll(...pedidoIds.map((id) => this.firestore.collection(COLECAO_PEDIDOS).doc(id)));
      leituras.filter((pedido) => pedido.exists).forEach((pedido) => pedidos.set(pedido.id, pedido.data() || {}));
    }

    const chegou = (jornada) => {
      const passos = jornada.passos || {};
      const dados = jornada.dados || {};
      const concluido = jornada.situacao === SITUACAO.CONCLUIDO && Boolean(jornada.pedidoId);
      const loja = jornada.pedidoId ? pedidos.get(jornada.pedidoId) : null;
      return {
        abertura: true,
        dados: concluido || Boolean(passos['1'] || dados.passo1),
        cnpj: concluido || Boolean(passos['2'] || dados.passo2),
        endereco: concluido || Boolean(passos['3'] || dados.passo3),
        pedido: concluido,
        email: concluido && Boolean(loja && (EMAIL_CONFIRMADO.has(loja.status) || loja.enviadoEm)),
        aprovado: concluido && loja?.status === 'aprovada',
      };
    };
    // Tempo na tela: da primeira entrada nela ate a primeira entrada na tela seguinte.
    const marcos = (jornada) => {
      const loja = jornada.pedidoId ? pedidos.get(jornada.pedidoId) : null;
      const entrada = (passo) => emMs(jornada.passos?.[passo]?.primeiraEntrada);
      return {
        abertura: emMs(jornada.primeiraAbertura) ?? emMs(jornada.criadoEm),
        dados: entrada('1') ?? emMs(jornada.comecouEm),
        cnpj: entrada('2'),
        endereco: entrada('3'),
        pedido: emMs(jornada.concluidoEm),
        email: emMs(loja?.enviadoEm),
        aprovado: emMs(loja?.aprovadoEm),
      };
    };

    const linhas = turma.map((jornada) => ({ jornada, chegou: chegou(jornada), marcos: marcos(jornada) }));
    const funil = TELAS.map(({ chave, tela }, indice) => {
      const pessoas = linhas.filter((linha) => linha.chegou[chave]).length;
      const anterior = indice ? linhas.filter((linha) => linha.chegou[TELAS[indice - 1].chave]).length : null;
      const seguinte = TELAS[indice + 1]?.chave;
      const tempos = seguinte
        ? linhas.filter((linha) => linha.chegou[seguinte]).map((linha) => linha.marcos[seguinte] - linha.marcos[chave])
        : [];
      return {
        chave,
        tela,
        pessoas,
        perda: anterior === null ? null : anterior - pessoas,
        perdaPct: anterior ? Math.round(((anterior - pessoas) / anterior) * 1000) / 10 : null,
        tempoMedioSeg: seguinte ? media(tempos) : null,
      };
    });

    const contas = linhas.filter((linha) => linha.chegou.pedido);
    const leads = linhas.filter((linha) => linha.chegou.cnpj);
    const localDaReceita = ({ jornada }) => {
      const loja = jornada.pedidoId ? pedidos.get(jornada.pedidoId) : null;
      return {
        cidade: jornada.cidadeReceita || loja?.enderecoReceita?.city || null,
        uf: jornada.ufReceita || loja?.enderecoReceita?.uf || null,
      };
    };

    // Nome da Receita de cada municipio da turma, para a cidade do acesso aparecer igual.
    const nomesDaReceita = new Map();
    linhas.map(localDaReceita).filter((local) => local.cidade)
      .forEach((local) => nomesDaReceita.set(chaveDoMunicipio(local.cidade, local.uf), local.cidade));

    return {
      periodo: { dias, desde: new Date(desde).toISOString(), ate: new Date(ate).toISOString() },
      estado,
      resumo: {
        acessos: turma.length,
        acessosSemCorte: doEstado.length,
        instalacoesDeClientesCortadas: doEstado.length - turma.length,
        contas: contas.length,
        clientes: linhas.filter((linha) => linha.chegou.aprovado).length,
        tempoMedioCadastroSeg: media(contas.map(({ jornada }) => emMs(jornada.concluidoEm) - emMs(jornada.comecouEm))),
      },
      funil,
      porLocal: {
        acessos: contarPorLocal(linhas.map(({ jornada }) => localDoAcesso(jornada)), nomesDaReceita),
        leads: contarPorLocal(leads.map(localDaReceita), nomesDaReceita),
        aprovados: contarPorLocal(linhas.filter((linha) => linha.chegou.aprovado).map(localDaReceita), nomesDaReceita),
      },
      leadsNaoConcluidos: leads
        .filter(({ jornada }) => jornada.situacao !== SITUACAO.CONCLUIDO)
        .map(({ jornada }) => ({
          instalacaoId: jornada.id,
          situacao: jornada.situacao || SITUACAO.EM_ANDAMENTO,
          etapa: Number(jornada.ultimoPassoComDados) || 0,
          nome: jornada.dados?.passo1?.nome || null,
          celular: jornada.dados?.passo1?.celular || null,
          email: jornada.dados?.passo1?.email || null,
          // Os mesmos da lista pedidos-de-loja?lista=incompletos (linhaDoIncompleto).
          erp: jornada.dados?.passo1?.erp || null,
          cidadeAcesso: jornada.cidadeAcesso ?? null,
          cnpj: jornada.dados?.passo2?.cnpj || null,
          razaoSocial: jornada.dados?.passo2?.receita?.razaoSocial || null,
          cidadeReceita: jornada.cidadeReceita || null,
          ufReceita: jornada.ufReceita || null,
          atualizadoEm: emIso(jornada.atualizadoEm),
          marcadoEm: emIso(jornada.marcadoEm),
        }))
        .sort((a, b) => String(b.atualizadoEm || '').localeCompare(String(a.atualizadoEm || ''))),
    };
  }
}
