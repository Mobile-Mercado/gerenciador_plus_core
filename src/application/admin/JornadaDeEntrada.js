import { AppError } from '../../domain/errors/AppError.js';
import { COLECAO_JORNADAS, SITUACAO } from '../cadastro/JornadaDoCadastro.js';

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
const NAO_IDENTIFICADA = 'não identificada';
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

// Cidade do acesso (aproximada). Hoje e null em toda abertura: a fonte esta em teste.
function localDoAcesso(jornada) {
  const acesso = jornada.cidadeAcesso;
  if (acesso && typeof acesso === 'object') return { cidade: acesso.cidade || null, uf: acesso.uf || jornada.ufAcesso || null };
  return { cidade: typeof acesso === 'string' ? acesso : null, uf: jornada.ufAcesso || null };
}

function chaveDoLocal({ cidade, uf }) {
  return cidade ? `${cidade}${uf ? ` - ${uf}` : ''}` : NAO_IDENTIFICADA;
}

function contarPorLocal(itens) {
  const contagem = new Map();
  itens.forEach((local) => {
    const chave = chaveDoLocal(local);
    const atual = contagem.get(chave) || { cidade: local.cidade || NAO_IDENTIFICADA, uf: local.cidade ? local.uf || null : null, quantidade: 0 };
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

    const lojaIds = [...new Set(turma.map((jornada) => jornada.lojaId).filter(Boolean))];
    const lojas = new Map();
    if (lojaIds.length) {
      const leituras = await this.firestore.getAll(...lojaIds.map((id) => this.firestore.collection('estabelecimentos').doc(id)));
      leituras.filter((loja) => loja.exists).forEach((loja) => lojas.set(loja.id, loja.data() || {}));
    }

    const chegou = (jornada) => {
      const passos = jornada.passos || {};
      const dados = jornada.dados || {};
      const concluido = jornada.situacao === SITUACAO.CONCLUIDO && Boolean(jornada.lojaId);
      const loja = jornada.lojaId ? lojas.get(jornada.lojaId) : null;
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
      const loja = jornada.lojaId ? lojas.get(jornada.lojaId) : null;
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
      const loja = jornada.lojaId ? lojas.get(jornada.lojaId) : null;
      return {
        cidade: jornada.cidadeReceita || loja?.enderecoReceita?.city || null,
        uf: jornada.ufReceita || loja?.enderecoReceita?.uf || null,
      };
    };

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
        acessos: contarPorLocal(linhas.map(({ jornada }) => localDoAcesso(jornada))),
        leads: contarPorLocal(leads.map(localDaReceita)),
        aprovados: contarPorLocal(linhas.filter((linha) => linha.chegou.aprovado).map(localDaReceita)),
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
