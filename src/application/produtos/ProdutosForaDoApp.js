import { AppError } from '../../domain/errors/AppError.js';
import { nomeDoErpDaLoja } from './nomeDoErp.js';

// Painel "Produtos fora do app" (cola 65, item 5.1; mockup VYj7czi82zVRBHJzmmJRWK com a revisao de
// 19/11). Um resumo so, lido do banco da loja da sessao, sem gravar nada e sem colecao nova de escrita.
//
// Fontes (nenhuma inventada):
// - Products: offReasons e offReasonsSince (motivo de produto fora do app gravado pela nuvem a
//   partir do integrador 1.0.35; mobile_old_web_platform, services/products/off-reasons.ts, no ar
//   desde 20/11). offReasonsSince[codigo] null = o produto ja estava fora antes: "desde" em branco.
// - Products.retiradoPelaEquipe { tipo: 'ateRepor' | 'lixeira', quem, em, pedido } (cola 65, 4.4).
// - Products.duplicateOf e estabelecimentos/{loja}/ResumoDeProdutos/duplicados { quantidade }
//   (cola 65, 3.1; duplicated-services.ts).
// - IntegrationStatus/current (sinal de vida, pasta e arquivos separados do integrador) e o ultimo
//   IntegrationLogs.receivedAt, para a faixa do integrador, com as mesmas regras dos avisos ao dono
//   (avisos-integrador, integratorAlerts.ts: fechado com o sinal parado ha mais de 15 min; parado com
//   arquivo esperando 30 min sem leitura depois, ou leitura travada) e, pela cola, "sistema sem
//   exportar" = 24 h sem arquivo lido.
// - Promocao: promotionalPrice, promotionStartAt e promotionEndAt do produto.
//
// Sem fonte no banco (ficam com indisponivel: true e quantidade null, e o relatorio da cola anota):
// - "Sem codigo": o produto sem codigo de barras e recusado pela nuvem (3.2) e nao e gravado em
//   lugar nenhum; nao ha contagem guardada.

export const CODIGOS = Object.freeze({
  inativoNaWeb: 'inativo_na_web',
  abaixoEstoqueSeguranca: 'abaixo_estoque_seguranca',
  estoqueZerado: 'estoque_zerado',
  estoqueNegativo: 'estoque_negativo',
  semPreco: 'sem_preco',
  lixeira: 'lixeira',
  foraDoErp: 'fora_do_erp',
});

export const POR_GRUPO = 4; // produtos de cada carrossel no resumo
export const LIMITE_DO_GRUPO = 100; // "Ver todos"
export const LEITURA_DE_PROMOCOES = 500; // promocoes lidas para conferir a data e o preco
export const FECHADO_DEPOIS_MS = 15 * 60 * 1000;
export const ARQUIVO_PARADO_MS = 30 * 60 * 1000;
export const SEM_EXPORTAR_MS = 24 * 60 * 60 * 1000;

const NA_LOJA = ['isTrashed', '==', false];

// Grupos e de onde vem cada um. "acao": entra em "Precisam de ação"; "estoque": em "Desligados pelo
// estoque".
export const GRUPOS = Object.freeze([
  { chave: 'desligadosNoLinear', secao: 'acao', codigo: CODIGOS.inativoNaWeb },
  { chave: 'promocaoNaoAparece', secao: 'acao', promocao: 'foraDoApp' },
  { chave: 'promocaoAcimaDoPreco', secao: 'acao', promocao: 'acimaDoPreco' },
  { chave: 'semPreco', secao: 'acao', codigo: CODIGOS.semPreco },
  { chave: 'desligadosAMao', secao: 'acao', marca: true },
  { chave: 'duplicados', secao: 'acao', duplicados: true },
  { chave: 'semCodigo', secao: 'acao', semFonte: true },
  { chave: 'abaixoEstoqueSeguranca', secao: 'estoque', codigo: CODIGOS.abaixoEstoqueSeguranca, soContagem: true },
  { chave: 'estoqueZerado', secao: 'estoque', codigo: CODIGOS.estoqueZerado, soContagem: true },
  { chave: 'estoqueNegativo', secao: 'estoque', codigo: CODIGOS.estoqueNegativo, soContagem: true },
]);

function emMs(valor) {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  if (typeof valor.toMillis === 'function') return valor.toMillis();
  if (typeof valor.toDate === 'function') return valor.toDate().getTime();
  if (valor instanceof Date) return valor.getTime();
  if (typeof valor === 'string') {
    const ms = Date.parse(valor);
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof valor.seconds === 'number') return valor.seconds * 1000;
  if (typeof valor._seconds === 'number') return valor._seconds * 1000;
  return null;
}

const iso = (valor) => {
  const ms = emMs(valor);
  return ms === null ? null : new Date(ms).toISOString();
};

const numero = (valor) => (typeof valor === 'number' && Number.isFinite(valor) ? valor : null);
const texto = (valor) => (typeof valor === 'string' ? valor.trim() : '');

function fotoDoProduto(produto) {
  const imagem = Array.isArray(produto?.images) ? produto.images[0] : null;
  return texto(imagem?.fileUrl) || texto(imagem?.url) || texto(imagem?.downloadURL) || null;
}

// O que o card do carrossel mostra: nome, codigos, preco e foto; o motivo vem de cada grupo.
export function produtoDoCartao(produto, motivo = {}) {
  return {
    id: produto.id,
    nome: texto(produto.name),
    codigo: texto(produto.externalId) || null,
    ean: texto(produto.barCode) || null,
    preco: numero(produto.currentPrice),
    foto: fotoDoProduto(produto),
    motivo,
  };
}

function lojaDoAtor(ator) {
  const lojaId = ator?.establishmentId;
  if (!lojaId || ator?.hasEstablishment === false) {
    throw new AppError('Conta sem estabelecimento ativo.', { statusCode: 403, code: 'data_establishment_required' });
  }
  return lojaId;
}

// Promocao valendo agora: preco promocional maior que 0, ja comecou (ou sem inicio) e nao acabou
// (ou sem fim).
export function promocaoValendo(produto, agora) {
  if (!(numero(produto?.promotionalPrice) > 0)) return false;
  const inicio = emMs(produto.promotionStartAt);
  const fim = emMs(produto.promotionEndAt);
  if (inicio !== null && inicio > agora) return false;
  if (fim !== null && fim < agora) return false;
  return true;
}

// Por que a promocao nao aparece: o primeiro motivo gravado do produto, na ordem da nuvem.
function motivoDoProdutoFora(produto) {
  const codigos = Array.isArray(produto?.offReasons) ? produto.offReasons : [];
  const primeiro = Object.values(CODIGOS).find((codigo) => codigos.includes(codigo));
  return primeiro || null;
}

// Faixa do integrador: uma so, na ordem fechado, parado, sem exportar, arquivo com defeito.
export function faixaDoIntegrador({ status, ultimaLeitura, agora }) {
  if (!status) return null;
  const visto = emMs(status.lastSeenAt);
  if (visto !== null && agora - visto > FECHADO_DEPOIS_MS) return { tipo: 'fechado', desde: iso(visto) };
  const vivo = visto !== null;
  if (vivo) {
    const arquivos = numero(status.readyFilesOnDisk) ?? 0;
    const maisAntigo = emMs(status.oldestReadyFileAt);
    const terminou = emMs(status.lastReadFinishedAt);
    const naoLeuDepois = terminou === null || (maisAntigo !== null && terminou < maisAntigo);
    if (arquivos > 0 && maisAntigo !== null && agora - maisAntigo >= ARQUIVO_PARADO_MS && naoLeuDepois) {
      return { tipo: 'parado', desde: iso(maisAntigo) };
    }
    if (status.readStuck === true) {
      return { tipo: 'parado', desde: iso(status.readStuckSince ?? status.lastReadStartedAt) };
    }
    const leitura = emMs(ultimaLeitura);
    if (arquivos === 0 && (leitura === null || agora - leitura > SEM_EXPORTAR_MS)) {
      return { tipo: 'semExportar', desde: leitura === null ? null : iso(leitura) };
    }
  }
  if ((numero(status.quarantinedFiles) ?? 0) > 0) return { tipo: 'defeito', desde: null };
  return null;
}

export class ProdutosForaDoApp {
  constructor({ repositorio, agora = () => Date.now() }) {
    this.repositorio = repositorio;
    this.agora = agora;
  }

  // Produtos de um motivo da nuvem: contagem e os primeiros, com "Estoque N · desde dd/mm".
  async porCodigo(lojaId, grupo, limite) {
    const filtros = [['offReasons', 'array-contains', grupo.codigo], NA_LOJA];
    const quantidade = await this.repositorio.contarProdutos({ lojaId, filtros });
    if (grupo.soContagem && limite === POR_GRUPO) return { quantidade, produtos: [] };
    const lista = quantidade > 0 ? await this.repositorio.produtos({ lojaId, filtros, limite }) : [];
    return {
      quantidade,
      produtos: lista.map((produto) => produtoDoCartao(produto, {
        estoque: numero(produto.quantityInStock),
        desde: iso(produto.offReasonsSince?.[grupo.codigo]),
      })),
    };
  }

  async desligadosAMao(lojaId, limite) {
    const tipos = ['ateRepor', 'lixeira'];
    const contagens = await Promise.all(tipos.map((tipo) => this.repositorio.contarProdutos({
      lojaId, filtros: [['retiradoPelaEquipe.tipo', '==', tipo]],
    })));
    const quantidade = contagens.reduce((soma, n) => soma + n, 0);
    const listas = quantidade > 0
      ? await Promise.all(tipos.map((tipo) => this.repositorio.produtos({ lojaId, filtros: [['retiradoPelaEquipe.tipo', '==', tipo]], limite })))
      : [];
    const produtos = listas.flat()
      .sort((a, b) => (emMs(b.retiradoPelaEquipe?.em) ?? 0) - (emMs(a.retiradoPelaEquipe?.em) ?? 0))
      .slice(0, limite)
      .map((produto) => produtoDoCartao(produto, {
        tipo: produto.retiradoPelaEquipe?.tipo || null,
        por: texto(produto.retiradoPelaEquipe?.quem) || null,
        em: iso(produto.retiradoPelaEquipe?.em),
        estoque: numero(produto.quantityInStock),
      }));
    return { quantidade, produtos };
  }

  // Contagem guardada pela nuvem (3.1); o carrossel mostra cada repetido junto do que fica com as
  // atualizacoes ("Código atual"). Nada e apagado.
  async duplicados(lojaId, limite) {
    const resumo = await this.repositorio.documentoDaLoja({ lojaId, caminho: 'ResumoDeProdutos/duplicados' });
    const quantidade = numero(resumo?.quantidade) ?? 0;
    if (quantidade <= 0) return { quantidade: 0, produtos: [] };
    const repetidos = await this.repositorio.produtos({ lojaId, filtros: [['duplicateOf', '>', '']], limite: Math.ceil(limite / 2) });
    const ids = [...new Set(repetidos.map((produto) => texto(produto.duplicateOf)).filter(Boolean))];
    const mantidos = new Map((ids.length ? await this.repositorio.produtosPorId({ lojaId, ids }) : []).map((p) => [p.id, p]));
    const produtos = [];
    repetidos.forEach((repetido) => {
      const mantido = mantidos.get(texto(repetido.duplicateOf));
      if (mantido && !produtos.some((p) => p.id === mantido.id)) {
        produtos.push(produtoDoCartao(mantido, { duplicado: 'atual' }));
      }
      produtos.push(produtoDoCartao(repetido, { duplicado: 'parado', desde: iso(repetido.duplicateMarkedAt), de: texto(repetido.duplicateOf) || null }));
    });
    return { quantidade, produtos: produtos.slice(0, limite) };
  }

  // Promocoes valendo: as de produto fora do app (desligado) e as acima do preco cheio (produto no
  // app). Usa o indice composto que ja existe (isActive, isTrashed, promotionalPrice).
  async promocoes(lojaId, tipo, limite) {
    const ligado = tipo === 'acimaDoPreco';
    const lidos = await this.repositorio.produtos({
      lojaId,
      filtros: [['isActive', '==', ligado], NA_LOJA, ['promotionalPrice', '>', 0]],
      limite: LEITURA_DE_PROMOCOES,
    });
    const agora = this.agora();
    const valendo = lidos.filter((produto) => promocaoValendo(produto, agora));
    const doGrupo = ligado
      ? valendo.filter((produto) => numero(produto.currentPrice) !== null && produto.promotionalPrice >= produto.currentPrice)
      : valendo;
    return {
      quantidade: doGrupo.length,
      completo: lidos.length < LEITURA_DE_PROMOCOES,
      produtos: doGrupo.slice(0, limite).map((produto) => produtoDoCartao(produto, ligado
        ? { promocao: produto.promotionalPrice }
        : { promocao: produto.promotionalPrice, ate: iso(produto.promotionEndAt), de: iso(produto.promotionStartAt), por: motivoDoProdutoFora(produto) })),
    };
  }

  async grupo(lojaId, grupo, limite) {
    if (grupo.semFonte) return { quantidade: null, indisponivel: true, produtos: [] };
    if (grupo.codigo) return this.porCodigo(lojaId, grupo, limite);
    if (grupo.marca) return this.desligadosAMao(lojaId, limite);
    if (grupo.duplicados) return this.duplicados(lojaId, limite);
    return this.promocoes(lojaId, grupo.promocao, limite);
  }

  async resumo({ ator }) {
    const lojaId = lojaDoAtor(ator);
    const [erp, status, ultimaLeitura, aVendaNoApp, ...grupos] = await Promise.all([
      // Cola 71, item 3: so o nome do ERP; leitura que falha nao derruba o resumo.
      Promise.resolve().then(() => this.repositorio.configuracaoDoErp({ lojaId })).catch(() => null),
      this.repositorio.documentoDaLoja({ lojaId, caminho: 'IntegrationStatus/current' }),
      this.repositorio.ultimaLeitura({ lojaId }),
      this.repositorio.contarProdutos({ lojaId, filtros: [['isActive', '==', true], NA_LOJA] }),
      ...GRUPOS.map((grupo) => this.grupo(lojaId, grupo, POR_GRUPO)),
    ]);
    const porChave = Object.fromEntries(GRUPOS.map((grupo, i) => [grupo.chave, { chave: grupo.chave, secao: grupo.secao, ...grupos[i] }]));
    const soma = (secao) => GRUPOS.filter((g) => g.secao === secao)
      .reduce((total, g) => total + (numero(porChave[g.chave].quantidade) ?? 0), 0);
    return {
      faixa: faixaDoIntegrador({ status, ultimaLeitura, agora: this.agora() }),
      // Cola 71, item 3: nome do ERP da loja ("Linear", regra em nomeDoErp.js) para o motivo
      // fora_do_erp ("fora do Linear"); sem ERP conhecido, null e o web nao mostra esse motivo.
      nomeDoErp: erp ? nomeDoErpDaLoja(erp.loja, erp.status) : null,
      resumo: {
        precisamDeAcao: soma('acao'),
        desligadosPeloEstoque: soma('estoque'),
        promocoesQueNaoAparecem: porChave.promocaoNaoAparece.quantidade,
        aVendaNoApp,
      },
      grupos: GRUPOS.map((g) => porChave[g.chave]),
      // Arquivos separados para conferencia: so o numero (a revisao de 19/11 tira o nome do arquivo).
      arquivosSeparados: numero(status?.quarantinedFiles) ?? 0,
    };
  }

  // "Ver todos" de um grupo: ate LIMITE_DO_GRUPO produtos.
  async doGrupo({ ator, chave, limite = LIMITE_DO_GRUPO }) {
    const lojaId = lojaDoAtor(ator);
    const grupo = GRUPOS.find((g) => g.chave === chave);
    if (!grupo) throw new AppError('Grupo inválido.', { statusCode: 400, code: 'fora_do_app_grupo_invalido' });
    const maximo = Math.min(Math.max(Number.parseInt(limite, 10) || LIMITE_DO_GRUPO, 1), LIMITE_DO_GRUPO);
    return { chave, ...(await this.grupo(lojaId, { ...grupo, soContagem: false }, maximo)) };
  }
}
