import { randomUUID } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { AppError } from '../../domain/errors/AppError.js';
import { categoriaProtegida } from '../../domain/catalogo/categoriasProtegidas.js';
import { chaveDoNome, formatarNome } from '../../domain/catalogo/formatarNome.js';
import { travadaNaLoja } from '../../domain/catalogo/regraDaTrava.js';

// Lista padrao no Admin: categoriasProdutos e subcategoriasProdutos. Cada item tem tres
// estados (decisao do Thay de 12/10/2026):
// - ligada: aparece para as lojas ativarem;
// - desligada: fica na lista do Admin e nao aparece para as lojas ativarem;
// - arquivada: some de tudo; so a visao "Arquivadas" do Admin mostra, com Restaurar.
// Categoria retirada e arquivada, nao apagada (regra de 07/10). Excluir de vez so vale para
// item que nenhuma loja tem e sem produto (decisao do Thay de 12/10), conferido de novo aqui.

export const TIPOS = Object.freeze({
  categoria: { padrao: 'categoriasProdutos', loja: 'ProductCategories', campoProduto: 'categoriesIds' },
  subcategoria: { padrao: 'subcategoriasProdutos', loja: 'ProductSubcategories', campoProduto: 'subcategoriesIds' },
});
export const ESTADOS = Object.freeze(['ligada', 'desligada', 'arquivada', 'restaurada']);
const ICONE_TIPOS = Object.freeze({
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
});
const ICONE_MAX_BYTES = 300 * 1024;
const LOTE_ESCRITA = 400;
const LOTE_LEITURA = 300;

export function estadoDoItem(data = {}) {
  if (data.arquivada === true) return 'arquivada';
  return data.isActive === false ? 'desligada' : 'ligada';
}

export function nomeDoItem(data = {}) {
  return String(data.nome ?? data.name ?? '').trim();
}

export function quando(valor) {
  if (!valor) return null;
  if (typeof valor.toDate === 'function') return valor.toDate().toISOString();
  if (valor instanceof Date) return valor.toISOString();
  return typeof valor === 'string' ? valor : null;
}

function idPeloNome(nome) {
  return chaveDoNome(nome).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function tipoValido(tipo) {
  const config = TIPOS[tipo];
  if (!config) {
    throw new AppError('Tipo deve ser categoria ou subcategoria.', { statusCode: 400, code: 'catalogo_tipo_invalido' });
  }
  return config;
}

function protegida() {
  return new AppError('Mercearia e Todos são achadas pelo nome no app: não mudam de nome, não desligam, não arquivam e não travam.', {
    statusCode: 409,
    code: 'catalogo_categoria_protegida',
  });
}

function naoEncontrado(tipo) {
  return new AppError(`${tipo === 'categoria' ? 'Categoria' : 'Subcategoria'} não encontrada na lista padrão.`, {
    statusCode: 404,
    code: 'catalogo_item_nao_encontrado',
  });
}

function itemDaLista(tipo, documento) {
  const data = documento.data() || {};
  const item = {
    id: documento.id,
    nome: nomeDoItem(data),
    estado: estadoDoItem(data),
    order: Number.isFinite(Number(data.order)) ? Number(data.order) : null,
    nomeAnterior: data.nomeAnterior || null,
    arquivadaPor: data.arquivadaPor || null,
    arquivadaEm: quando(data.arquivadaEm),
    atualizadoEm: quando(data.updatedAt),
  };
  if (tipo === 'categoria') {
    item.icon = data.icon || '';
    item.travada = data.travada === true;
    item.protegida = categoriaProtegida({ id: documento.id, nome: item.nome });
  } else {
    item.categoriaId = data.categoriaProdutoId || '';
    item.categoriaNome = data.categoriaProdutoNome || '';
  }
  return item;
}

export class ManageCatalogoPadrao {
  constructor({ firestore, travas = null, bucket = null }) {
    this.firestore = firestore;
    this.travas = travas;
    this.bucket = bucket;
  }

  colecao(tipo) {
    return this.firestore.collection(tipoValido(tipo).padrao);
  }

  async documento(tipo, id) {
    const snapshot = await this.colecao(tipo).doc(String(id || '')).get();
    if (!snapshot.exists) throw naoEncontrado(tipo);
    return snapshot;
  }

  // `arquivadas`: true devolve so as arquivadas (visao "Arquivadas"); false, as outras.
  async listar(tipo, { arquivadas = false } = {}) {
    const snapshot = await this.colecao(tipo).get();
    return snapshot.docs
      .map((documento) => itemDaLista(tipo, documento))
      .filter((item) => (item.estado === 'arquivada') === arquivadas)
      .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)
        || a.nome.localeCompare(b.nome, 'pt-BR'));
  }

  // Nome repetido: compara sem acento com os itens do mesmo tipo (subcategoria, na mesma
  // categoria). Arquivada com o mesmo nome tambem bloqueia: o caminho e restaurar.
  async assertNomeLivre(tipo, nome, { categoriaId = null, ignorarId = null } = {}) {
    const chave = chaveDoNome(nome);
    const snapshot = await this.colecao(tipo).get();
    const igual = snapshot.docs.find((documento) => {
      if (documento.id === ignorarId) return false;
      const data = documento.data() || {};
      if (tipo === 'subcategoria' && data.categoriaProdutoId !== categoriaId) return false;
      return chaveDoNome(nomeDoItem(data)) === chave;
    });
    if (!igual) return;
    const arquivada = (igual.data() || {}).arquivada === true;
    throw new AppError(arquivada
      ? `Já existe "${nomeDoItem(igual.data())}" arquivada. Restaure em vez de criar outra.`
      : `Já existe "${nomeDoItem(igual.data())}" na lista padrão.`, {
      statusCode: 409,
      code: arquivada ? 'catalogo_nome_arquivado' : 'catalogo_nome_repetido',
      details: { id: igual.id },
    });
  }

  async criar(tipo, { nome, categoriaId = null } = {}, ator = {}) {
    tipoValido(tipo);
    const formatado = formatarNome(nome);
    if (!formatado) throw new AppError('Informe o nome.', { statusCode: 400, code: 'catalogo_nome_vazio' });

    let categoria = null;
    if (tipo === 'subcategoria') {
      categoria = await this.documento('categoria', categoriaId);
      if (categoria.data()?.arquivada === true) {
        throw new AppError('A categoria está arquivada. Restaure antes de criar subcategoria.', {
          statusCode: 409,
          code: 'catalogo_categoria_arquivada',
        });
      }
    }
    await this.assertNomeLivre(tipo, formatado, { categoriaId });

    const agora = FieldValue.serverTimestamp();
    const base = {
      nome: formatado,
      isActive: true,
      arquivada: false,
      createdAt: agora,
      updatedAt: agora,
      updatedBy: ator.uid || null,
    };
    let campos;
    if (tipo === 'categoria') {
      const existentes = await this.colecao('categoria').get();
      const maiorOrdem = existentes.docs.reduce((maior, documento) => {
        const ordem = Number(documento.data()?.order);
        return Number.isFinite(ordem) && ordem > maior ? ordem : maior;
      }, -1);
      campos = { ...base, name: formatado, icon: '', arquivo: '', order: maiorOrdem + 1, travada: false };
    } else {
      campos = { ...base, categoriaProdutoId: categoria.id, categoriaProdutoNome: nomeDoItem(categoria.data()) };
    }

    // create() falha se o documento existir: nunca sobrescreve item da lista padrao.
    const sugerido = idPeloNome(formatado);
    let referencia = sugerido ? this.colecao(tipo).doc(sugerido) : this.colecao(tipo).doc();
    try {
      await referencia.create({ ...campos, id: referencia.id });
    } catch (error) {
      if (!sugerido || !jaExiste(error)) throw error;
      referencia = this.colecao(tipo).doc();
      await referencia.create({ ...campos, id: referencia.id });
    }
    return itemDaLista(tipo, await referencia.get());
  }

  async editar(tipo, id, { nome, order, travada } = {}, ator = {}) {
    const atual = await this.documento(tipo, id);
    const data = atual.data() || {};
    if (data.arquivada === true) {
      throw new AppError('Item arquivado. Restaure antes de editar.', { statusCode: 409, code: 'catalogo_item_arquivado' });
    }
    if (tipo === 'categoria' && categoriaProtegida({ id: atual.id, nome: nomeDoItem(data) }) && (nome !== undefined || travada !== undefined)) {
      throw protegida();
    }
    const mudancas = { updatedAt: FieldValue.serverTimestamp(), updatedBy: ator.uid || null };
    let nomeNovo = null;

    if (nome !== undefined) {
      const formatado = formatarNome(nome);
      if (!formatado) throw new AppError('Informe o nome.', { statusCode: 400, code: 'catalogo_nome_vazio' });
      if (formatado !== nomeDoItem(data)) {
        await this.assertNomeLivre(tipo, formatado, { categoriaId: data.categoriaProdutoId || null, ignorarId: atual.id });
        nomeNovo = formatado;
        mudancas.nome = formatado;
        if (tipo === 'categoria' || data.name !== undefined) mudancas.name = formatado;
        // Guardado para o "Levar o nome novo para as lojas".
        mudancas.nomeAnterior = nomeDoItem(data);
      }
    }
    if (order !== undefined) {
      const ordem = Number(order);
      if (!Number.isInteger(ordem) || ordem < 0) {
        throw new AppError('Ordem inválida.', { statusCode: 400, code: 'catalogo_ordem_invalida' });
      }
      mudancas.order = ordem;
    }
    if (travada !== undefined) {
      if (tipo !== 'categoria') {
        throw new AppError('A trava vale só para categoria.', { statusCode: 400, code: 'catalogo_trava_so_categoria' });
      }
      mudancas.travada = travada === true;
    }

    const lote = this.firestore.batch();
    lote.update(atual.ref, mudancas);
    // Nome da categoria copiado nas subcategorias da lista padrao.
    if (tipo === 'categoria' && nomeNovo) {
      const filhas = await this.colecao('subcategoria').where('categoriaProdutoId', '==', atual.id).get();
      filhas.docs.forEach((filha) => lote.update(filha.ref, { categoriaProdutoNome: nomeNovo }));
    }
    await lote.commit();
    if (travada !== undefined) this.travas?.esquecerPadrao();
    return itemDaLista(tipo, await atual.ref.get());
  }

  async mudarEstado(tipo, id, estado, ator = {}) {
    if (!ESTADOS.includes(estado)) {
      throw new AppError('Estado inválido.', { statusCode: 400, code: 'catalogo_estado_invalido' });
    }
    const atual = await this.documento(tipo, id);
    if (tipo === 'categoria' && (estado === 'desligada' || estado === 'arquivada')
      && categoriaProtegida({ id: atual.id, nome: nomeDoItem(atual.data()) })) {
      throw protegida();
    }
    const arquivada = atual.data()?.arquivada === true;
    if ((estado === 'ligada' || estado === 'desligada') && arquivada) {
      throw new AppError('Item arquivado. Restaure antes de ligar ou desligar.', { statusCode: 409, code: 'catalogo_item_arquivado' });
    }
    const agora = FieldValue.serverTimestamp();
    const mudancas = { updatedAt: agora, updatedBy: ator.uid || null };
    if (estado === 'ligada') mudancas.isActive = true;
    if (estado === 'desligada') mudancas.isActive = false;
    if (estado === 'arquivada') Object.assign(mudancas, { arquivada: true, arquivadaPor: ator.uid || null, arquivadaEm: agora });
    if (estado === 'restaurada') {
      Object.assign(mudancas, { arquivada: false, arquivadaPor: FieldValue.delete(), arquivadaEm: FieldValue.delete() });
    }
    await atual.ref.update(mudancas);
    return itemDaLista(tipo, await atual.ref.get());
  }

  async lojas() {
    const snapshot = await this.firestore.collection('estabelecimentos').select('name', 'fantasyName', 'nomeEstabelecimento').get();
    return snapshot.docs.map((documento) => ({
      id: documento.id,
      nome: documento.data()?.fantasyName || documento.data()?.name || documento.data()?.nomeEstabelecimento || documento.id,
    }));
  }

  // Caminho do documento na loja (estabelecimentos/{loja}/ProductCategories/{id}), nao o
  // campo id: 14% das categorias de loja nao tem o campo.
  async itensNasLojas(tipo, id) {
    const config = tipoValido(tipo);
    const lojas = await this.lojas();
    const resultado = [];
    for (let inicio = 0; inicio < lojas.length; inicio += LOTE_LEITURA) {
      const parte = lojas.slice(inicio, inicio + LOTE_LEITURA);
      const referencias = parte.map((loja) => this.firestore.doc(`estabelecimentos/${loja.id}/${config.loja}/${id}`));
      // eslint-disable-next-line no-await-in-loop
      const documentos = referencias.length ? await this.firestore.getAll(...referencias) : [];
      documentos.forEach((documento, indice) => {
        if (documento.exists) resultado.push({ loja: parte[indice], documento });
      });
    }
    return resultado;
  }

  // Antes de arquivar: quantas lojas tem o item e quantos produtos estao nele.
  async impacto(tipo, id) {
    const config = tipoValido(tipo);
    await this.documento(tipo, id);
    const nasLojas = await this.itensNasLojas(tipo, id);
    const porLoja = await Promise.all(nasLojas.map(async ({ loja }) => {
      const contagem = await this.firestore
        .collection(`estabelecimentos/${loja.id}/Products`)
        .where(config.campoProduto, 'array-contains', id)
        .count()
        .get();
      return { lojaId: loja.id, nome: loja.nome, produtos: Number(contagem.data()?.count) || 0 };
    }));
    return {
      lojas: porLoja.length,
      produtos: porLoja.reduce((total, loja) => total + loja.produtos, 0),
      porLoja,
    };
  }

  // Leva o nome atual da lista padrao so para as lojas cujo nome ainda e o nome padrao
  // antigo (nomeAnterior). Loja que mudou o nome fica como esta.
  async levarNome(tipo, id) {
    const atual = await this.documento(tipo, id);
    const data = atual.data() || {};
    const nomeNovo = nomeDoItem(data);
    const nomeAntigo = String(data.nomeAnterior || '').trim();
    if (!nomeAntigo) {
      throw new AppError('Este item não tem nome anterior para trocar nas lojas.', {
        statusCode: 409,
        code: 'catalogo_sem_nome_anterior',
      });
    }
    const nasLojas = await this.itensNasLojas(tipo, id);
    const trocar = nasLojas.filter(({ documento }) => String(documento.data()?.name ?? '').trim() === nomeAntigo);
    for (let inicio = 0; inicio < trocar.length; inicio += LOTE_ESCRITA) {
      const lote = this.firestore.batch();
      trocar.slice(inicio, inicio + LOTE_ESCRITA).forEach(({ documento }) => lote.update(documento.ref, { name: nomeNovo }));
      // eslint-disable-next-line no-await-in-loop
      await lote.commit();
    }
    return {
      nomeAntigo,
      nomeNovo,
      lojasComItem: nasLojas.length,
      atualizadas: trocar.map(({ loja }) => loja.id),
      mantidas: nasLojas.length - trocar.length,
    };
  }

  async trocarIcone(id, { conteudoBase64, tipoArquivo } = {}, ator = {}) {
    const atual = await this.documento('categoria', id);
    const extensao = ICONE_TIPOS[tipoArquivo];
    if (!extensao) {
      throw new AppError('Use SVG, PNG, WEBP ou JPG.', { statusCode: 400, code: 'catalogo_icone_tipo' });
    }
    const conteudo = Buffer.from(String(conteudoBase64 || ''), 'base64');
    if (!conteudo.length || conteudo.length > ICONE_MAX_BYTES) {
      throw new AppError('O ícone precisa ter até 300 KB.', { statusCode: 400, code: 'catalogo_icone_tamanho' });
    }
    if (!this.bucket) {
      throw new AppError('Armazenamento de ícones não configurado.', { statusCode: 503, code: 'catalogo_icone_sem_bucket' });
    }
    // Mesmo lugar e formato dos icones de hoje: categoriasProdutos/{id}_{ms}.{ext}.
    const arquivo = `${atual.id}_${Date.now()}.${extensao}`;
    const caminho = `categoriasProdutos/${arquivo}`;
    const token = randomUUID();
    await this.bucket.file(caminho).save(conteudo, {
      contentType: tipoArquivo,
      metadata: { metadata: { firebaseStorageDownloadTokens: token } },
    });
    const icon = `https://firebasestorage.googleapis.com/v0/b/${this.bucket.name}/o/${encodeURIComponent(caminho)}?alt=media&token=${token}`;
    await atual.ref.update({ icon, arquivo, updatedAt: FieldValue.serverTimestamp(), updatedBy: ator.uid || null });
    return itemDaLista('categoria', await atual.ref.get());
  }

  // Excluir de vez: so com 0 lojas com o item e 0 produtos nele (a mesma contagem do
  // Arquivar), conferido de novo antes de apagar. Categoria com subcategoria na lista padrao
  // tambem e recusada: a subcategoria ficaria sem categoria pai. O documento como estava vai
  // para adminAuditLogs.
  async excluir(tipo, id, ator = {}) {
    const atual = await this.documento(tipo, id);
    const impacto = await this.impacto(tipo, id);
    if (impacto.lojas > 0 || impacto.produtos > 0) {
      throw new AppError(`Não dá para excluir: ${impacto.lojas} loja(s) têm o item e ${impacto.produtos} produto(s) estão nele. Use Arquivar.`, {
        statusCode: 409,
        code: 'catalogo_exclusao_recusada',
        details: { lojas: impacto.lojas, produtos: impacto.produtos },
      });
    }
    if (tipo === 'categoria') {
      const filhas = await this.colecao('subcategoria').where('categoriaProdutoId', '==', atual.id).get();
      if (!filhas.empty) {
        throw new AppError(`Não dá para excluir: a categoria tem ${filhas.size} subcategoria(s) na lista padrão. Exclua ou arquive as subcategorias antes.`, {
          statusCode: 409,
          code: 'catalogo_exclusao_com_subcategorias',
        });
      }
    }
    const lote = this.firestore.batch();
    lote.set(this.firestore.collection('adminAuditLogs').doc(), {
      acao: 'excluir',
      tipo,
      id: atual.id,
      caminho: atual.ref.path,
      documento: atual.data() || {},
      uid: ator.uid || null,
      email: ator.email || null,
      em: FieldValue.serverTimestamp(),
    });
    lote.delete(atual.ref);
    await lote.commit();
    return { id: atual.id, excluido: true };
  }

  // ===== Estabelecimentos (rodada 1: so leitura, mais a liberacao) =====

  // Lojas com nome, cidade, ativa ou nao e quantidade de produtos (contagem do Firestore,
  // uma por loja).
  //
  // Pedidos do cadastro novo (status diferente de aprovada) ficam em Pedidos de loja, nao aqui.
  // Loja sem name mostra nomeEstabelecimento quando existir.
  async estabelecimentos() {
    const snapshot = await this.firestore.collection('estabelecimentos').select('name', 'fantasyName', 'nomeEstabelecimento', 'address', 'isActive', 'createdAt', 'status').get();
    const lojas = snapshot.docs.filter((documento) => !documento.data()?.status || documento.data()?.status === 'aprovada');
    return Promise.all(lojas.map(async (documento) => {
      const data = documento.data() || {};
      const contagem = await this.firestore.collection('estabelecimentos').doc(documento.id).collection('Products').count().get();
      return {
        id: documento.id,
        nome: data.fantasyName || data.name || data.nomeEstabelecimento || documento.id,
        semNome: !String(data.fantasyName || data.name || data.nomeEstabelecimento || '').trim(),
        criadaEm: quando(data.createdAt),
        cidade: data.address?.city || null,
        uf: data.address?.uf || data.address?.state || null,
        ativa: data.isActive !== false,
        produtos: Number(contagem.data()?.count) || 0,
      };
    }));
  }

  // Categorias da loja: ligadas, desligadas e travadas (regra da trava, com a liberacao).
  async estabelecimento(lojaId) {
    const loja = await this.firestore.collection('estabelecimentos').doc(String(lojaId || '')).get();
    if (!loja.exists) throw new AppError('Loja não encontrada.', { statusCode: 404, code: 'catalogo_loja_nao_encontrada' });
    const [categorias, subcategorias, travadasPadrao, liberacao] = await Promise.all([
      loja.ref.collection('ProductCategories').get(),
      loja.ref.collection('ProductSubcategories').get(),
      this.firestore.collection('categoriasProdutos').where('travada', '==', true).get(),
      this.firestore.collection('liberacoesCategorias').doc(loja.id).get(),
    ]);
    const travadas = new Set(travadasPadrao.docs.map((documento) => documento.id));
    const liberadas = new Set(Object.keys(liberacao.data()?.liberadas || {}));
    const subsPorCategoria = new Map();
    subcategorias.docs.forEach((documento) => {
      const categoriaId = documento.data()?.categoryId;
      subsPorCategoria.set(categoriaId, (subsPorCategoria.get(categoriaId) || 0) + 1);
    });
    const data = loja.data() || {};
    return {
      id: loja.id,
      nome: data.fantasyName || data.name || loja.id,
      cidade: data.address?.city || null,
      ativa: data.isActive !== false,
      categorias: categorias.docs.map((documento) => {
        const categoria = documento.data() || {};
        return {
          id: documento.id,
          nome: categoria.name || documento.id,
          nomeExibicao: categoria.nomeExibicao || null,
          ligada: categoria.isActive !== false,
          travadaNoPadrao: travadas.has(documento.id),
          liberada: liberadas.has(documento.id),
          travada: travadaNaLoja(documento.id, { travadas, liberadas }),
          subcategorias: subsPorCategoria.get(documento.id) || 0,
        };
      }).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')),
    };
  }

  // ===== Liberacao por loja: liberacoesCategorias/{lojaId}.liberadas.{categoriaId} =====

  async liberacoes(categoriaId) {
    await this.documento('categoria', categoriaId);
    const [snapshot, lojas] = await Promise.all([this.firestore.collection('liberacoesCategorias').get(), this.lojas()]);
    const nomes = new Map(lojas.map((loja) => [loja.id, loja.nome]));
    return snapshot.docs
      .filter((documento) => documento.data()?.liberadas?.[categoriaId])
      .map((documento) => {
        const liberacao = documento.data().liberadas[categoriaId];
        return { lojaId: documento.id, nome: nomes.get(documento.id) || documento.id, por: liberacao?.por || null, em: quando(liberacao?.em) };
      });
  }

  async liberar({ lojaId, categoriaId } = {}, ator = {}) {
    await this.documento('categoria', categoriaId);
    const loja = await this.firestore.collection('estabelecimentos').doc(String(lojaId || '')).get();
    if (!loja.exists) throw new AppError('Loja não encontrada.', { statusCode: 404, code: 'catalogo_loja_nao_encontrada' });
    await this.firestore.collection('liberacoesCategorias').doc(loja.id).set({
      liberadas: { [categoriaId]: { por: ator.uid || null, em: FieldValue.serverTimestamp() } },
    }, { merge: true });
    this.travas?.esquecerLoja(loja.id);
    return { lojaId: loja.id, categoriaId };
  }

  async revogar({ lojaId, categoriaId } = {}) {
    const referencia = this.firestore.collection('liberacoesCategorias').doc(String(lojaId || ''));
    const atual = await referencia.get();
    if (atual.exists && atual.data()?.liberadas?.[categoriaId]) {
      await referencia.update({ [`liberadas.${categoriaId}`]: FieldValue.delete() });
    }
    this.travas?.esquecerLoja(String(lojaId || ''));
    return { lojaId, categoriaId };
  }

  // ===== Fila de sugestoes: estabelecimentos/{loja}/SugestoesCategorias =====

  async sugestoes({ estado = 'pendente' } = {}) {
    const [snapshot, lojas] = await Promise.all([this.firestore.collectionGroup('SugestoesCategorias').get(), this.lojas()]);
    const nomes = new Map(lojas.map((loja) => [loja.id, loja.nome]));
    return snapshot.docs
      .map((documento) => {
        const data = documento.data() || {};
        const lojaId = documento.ref.parent.parent?.id || '';
        const produtos = Array.isArray(data.produtos)
          ? data.produtos
          : (Array.isArray(data.produtosIds) ? data.produtosIds.map((produtoId) => ({ id: produtoId, nome: '' })) : []);
        return {
          id: documento.id,
          lojaId,
          nomeLoja: nomes.get(lojaId) || lojaId,
          nome: data.nome || '',
          tipo: data.tipo || 'categoria',
          categoriaId: data.categoriaId || null,
          categoriaNome: data.categoriaNome || null,
          observacao: data.observacao || '',
          produtos: produtos.slice(0, 20),
          quem: data.quem || null,
          em: quando(data.em),
          estado: data.estado || 'pendente',
          decisao: data.decisao ? { ...data.decisao, em: quando(data.decisao.em) } : null,
        };
      })
      .filter((sugestao) => !estado || sugestao.estado === estado)
      .sort((a, b) => String(b.em || '').localeCompare(String(a.em || '')));
  }

  async decidirSugestao(lojaId, id, { decisao, motivo = '' } = {}, ator = {}) {
    if (decisao !== 'aprovada' && decisao !== 'recusada') {
      throw new AppError('Decisão deve ser aprovada ou recusada.', { statusCode: 400, code: 'catalogo_decisao_invalida' });
    }
    const referencia = this.firestore.doc(`estabelecimentos/${lojaId}/SugestoesCategorias/${id}`);
    const atual = await referencia.get();
    if (!atual.exists) throw new AppError('Sugestão não encontrada.', { statusCode: 404, code: 'catalogo_sugestao_nao_encontrada' });
    if ((atual.data()?.estado || 'pendente') !== 'pendente') {
      throw new AppError('Esta sugestão já foi decidida.', { statusCode: 409, code: 'catalogo_sugestao_decidida' });
    }
    // Aprovar nao cria categoria: o Admin cria na lista padrao.
    await referencia.update({
      estado: decisao,
      decisao: { por: ator.uid || null, em: FieldValue.serverTimestamp(), motivo: String(motivo || '').slice(0, 500) },
    });
    return { lojaId, id, estado: decisao };
  }
}

function jaExiste(error) {
  return error?.code === 6 || error?.code === 'already-exists' || /already exists/i.test(String(error?.message || ''));
}
