import { AppError } from '../../domain/errors/AppError.js';
import { nomeDoErpDaLoja } from './nomeDoErp.js';

// Historico de um produto (cola 65, item 3.5, revisado pelo Thay): fonte unica e o Log das acoes da
// equipe, estabelecimentos/{loja}/AcoesEquipe, no formato de registrarAcao.js do web (em, quem, tela,
// acao, alvo { tipo, id, rotulo }, antes, depois, origem). Sem colecao nova.
//
// So a loja da conta (o repositorio recebe a loja da sessao, nunca do pedido). Linhas do produto:
// alvo.tipo 'produto' e alvo.id igual ao id pedido, da mais nova para a mais antiga. "quem" sai com o
// nome da pessoa na Equipe da loja, o e-mail ou "" (Cola 70, item 8; ver quemEmTexto).

export const LIMITE_PADRAO = 100;
export const LIMITE_MAXIMO = 200;

// Origem gravada -> origem do historico. O web grava 'manual' (clique do lojista); o App
// Gerenciador grava 'app'. As demais (implantacao, automacoes de IA, rotinas do Core) seguem
// com o nome gravado.
export function origemNormalizada(origem) {
  const texto = typeof origem === 'string' ? origem.trim() : '';
  if (!texto) return null;
  if (texto === 'manual' || texto === 'web') return 'web';
  if (texto === 'app') return 'app';
  return texto;
}

function emMilissegundos(valor) {
  if (valor === null || valor === undefined) return null;
  if (typeof valor.toMillis === 'function') return valor.toMillis();
  if (typeof valor.toDate === 'function') return valor.toDate().getTime();
  if (valor instanceof Date) return valor.getTime();
  if (typeof valor.seconds === 'number') return valor.seconds * 1000;
  if (typeof valor._seconds === 'number') return valor._seconds * 1000;
  return null;
}

// Valor do Log para JSON: data vira ISO, referencia vira o caminho, o resto como esta.
export function valorParaResposta(valor) {
  if (valor === undefined || valor === null) return null;
  if (valor instanceof Date || typeof valor.toDate === 'function' || typeof valor.toMillis === 'function') {
    const ms = emMilissegundos(valor);
    return ms === null ? null : new Date(ms).toISOString();
  }
  if (Array.isArray(valor)) return valor.map(valorParaResposta);
  if (typeof valor === 'object') {
    if (typeof valor.path === 'string' && typeof valor.collection === 'function') return valor.path;
    return Object.fromEntries(Object.entries(valor).map(([chave, item]) => [chave, valorParaResposta(item)]));
  }
  return valor;
}

// Um item por campo que mudou: campos do depois e, depois, os que so estao no antes.
export function camposDaLinha(antes, depois) {
  const a = antes && typeof antes === 'object' ? antes : {};
  const d = depois && typeof depois === 'object' ? depois : {};
  const campos = [...new Set([...Object.keys(d), ...Object.keys(a)])];
  return campos.map((campo) => ({
    campo,
    antes: valorParaResposta(a[campo]),
    depois: valorParaResposta(d[campo]),
  }));
}

// ===== "Quem" da linha (Cola 70, item 8) =====
// O Log guarda em quem o e-mail ou o uid de quem agiu (registrarAcao.js do web, importacao do CSV),
// "" nas rotinas e o nome do ERP ("Linear") nas linhas do integrador. A tela mostra:
// - linha do integrador: como gravado ("Linear");
// - pessoa cadastrada na Equipe da loja (AdminUsers): o nome, e so o nome;
// - dono da loja fora da Equipe (Cola 71, item 2; Users de estabelecimentos/{loja}.userReference,
//   reconhecido pelo uid = Users.userAuthId ou pelo e-mail = Users.email): o nome do cadastro
//   (Users.name; cadastro antigo: Users.nome); sem nome, o e-mail, como abaixo;
// - e-mail sem cadastro: o e-mail;
// - uid sem cadastro: o e-mail da conta (Users ou Auth); sem e-mail, "" (nunca o uid);
// - texto com espaco (nao e e-mail nem uid): como gravado.
const PARECE_EMAIL = /^[^\s@]+@[^\s@]+$/;

export function tipoDoQuem(quem, origem) {
  const texto = typeof quem === 'string' ? quem.trim() : '';
  if (!texto) return { tipo: 'vazio', texto: '' };
  if (origem === 'integrador') return { tipo: 'erp', texto };
  if (PARECE_EMAIL.test(texto)) return { tipo: 'email', texto };
  if (/\s/.test(texto)) return { tipo: 'nome', texto };
  return { tipo: 'uid', texto };
}

async function semFalha(promessa) {
  try {
    return await promessa;
  } catch {
    return null;
  }
}

const mesmoEmail = (a, b) => Boolean(a && b) && a.trim().toLowerCase() === b.trim().toLowerCase();

// Nome do dono quando a linha e dele (pelo uid ou pelo e-mail); null quando nao e ou sem nome.
async function nomeDoDono(dono, { uid = null, email = null }) {
  const d = await dono();
  if (!d) return null;
  const eDele = Boolean(uid && d.uid === uid) || mesmoEmail(email, d.email);
  return eDele ? d.nome || null : null;
}

async function quemEmTexto(repositorio, lojaId, { tipo, texto }, dono) {
  if (tipo === 'vazio') return '';
  if (tipo === 'erp' || tipo === 'nome') return texto;
  if (tipo === 'email') {
    return (await semFalha(repositorio.nomeNaEquipePorEmail({ lojaId, email: texto })))
      || (await nomeDoDono(dono, { email: texto }))
      || texto;
  }
  const nome = await semFalha(repositorio.nomeNaEquipePorUid({ lojaId, uid: texto }));
  if (nome) return nome;
  const doDono = await nomeDoDono(dono, { uid: texto });
  if (doDono) return doDono;
  const email = await semFalha(repositorio.emailDoUid(texto));
  if (!email) return '';
  return (await semFalha(repositorio.nomeNaEquipePorEmail({ lojaId, email })))
    || (await nomeDoDono(dono, { email }))
    || email;
}

// Um texto por quem distinto: cada pessoa e lida uma vez so, mesmo com muitas linhas.
async function quensEmTexto(repositorio, lojaId, linhas) {
  const chaves = new Map();
  linhas.forEach((linha) => {
    const quem = tipoDoQuem(linha.quem, linha.origem);
    chaves.set(`${quem.tipo}|${quem.texto}`, quem);
  });
  const textos = new Map();
  // O dono e lido uma vez so, e so se alguma linha precisar (leitura que falha: sem dono).
  let leitura = null;
  const dono = () => {
    if (!leitura) leitura = semFalha(Promise.resolve().then(() => repositorio.donoDaLoja({ lojaId })));
    return leitura;
  };
  await Promise.all([...chaves.entries()].map(async ([chave, quem]) => {
    textos.set(chave, await quemEmTexto(repositorio, lojaId, quem, dono));
  }));
  return (linha) => {
    const quem = tipoDoQuem(linha.quem, linha.origem);
    return textos.get(`${quem.tipo}|${quem.texto}`) ?? '';
  };
}

// Nome do ERP da loja (Cola 71, item 3; regra em nomeDoErp.js). Leitura que falha: null.
async function nomeDoErpDaLojaSemFalha(repositorio, lojaId) {
  const configuracao = await semFalha(Promise.resolve().then(() => repositorio.configuracaoDoErp({ lojaId })));
  return configuracao ? nomeDoErpDaLoja(configuracao.loja, configuracao.status) : null;
}

function lojaDoAtor(ator) {
  const lojaId = ator?.establishmentId;
  if (!lojaId || ator?.hasEstablishment === false) {
    throw new AppError('Conta sem estabelecimento ativo.', { statusCode: 403, code: 'data_establishment_required' });
  }
  return lojaId;
}

function produtoValido(produtoId) {
  const texto = typeof produtoId === 'string' ? produtoId.trim() : '';
  if (!texto || texto.length > 200 || texto.includes('/')) {
    throw new AppError('Produto inválido.', { statusCode: 400, code: 'historico_produto_invalido' });
  }
  return texto;
}

export class HistoricoDoProduto {
  constructor({ repositorio }) {
    this.repositorio = repositorio;
  }

  async listar({ ator, produtoId, limite = LIMITE_PADRAO }) {
    const lojaId = lojaDoAtor(ator);
    const id = produtoValido(produtoId);
    const maximo = Math.min(Math.max(Number.parseInt(limite, 10) || LIMITE_PADRAO, 1), LIMITE_MAXIMO);
    const { linhas, completo } = await this.repositorio.linhasDoProduto({ lojaId, produtoId: id, limite: maximo });
    const doProduto = (linhas || [])
      .filter((linha) => linha?.alvo?.tipo === 'produto' && linha?.alvo?.id === id)
      .sort((a, b) => (emMilissegundos(b.em) ?? -Infinity) - (emMilissegundos(a.em) ?? -Infinity))
      .slice(0, maximo);
    const [quemDaLinha, erp] = await Promise.all([
      quensEmTexto(this.repositorio, lojaId, doProduto),
      nomeDoErpDaLojaSemFalha(this.repositorio, lojaId),
    ]);
    return {
      produtoId: id,
      completo: completo !== false,
      // Cola 71, item 3: nome do ERP da loja ("Linear") para o motivo fora_do_erp ("fora do
      // Linear"); sem ERP conhecido, null e o web nao mostra esse motivo.
      nomeDoErp: erp,
      linhas: doProduto.map((linha) => {
        const em = emMilissegundos(linha.em);
        return {
          id: linha.id,
          quando: em === null ? null : new Date(em).toISOString(),
          // Nome na Equipe, e-mail ou "" (Cola 70, item 8); nunca o uid.
          quem: quemDaLinha(linha),
          origem: origemNormalizada(linha.origem),
          origemGravada: typeof linha.origem === 'string' ? linha.origem : null,
          acao: typeof linha.acao === 'string' ? linha.acao : '',
          tela: typeof linha.tela === 'string' ? linha.tela : '',
          // Linhas do ERP (decisao do Thay de 20/11): a nuvem grava quem = nome do ERP ("Linear"),
          // origem 'integrador' e, quando houver, a frase da mudanca em motivo (ex.: "marcado como
          // pesavel no Linear"). Sem motivo, null.
          motivo: typeof linha.motivo === 'string' && linha.motivo.trim() ? linha.motivo : null,
          campos: camposDaLinha(linha.antes, linha.depois),
        };
      }),
    };
  }
}
