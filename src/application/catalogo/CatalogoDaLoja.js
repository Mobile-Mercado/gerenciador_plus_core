import { FieldValue } from 'firebase-admin/firestore';
import { AppError } from '../../domain/errors/AppError.js';
import { categoriaProtegida } from '../../domain/catalogo/categoriasProtegidas.js';
import { chaveDoNome, formatarNome } from '../../domain/catalogo/formatarNome.js';
import { estadoDoItem, nomeDoItem, TIPOS } from './ManageCatalogoPadrao.js';

// Catalogo da loja a partir da lista padrao (decisao do Thay de 12/10/2026):
// - a loja so ativa categoria e subcategoria que existem ligadas na lista padrao, com o
//   mesmo id, nome e icone; nada de categoria avulsa;
// - "Ativar" recusa o que ja existe na loja, ligado ou desligado, conferindo pelo
//   caminho do documento (estabelecimentos/{loja}/ProductCategories/{id}) e pelo nome (sem
//   acento, sem maiuscula, sem espacos nas pontas), contra todas as categorias da loja,
//   ligadas e desligadas; subcategoria, dentro da categoria: nunca duplica;
// - categoria travada na loja (regra da trava) nao aparece e nao ativa;
// - o nome de exibicao e um campo proprio (nomeExibicao), formatado e unico na loja.

function lojaDoAtor(ator) {
  const lojaId = ator?.establishmentId;
  if (!lojaId || ator?.hasEstablishment === false) {
    throw new AppError('Conta sem estabelecimento ativo.', { statusCode: 403, code: 'data_establishment_required' });
  }
  return lojaId;
}

export class CatalogoDaLoja {
  constructor({ firestore, travas }) {
    this.firestore = firestore;
    this.travas = travas;
  }

  colecaoDaLoja(lojaId, tipo) {
    return this.firestore.collection('estabelecimentos').doc(lojaId).collection(TIPOS[tipo].loja);
  }

  async idsNaLoja(lojaId, tipo) {
    const snapshot = await this.colecaoDaLoja(lojaId, tipo).select().get();
    return new Set(snapshot.docs.map((documento) => documento.id));
  }

  // Nomes da loja (nome padrao e nome de exibicao), ligados e desligados, para a regra de
  // nunca duplicar: categoria pela chave do nome; subcategoria pela categoria + chave.
  async nomesNaLoja(lojaId) {
    const [categorias, subcategorias] = await Promise.all([
      this.colecaoDaLoja(lojaId, 'categoria').get(),
      this.colecaoDaLoja(lojaId, 'subcategoria').get(),
    ]);
    const chaves = (data, id) => [data.name, data.nomeExibicao].filter(Boolean).map(chaveDoNome).concat(data.name ? [] : [chaveDoNome(id)]);
    const categoriaPorChave = new Map();
    categorias.docs.forEach((documento) => {
      chaves(documento.data() || {}, documento.id).forEach((chave) => {
        if (!categoriaPorChave.has(chave)) categoriaPorChave.set(chave, { id: documento.id, nome: documento.data()?.name || documento.id });
      });
    });
    const subPorChave = new Map();
    subcategorias.docs.forEach((documento) => {
      const data = documento.data() || {};
      chaves(data, documento.id).forEach((chave) => {
        const chaveCompleta = `${data.categoryId || ''}|${chave}`;
        if (!subPorChave.has(chaveCompleta)) subPorChave.set(chaveCompleta, { id: documento.id, nome: data.name || documento.id });
      });
    });
    return { categoriaPorChave, subPorChave };
  }

  // Categoria de mesmo nome na loja com outro id (ativar traria uma repetida).
  static categoriaRepetida(nomes, id, nome) {
    const outra = nomes.categoriaPorChave.get(chaveDoNome(nome));
    return outra && outra.id !== id ? outra : null;
  }

  async travadas(ator) {
    const lojaId = lojaDoAtor(ator);
    const ids = await this.travas.travadasNaLoja(lojaId);
    return { travadas: [...ids] };
  }

  // O que a loja pode ativar: ligado na lista padrao, nao arquivado, sem trava na loja e
  // que a loja ainda nao tem.
  async padraoDisponivel(ator) {
    const lojaId = lojaDoAtor(ator);
    const [categoriasPadrao, subcategoriasPadrao, catsNaLoja, subsNaLoja, travadas, nomes] = await Promise.all([
      this.firestore.collection(TIPOS.categoria.padrao).get(),
      this.firestore.collection(TIPOS.subcategoria.padrao).get(),
      this.idsNaLoja(lojaId, 'categoria'),
      this.idsNaLoja(lojaId, 'subcategoria'),
      this.travas.travadasNaLoja(lojaId),
      this.nomesNaLoja(lojaId),
    ]);
    const categoriasLigadas = new Map(categoriasPadrao.docs
      .filter((documento) => estadoDoItem(documento.data()) === 'ligada' && !travadas.has(documento.id))
      .map((documento) => [documento.id, documento.data() || {}]));
    // Categoria do padrao com o mesmo nome de uma da loja (outro id) nao aparece, nem as
    // subcategorias dela: ativar criaria a categoria repetida.
    const comNomeNaLoja = new Set([...categoriasLigadas]
      .filter(([id, data]) => CatalogoDaLoja.categoriaRepetida(nomes, id, nomeDoItem(data)))
      .map(([id]) => id));
    const categorias = [...categoriasLigadas]
      .filter(([id]) => !catsNaLoja.has(id) && !comNomeNaLoja.has(id))
      .map(([id, data]) => ({ id, nome: nomeDoItem(data), icon: data.icon || '' }))
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    const subcategorias = subcategoriasPadrao.docs
      .filter((documento) => !subsNaLoja.has(documento.id) && estadoDoItem(documento.data()) === 'ligada')
      .map((documento) => ({ id: documento.id, data: documento.data() || {} }))
      .filter(({ data }) => categoriasLigadas.has(data.categoriaProdutoId) && !comNomeNaLoja.has(data.categoriaProdutoId))
      .filter(({ data }) => !nomes.subPorChave.has(`${data.categoriaProdutoId}|${chaveDoNome(nomeDoItem(data))}`))
      .map(({ id, data }) => ({
        id,
        nome: nomeDoItem(data),
        categoriaId: data.categoriaProdutoId,
        categoriaNome: nomeDoItem(categoriasLigadas.get(data.categoriaProdutoId)),
        categoriaNaLoja: catsNaLoja.has(data.categoriaProdutoId),
      }))
      .sort((a, b) => a.categoriaNome.localeCompare(b.categoriaNome, 'pt-BR') || a.nome.localeCompare(b.nome, 'pt-BR'));
    return { categorias, subcategorias };
  }

  async itemDoPadrao(tipo, id) {
    const snapshot = await this.firestore.collection(TIPOS[tipo].padrao).doc(String(id || '')).get();
    if (!snapshot.exists || estadoDoItem(snapshot.data()) !== 'ligada') {
      throw new AppError('Este item não está disponível na lista padrão.', { statusCode: 404, code: 'catalogo_indisponivel' });
    }
    return snapshot;
  }

  async assertSemTrava(lojaId, categoriaId) {
    if (await this.travas.estaTravada(lojaId, categoriaId)) {
      throw new AppError('Venda restrita. Fale com o suporte do app.', { statusCode: 403, code: 'categoria_travada' });
    }
  }

  // Copia por id da lista padrao. Subcategoria cuja categoria a loja nao tem traz a
  // categoria junto, no mesmo lote. create() falha se o documento existir: o lote inteiro
  // e recusado e nada duplica.
  async ativar(ator, { tipo, id } = {}) {
    const lojaId = lojaDoAtor(ator);
    if (!TIPOS[tipo]) throw new AppError('Tipo deve ser categoria ou subcategoria.', { statusCode: 400, code: 'catalogo_tipo_invalido' });
    const item = await this.itemDoPadrao(tipo, id);
    const categoria = tipo === 'categoria' ? item : await this.itemDoPadrao('categoria', item.data()?.categoriaProdutoId);
    await this.assertSemTrava(lojaId, categoria.id);

    const referenciaItem = this.colecaoDaLoja(lojaId, tipo).doc(item.id);
    const referenciaCategoria = this.colecaoDaLoja(lojaId, 'categoria').doc(categoria.id);
    const [naLoja, categoriaNaLoja] = await Promise.all([referenciaItem.get(), referenciaCategoria.get()]);
    if (naLoja.exists) {
      throw new AppError(naLoja.data()?.isActive === false
        ? 'A loja já tem este item, desligado. Ligue pelo Editar status.'
        : 'A loja já tem este item.', { statusCode: 409, code: 'catalogo_ja_na_loja' });
    }
    // Nunca duplicar pelo nome: categoria contra todas as da loja; subcategoria dentro da
    // categoria.
    const nomes = await this.nomesNaLoja(lojaId);
    if (tipo === 'categoria' || !categoriaNaLoja.exists) {
      const repetida = CatalogoDaLoja.categoriaRepetida(nomes, categoria.id, nomeDoItem(categoria.data()));
      if (repetida) {
        throw new AppError(`A loja já tem a categoria "${repetida.nome}".`, { statusCode: 409, code: 'catalogo_nome_ja_na_loja' });
      }
    }
    if (tipo === 'subcategoria') {
      const repetida = nomes.subPorChave.get(`${categoria.id}|${chaveDoNome(nomeDoItem(item.data()))}`);
      if (repetida) {
        throw new AppError(`A loja já tem a subcategoria "${repetida.nome}" nesta categoria.`, { statusCode: 409, code: 'catalogo_nome_ja_na_loja' });
      }
    }

    const agora = FieldValue.serverTimestamp();
    const quem = ator.uid || null;
    const dadosDaCategoria = categoria.data() || {};
    const lote = this.firestore.batch();
    const criadas = [];
    if (tipo === 'categoria' || !categoriaNaLoja.exists) {
      lote.create(referenciaCategoria, {
        id: categoria.id,
        name: nomeDoItem(dadosDaCategoria),
        icon: dadosDaCategoria.icon || '',
        order: Number.isFinite(Number(dadosDaCategoria.order)) ? Number(dadosDaCategoria.order) : 0,
        isActive: true,
        ativadaDoPadraoEm: agora,
        ativadaPor: quem,
      });
      criadas.push({ tipo: 'categoria', id: categoria.id });
    }
    if (tipo === 'subcategoria') {
      lote.create(referenciaItem, {
        id: item.id,
        name: nomeDoItem(item.data()),
        categoryId: categoria.id,
        isActive: true,
        ativadaDoPadraoEm: agora,
        ativadaPor: quem,
      });
      criadas.push({ tipo: 'subcategoria', id: item.id });
    }
    await lote.commit();
    return { criadas };
  }

  // Nome de exibicao: formatado pelo Core, unico na loja (subcategoria: na mesma
  // categoria). Nome vazio volta ao nome padrao.
  async nomeDeExibicao(ator, { tipo, id, nome } = {}) {
    const lojaId = lojaDoAtor(ator);
    if (!TIPOS[tipo]) throw new AppError('Tipo deve ser categoria ou subcategoria.', { statusCode: 400, code: 'catalogo_tipo_invalido' });
    const colecao = this.colecaoDaLoja(lojaId, tipo);
    const atual = await colecao.doc(String(id || '')).get();
    if (!atual.exists) throw new AppError('Item não encontrado na loja.', { statusCode: 404, code: 'catalogo_item_nao_encontrado' });
    const data = atual.data() || {};
    const nomePadrao = String(data.name || atual.id).trim();
    if (tipo === 'categoria' && categoriaProtegida({ id: atual.id, nome: nomePadrao })) {
      throw new AppError('Mercearia e Todos são achadas pelo nome no app: o nome não muda.', {
        statusCode: 409,
        code: 'catalogo_categoria_protegida',
      });
    }
    const formatado = formatarNome(nome);

    if (!formatado || formatado === nomePadrao) {
      await atual.ref.update({ nomeExibicao: FieldValue.delete() });
      return { id: atual.id, nomePadrao, nomeExibicao: null };
    }
    const chave = chaveDoNome(formatado);
    const todos = await colecao.get();
    const repetido = todos.docs.find((documento) => {
      if (documento.id === atual.id) return false;
      const outro = documento.data() || {};
      if (tipo === 'subcategoria' && outro.categoryId !== data.categoryId) return false;
      return chaveDoNome(outro.nomeExibicao || outro.name || documento.id) === chave;
    });
    if (repetido) {
      throw new AppError(`Já existe "${formatado}" na loja.`, { statusCode: 409, code: 'catalogo_nome_repetido' });
    }
    await atual.ref.update({ nomeExibicao: formatado });
    return { id: atual.id, nomePadrao, nomeExibicao: formatado };
  }
}
