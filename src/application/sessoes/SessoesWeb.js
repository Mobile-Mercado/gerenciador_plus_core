import { randomUUID } from 'node:crypto';
import { AppError } from '../../domain/errors/AppError.js';
import { navegadorDoAgente, sistemaDoAgente } from '../../domain/sessoes/navegadorDoAgente.js';

// Item 5.10 "Acessos conectados" (aprovado pelo Thay em 20/11; plano construcao-acessos-conectados.md).
// Cada navegador tem uma sessao propria (sessaoId no localStorage, igual em todas as abas). O
// Gerenciador Web registra a sessao, manda X-Sessao em toda chamada e um sinal a cada 30 s; o Admin
// da plataforma lista por IP, renomeia, nomeia IP e encerra (uma, todas de um IP, todas da loja).
// Sessao encerrada ou apagada responde 401 sessao_encerrada e o navegador volta ao login.

export const DIAS_SEM_USO = 7;
// Quanto tempo o Core guarda, por instancia, se a sessao esta ativa. Com o sinal de 30 s do
// navegador, o "Sair" do Admin vale em ate 30 s mesmo com outra instancia guardando a resposta.
export const GUARDA_DA_SITUACAO_MS = 10_000;
// ultimoUso so e gravado de novo depois deste intervalo (o sinal chega a cada 30 s por aba).
export const ULTIMO_USO_A_CADA_MS = 60_000;
export const MOTIVO_ADMIN = 'admin';
export const MOTIVO_SEM_USO = 'sem_uso_7_dias';

const FORMATO_DO_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMATO_DO_RETRATO = /^[0-9a-f]{64}$/i;
const NOME_MAXIMO = 40;

export function sessaoEncerrada() {
  return new AppError('Este acesso foi encerrado. Entre novamente.', { statusCode: 401, code: 'sessao_encerrada' });
}

function lojaValida(lojaId) {
  const id = typeof lojaId === 'string' ? lojaId.trim() : '';
  if (!id || id.length > 120 || id.includes('/')) {
    throw new AppError('Loja inválida.', { statusCode: 400, code: 'loja_invalida' });
  }
  return id;
}

export function idValido(sessaoId) {
  return typeof sessaoId === 'string' && FORMATO_DO_ID.test(sessaoId);
}

function ipValido(ip) {
  const texto = typeof ip === 'string' ? ip.trim() : '';
  if (!texto || texto.length > 64 || texto.includes('/')) {
    throw new AppError('IP inválido.', { statusCode: 400, code: 'ip_invalido' });
  }
  return texto;
}

function nomeOuNull(nome) {
  if (nome === null || nome === undefined) return null;
  if (typeof nome !== 'string') throw new AppError('Nome inválido.', { statusCode: 400, code: 'nome_invalido' });
  const texto = nome.replace(/\s+/g, ' ').trim();
  if (texto.length > NOME_MAXIMO) {
    throw new AppError(`O nome pode ter até ${NOME_MAXIMO} letras.`, { statusCode: 400, code: 'nome_invalido' });
  }
  return texto || null;
}

function emData(valor) {
  const data = typeof valor?.toDate === 'function' ? valor.toDate() : valor;
  return data instanceof Date && !Number.isNaN(data.getTime()) ? data : null;
}

function emIso(valor) {
  return emData(valor)?.toISOString() ?? null;
}

export class SessoesWeb {
  constructor({ repositorio, clock = () => new Date(), novoId = () => randomUUID() }) {
    this.repositorio = repositorio;
    this.clock = clock;
    this.novoId = novoId;
    this.guardadas = new Map();
  }

  esquecer(lojaId, sessaoId) {
    this.guardadas.delete(`${lojaId}/${sessaoId}`);
  }

  // Primeira entrada do navegador (ou a volta dele): reaproveita a sessao ativa do mesmo navegador
  // na mesma loja, senao cria outra. Devolve o id que o navegador guarda e o nome (null: o Gerenciador
  // Web pergunta "Nome deste computador").
  async registrar({
    lojaId, uid, sessaoId = null, userAgent = '', versaoDoSistema = null, retrato = null, ip = null,
  }) {
    const loja = lojaValida(lojaId);
    const agora = this.clock();
    const dados = {
      uid,
      ultimoUso: agora,
      navegador: navegadorDoAgente(userAgent),
      sistema: sistemaDoAgente(userAgent, versaoDoSistema),
      retrato: typeof retrato === 'string' && FORMATO_DO_RETRATO.test(retrato) ? retrato.toLowerCase() : null,
      ip: typeof ip === 'string' && ip.trim() ? ip.trim().slice(0, 64) : null,
    };
    if (idValido(sessaoId)) {
      const atual = await this.repositorio.ler({ lojaId: loja, sessaoId });
      if (atual && !atual.encerradaEm) {
        await this.repositorio.atualizar({ lojaId: loja, sessaoId, campos: dados });
        return { sessaoId, nome: atual.nome || null };
      }
    }
    const novo = this.novoId();
    await this.repositorio.criar({ lojaId: loja, sessaoId: novo, dados: { ...dados, nome: null } });
    return { sessaoId: novo, nome: null };
  }

  // 'ativa' ou 'encerrada' (sessao apagada pela limpeza de 7 dias conta como encerrada).
  async situacao({ lojaId, sessaoId }) {
    if (!idValido(sessaoId)) return 'encerrada';
    const chave = `${lojaId}/${sessaoId}`;
    const agora = this.clock().getTime();
    const guardada = this.guardadas.get(chave);
    if (guardada && guardada.ate > agora) return guardada.situacao;
    const sessao = await this.repositorio.ler({ lojaId, sessaoId });
    const situacao = sessao && !sessao.encerradaEm ? 'ativa' : 'encerrada';
    if (this.guardadas.size > 5000) this.guardadas.clear();
    this.guardadas.set(chave, { situacao, ate: agora + GUARDA_DA_SITUACAO_MS });
    return situacao;
  }

  // Sinal de 30 s do navegador: le sempre o banco (sem a guarda), para o "Sair" valer em ate 30 s.
  async sinal({ lojaId, sessaoId, ip = null }) {
    const loja = lojaValida(lojaId);
    if (!idValido(sessaoId)) throw sessaoEncerrada();
    const sessao = await this.repositorio.ler({ lojaId: loja, sessaoId });
    if (!sessao || sessao.encerradaEm) {
      this.guardadas.set(`${loja}/${sessaoId}`, { situacao: 'encerrada', ate: this.clock().getTime() + GUARDA_DA_SITUACAO_MS });
      throw sessaoEncerrada();
    }
    const agora = this.clock();
    const ultimo = emData(sessao.ultimoUso);
    const ipNovo = typeof ip === 'string' && ip.trim() ? ip.trim().slice(0, 64) : null;
    if (!ultimo || agora - ultimo >= ULTIMO_USO_A_CADA_MS || (ipNovo && ipNovo !== sessao.ip)) {
      await this.repositorio.atualizar({ lojaId: loja, sessaoId, campos: { ultimoUso: agora, ...(ipNovo ? { ip: ipNovo } : {}) } });
    }
    return { ativa: true };
  }

  // "Nome deste computador", pela propria loja, so na sessao ativa do proprio navegador.
  async nomearPelaLoja({ lojaId, sessaoId, nome }) {
    const loja = lojaValida(lojaId);
    const texto = nomeOuNull(nome);
    if (!texto) throw new AppError('Digite o nome deste computador.', { statusCode: 400, code: 'nome_invalido' });
    if (!idValido(sessaoId)) throw sessaoEncerrada();
    const sessao = await this.repositorio.ler({ lojaId: loja, sessaoId });
    if (!sessao || sessao.encerradaEm) throw sessaoEncerrada();
    await this.repositorio.atualizar({ lojaId: loja, sessaoId, campos: { nome: texto } });
    return { sessaoId, nome: texto };
  }

  // ===== Admin da plataforma =====

  async assertLoja(lojaId) {
    const loja = lojaValida(lojaId);
    if (!(await this.repositorio.lojaExiste(loja))) {
      throw new AppError('Loja não encontrada.', { statusCode: 404, code: 'loja_nao_encontrada' });
    }
    return loja;
  }

  // Lista agrupada por IP: IP sem nome primeiro (destacado na tela), depois os nomeados; dentro de
  // cada grupo e entre grupos, o uso mais recente primeiro. Navegadores com o mesmo retrato no mesmo
  // IP saem marcados como "mesmo computador". Sessao sem uso ha mais de 7 dias nao aparece (a
  // limpeza diaria apaga).
  async listar({ lojaId }) {
    const loja = await this.assertLoja(lojaId);
    const [sessoes, ips] = await Promise.all([
      this.repositorio.listarAtivas({ lojaId: loja }),
      this.repositorio.listarIpsNomeados({ lojaId: loja }),
    ]);
    const limite = this.clock().getTime() - DIAS_SEM_USO * 86_400_000;
    const nomes = new Map(ips.map((item) => [item.ip, item.nome || null]));
    const grupos = new Map();
    sessoes
      .filter((sessao) => (emData(sessao.ultimoUso)?.getTime() ?? 0) >= limite)
      .forEach((sessao) => {
        const ip = sessao.ip || null;
        if (!grupos.has(ip)) grupos.set(ip, []);
        grupos.get(ip).push(sessao);
      });
    const lista = [...grupos.entries()].map(([ip, doIp]) => {
      const porRetrato = new Map();
      doIp.forEach((sessao) => { if (sessao.retrato) porRetrato.set(sessao.retrato, (porRetrato.get(sessao.retrato) || 0) + 1); });
      const linhas = doIp
        .map((sessao) => ({
          sessaoId: sessao.sessaoId,
          nome: sessao.nome || null,
          navegador: sessao.navegador || 'Navegador',
          sistema: sessao.sistema || null,
          ultimoUso: emIso(sessao.ultimoUso),
          criadoEm: emIso(sessao.criadoEm),
          mesmoComputador: Boolean(sessao.retrato) && porRetrato.get(sessao.retrato) > 1,
        }))
        .sort((a, b) => String(b.ultimoUso).localeCompare(String(a.ultimoUso)));
      return { ip, nome: ip ? (nomes.get(ip) ?? null) : null, sessoes: linhas, ultimoUso: linhas[0]?.ultimoUso ?? null };
    });
    lista.sort((a, b) => (Boolean(a.nome) - Boolean(b.nome)) || String(b.ultimoUso).localeCompare(String(a.ultimoUso)));
    return {
      establishmentId: loja,
      navegadores: lista.reduce((soma, grupo) => soma + grupo.sessoes.length, 0),
      diasSemUso: DIAS_SEM_USO,
      grupos: lista,
    };
  }

  async encerrarVarias(loja, escolhidas, adminUid) {
    const ids = escolhidas.map((sessao) => sessao.sessaoId);
    const encerradas = await this.repositorio.encerrar({ lojaId: loja, sessaoIds: ids, adminUid, motivo: MOTIVO_ADMIN });
    ids.forEach((id) => this.esquecer(loja, id));
    return { establishmentId: loja, encerradas };
  }

  async encerrar({ lojaId, sessaoId, adminUid }) {
    const loja = await this.assertLoja(lojaId);
    const sessao = idValido(sessaoId) ? await this.repositorio.ler({ lojaId: loja, sessaoId }) : null;
    if (!sessao) throw new AppError('Acesso não encontrado.', { statusCode: 404, code: 'sessao_nao_encontrada' });
    if (sessao.encerradaEm) return { establishmentId: loja, encerradas: 0 };
    return this.encerrarVarias(loja, [sessao], adminUid);
  }

  async encerrarDoIp({ lojaId, ip, adminUid }) {
    const loja = await this.assertLoja(lojaId);
    const alvo = ipValido(ip);
    const ativas = await this.repositorio.listarAtivas({ lojaId: loja });
    return this.encerrarVarias(loja, ativas.filter((sessao) => sessao.ip === alvo), adminUid);
  }

  async encerrarTodas({ lojaId, adminUid }) {
    const loja = await this.assertLoja(lojaId);
    return this.encerrarVarias(loja, await this.repositorio.listarAtivas({ lojaId: loja }), adminUid);
  }

  async renomear({ lojaId, sessaoId, nome }) {
    const loja = await this.assertLoja(lojaId);
    const texto = nomeOuNull(nome);
    const sessao = idValido(sessaoId) ? await this.repositorio.ler({ lojaId: loja, sessaoId }) : null;
    if (!sessao || sessao.encerradaEm) throw new AppError('Acesso não encontrado.', { statusCode: 404, code: 'sessao_nao_encontrada' });
    await this.repositorio.atualizar({ lojaId: loja, sessaoId, campos: { nome: texto } });
    return { sessaoId, nome: texto };
  }

  // Nome do IP ("Loja"); nome vazio tira o nome.
  async nomearIp({ lojaId, ip, nome, adminUid }) {
    const loja = await this.assertLoja(lojaId);
    const alvo = ipValido(ip);
    const texto = nomeOuNull(nome);
    await this.repositorio.nomearIp({ lojaId: loja, ip: alvo, nome: texto, adminUid });
    return { ip: alvo, nome: texto };
  }
}
