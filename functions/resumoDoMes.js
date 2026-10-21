// Grupo do Resumo do mes no pedido (contrato da versao 55, item 7; cola RP-13 A.3).
//
// Grava no proprio pedido, fora de productsCart (o app Gerenciador antigo regrava a lista de
// itens com as chaves de hoje e apagaria chave nova no item):
//   gruposDosItens  { [id do item em productsCart]: grupo }
//   resumoPorGrupo  { [grupo]: valor em reais }, com os 8 grupos (os sem gasto em 0)
//   gruposVersao    versao da tabela abaixo, para reclassificar se ela mudar
// O app do cliente soma resumoPorGrupo dos proprios pedidos concluidos do mes.
//
// TABELA APROVADA em 21/10/2026 (Documentos/rodada-paralela/resumo-do-mes-grupos-proposta-21-10.md),
// SO AQUI. Cada categoria vai inteira para um grupo; nas marcadas "por prateleira" a prateleira
// decide. Categoria ou prateleira fora da tabela vai para pet_e_outros. Os nomes sao os da lista
// padrao (categoriasProdutos e subcategoriasProdutos, achados pelo id); para item fora da lista, o
// nome da loja. Comparacao sem acento e sem maiuscula.
//
// Valor do item: a mesma conta do totalSeparated do app (mobile_core product_cart_entity.dart:
// 121-128): removido vale 0; pesado vale a soma das medidas vezes o preco; o resto, preco vezes
// quantidade vezes quantityChosen.maxQuantity, com a margem de erro do produto.
//
// Arquivo puro nas contas (classificar, valor, montar); carregar le o Firestore com o db de quem
// chamou.
const GRUPOS_VERSAO = 1;
const GRUPOS = Object.freeze([
  'hortifruti',
  'carnes_e_frios',
  'padaria_e_quitandas',
  'higiene_e_limpeza',
  'mercearia',
  'balas_doces_e_chocolates',
  'bebidas',
  'pet_e_outros',
]);
const OUTROS = 'pet_e_outros';

function norm(valor) {
  return String(valor || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const porNome = (lista, grupo) => lista.map((nome) => [norm(nome), grupo]);

// Categoria inteira -> grupo.
const CATEGORIAS = new Map([
  ...porNome(['FLV', 'Hortifruti', 'Naturais'], 'hortifruti'),
  ...porNome(['Abatedouro', 'Açougue', 'Carnes', 'Peixes', 'Frios', 'Frios e Lácteos', 'Laticínios', 'Churrasco'], 'carnes_e_frios'),
  ...porNome(['Padaria', 'Pães & Bolos', 'Lanchonete'], 'padaria_e_quitandas'),
  ...porNome(['Higiene', 'Higiene Pessoal', 'Perfumaria', 'Limpeza', 'Fármacos', 'Remédios'], 'higiene_e_limpeza'),
  ...porNome(['Cereais', 'Grãos', 'Farináceos', 'Massas', 'Conservas', 'Temperos', 'Matinais', 'Leite', 'Biscoito', 'Biscoitos', 'Salgadinhos'], 'mercearia'),
  ...porNome(['Guloseimas', 'Sobremesas', 'Sorvetes', 'Páscoa'], 'balas_doces_e_chocolates'),
  ...porNome(['Bebidas', 'Refrescos', 'Vinhos'], 'bebidas'),
  ...porNome(['Animais', 'PET', 'Bazar', 'Utilidades', 'Brinquedos', 'Escolar', 'Natal', 'Tabacaria', 'Frente de Caixa', 'Outros',
    'Dúvidas', 'Promos', 'Todos', 'Sem Fotos', 'Uso da Loja', 'Ativo Imobilizado'], OUTROS),
]);

// Por prateleira: categoria -> { prateleira -> grupo, demais }. "demais" ausente = a categoria
// inteira (tabela acima) ou, sem ela, pet_e_outros.
const PRATELEIRAS = new Map([
  [norm('Congelados'), {
    prateleiras: new Map([
      ...porNome(['Pão de Queijo'], 'padaria_e_quitandas'),
      ...porNome(['Lasanha', 'Pizza'], 'mercearia'),
      ...porNome(['Empanados', 'Salgadinhos', 'Mais Congelados'], 'carnes_e_frios'),
      ...porNome(['Polpa de Frutas'], 'hortifruti'),
      ...porNome(['Sorvete/Açaí'], 'balas_doces_e_chocolates'),
    ]),
  }],
  [norm('ILHAS E CONGELADOS'), {
    prateleiras: new Map([...porNome(['Açaí e Polpas'], 'hortifruti'), ...porNome(['Pratos Prontos'], 'mercearia')]),
    demais: 'carnes_e_frios',
  }],
  [norm('Mercearia'), {
    prateleiras: new Map([
      ...porNome(['Bombons', 'Chocolate', 'Chocolate Barra', 'Doces Sobremesas', 'Ovo de Páscoa', 'Wafer'], 'balas_doces_e_chocolates'),
      ...porNome(['Pães', 'Bolos', 'Torradas'], 'padaria_e_quitandas'),
      ...porNome(['Água Mineral', 'Refrescos'], 'bebidas'),
      ...porNome(['Papel Toalha'], 'higiene_e_limpeza'),
      ...porNome(['Hortifruti', 'Naturais'], 'hortifruti'),
      ...porNome(['Laticínios'], 'carnes_e_frios'),
    ]),
    demais: 'mercearia',
  }],
  [norm('Matinal'), {
    prateleiras: new Map(porNome(['Bomboniere', 'Doces'], 'balas_doces_e_chocolates')),
    demais: 'mercearia',
  }],
  [norm('Padaria'), { prateleiras: new Map([...porNome(['Chocolate'], 'balas_doces_e_chocolates'), ...porNome(['Café'], 'mercearia')]) }],
  [norm('Hortifruti'), { prateleiras: new Map(porNome(['Mercearia'], 'mercearia')) }],
  [norm('Laticínios'), { prateleiras: new Map(porNome(['Achocolatados', 'Leite', 'Manteiga/Margarina'], 'mercearia')) }],
  [norm('Frios e Lácteos'), { prateleiras: new Map(porNome(['Leite Pasteurizado', 'Manteigas', 'Margarinas'], 'mercearia')) }],
]);

// Grupo de uma categoria (nome) com as prateleiras do produto nela (nomes).
function grupoDaCategoria(categoria, prateleiras = []) {
  const chave = norm(categoria);
  const regra = PRATELEIRAS.get(chave);
  if (regra) {
    for (const prateleira of prateleiras) {
      const grupo = regra.prateleiras.get(norm(prateleira));
      if (grupo) return grupo;
    }
    if (regra.demais) return regra.demais;
  }
  return CATEGORIAS.get(chave) || OUTROS;
}

// Produto com varias categorias (a "Todos" junto da de verdade, por exemplo): vale a primeira que
// cai num grupo que nao e pet_e_outros; sem nenhuma, pet_e_outros.
function grupoDoProduto(categorias) {
  for (const { nome, prateleiras } of categorias) {
    const grupo = grupoDaCategoria(nome, prateleiras);
    if (grupo !== OUTROS) return grupo;
  }
  return OUTROS;
}

function numero(valor) {
  const n = typeof valor === 'number' ? valor : Number(valor);
  return Number.isFinite(n) ? n : 0;
}

// Copia do totalSeparated (mobile_core product_cart_entity.dart:121-128).
function valorDoItem(item = {}) {
  const separado = item.separated || {};
  if (separado.hasRemoved === true) return 0;
  const preco = numero(item.product?.price);
  const medidas = Array.isArray(separado.measures) ? separado.measures : [];
  if (medidas.length) return medidas.reduce((soma, medida) => soma + numero(medida), 0) * preco;
  const maximo = numero(item.quantityChosen?.maxQuantity) || 1;
  const base = preco * numero(item.quantity) * maximo;
  return base + base * (numero(item.product?.quantityInterval?.marginOfError) / 100);
}

function refId(valor) {
  if (!valor) return '';
  if (typeof valor === 'string') return valor.split('/').filter(Boolean).at(-1) || '';
  return valor.id || valor.path?.split('/').filter(Boolean).at(-1) || '';
}

function idDoProduto(item = {}) {
  return refId(item.productRef || item.productReference) || refId(item.product?.id) || '';
}

function idDoItem(item = {}, indice = 0) {
  return String(item.id || idDoProduto(item) || `item-${indice}`);
}

function lista(valor) {
  if (Array.isArray(valor)) return valor.map(refId).filter(Boolean);
  const id = refId(valor);
  return id ? [id] : [];
}

// Categorias e prateleiras gravadas no produto da loja. Os apps gravaram categroyIds (com o erro de
// digitacao) e categoriesIds; o category antigo e um id so.
function idsDoProduto(produto = {}) {
  const categorias = [...new Set([...lista(produto.categoriesIds), ...lista(produto.categroyIds), ...lista(produto.category),
    ...(Array.isArray(produto.shelves) ? produto.shelves.map((shelf) => shelf?.productCategoryId || shelf?.categoryId) : []).filter(Boolean)])];
  const prateleiras = [...new Set([...lista(produto.subcategoriesIds), ...lista(produto.subcategory),
    ...(Array.isArray(produto.shelves) ? produto.shelves.map((shelf) => shelf?.productSubcategoryId || shelf?.subcategoryId) : []).filter(Boolean)])];
  return { categorias, prateleiras };
}

// meta: { produtos: Map(id -> produto), categorias: Map(id -> nome), prateleiras: Map(id -> { nome, categoriaId }) }
function classificarPedido(pedido = {}, meta = {}) {
  const itens = Array.isArray(pedido.productsCart) ? pedido.productsCart : [];
  const gruposDosItens = {};
  const resumoPorGrupo = Object.fromEntries(GRUPOS.map((grupo) => [grupo, 0]));
  itens.forEach((item, indice) => {
    const produto = meta.produtos?.get(idDoProduto(item)) || {};
    const { categorias, prateleiras } = idsDoProduto(produto);
    // Cada categoria ve todas as prateleiras do produto: o id da categoria-mae da prateleira nem
    // sempre bate com o da categoria da loja, e a tabela so olha prateleiras pelo nome dentro da
    // regra da propria categoria.
    const nomesDasPrateleiras = prateleiras.map((id) => meta.prateleiras?.get(id)?.nome).filter(Boolean);
    const comNomes = categorias.map((categoriaId) => ({ nome: meta.categorias?.get(categoriaId) || '', prateleiras: nomesDasPrateleiras }));
    const grupo = grupoDoProduto(comNomes);
    gruposDosItens[idDoItem(item, indice)] = grupo;
    resumoPorGrupo[grupo] += valorDoItem(item);
  });
  Object.keys(resumoPorGrupo).forEach((grupo) => { resumoPorGrupo[grupo] = Math.round(resumoPorGrupo[grupo] * 100) / 100; });
  return { gruposDosItens, resumoPorGrupo, gruposVersao: GRUPOS_VERSAO };
}

// Classificar de novo quando o pedido nasce, quando productsCart muda ou quando a tabela muda.
function precisaClassificar(antes, depois) {
  if (!depois) return false;
  if (depois.gruposVersao !== GRUPOS_VERSAO || !depois.resumoPorGrupo) return true;
  if (!antes) return true;
  return JSON.stringify(antes.productsCart || []) !== JSON.stringify(depois.productsCart || []);
}

function lojaDoPedido(pedido = {}) {
  return refId(pedido.companyReference) || String(pedido.companyId || '');
}

// Le o que a classificacao precisa: os produtos da loja, os nomes da lista padrao pelo id e, para
// o que nao esta nela, os da loja.
async function carregarMeta({ db, pedido }) {
  const lojaId = lojaDoPedido(pedido);
  const produtos = new Map();
  const categorias = new Map();
  const prateleiras = new Map();
  if (!lojaId) return { produtos, categorias, prateleiras };
  const loja = db.collection('estabelecimentos').doc(lojaId);
  const ids = [...new Set((pedido.productsCart || []).map(idDoProduto).filter(Boolean))];
  if (ids.length) {
    (await db.getAll(...ids.map((id) => loja.collection('Products').doc(id))))
      .forEach((snapshot) => produtos.set(snapshot.id, snapshot.exists ? snapshot.data() || {} : {}));
  }
  const idsCategorias = [...new Set([...produtos.values()].flatMap((produto) => idsDoProduto(produto).categorias))];
  const idsPrateleiras = [...new Set([...produtos.values()].flatMap((produto) => idsDoProduto(produto).prateleiras))];
  if (idsCategorias.length) {
    const padrao = await db.getAll(...idsCategorias.map((id) => db.collection('categoriasProdutos').doc(id)));
    const faltam = [];
    padrao.forEach((snapshot) => {
      if (snapshot.exists) categorias.set(snapshot.id, snapshot.get('nome') || snapshot.get('name') || '');
      else faltam.push(snapshot.id);
    });
    if (faltam.length) {
      (await db.getAll(...faltam.map((id) => loja.collection('ProductCategories').doc(id))))
        .forEach((snapshot) => categorias.set(snapshot.id, snapshot.exists ? snapshot.get('name') || '' : ''));
    }
  }
  if (idsPrateleiras.length) {
    const padrao = await db.getAll(...idsPrateleiras.map((id) => db.collection('subcategoriasProdutos').doc(id)));
    const faltam = [];
    padrao.forEach((snapshot) => {
      if (snapshot.exists) prateleiras.set(snapshot.id, { nome: snapshot.get('nome') || snapshot.get('name') || '', categoriaId: snapshot.get('categoriaProdutoId') || null });
      else faltam.push(snapshot.id);
    });
    if (faltam.length) {
      (await db.getAll(...faltam.map((id) => loja.collection('ProductSubcategories').doc(id))))
        .forEach((snapshot) => {
          if (snapshot.exists) prateleiras.set(snapshot.id, { nome: snapshot.get('name') || '', categoriaId: snapshot.get('categoryId') || null });
        });
    }
  }
  return { produtos, categorias, prateleiras };
}

// Gatilho: grava so os tres campos, com update (nunca toca productsCart). A propria gravacao nao
// dispara de novo, porque productsCart e a versao ficam iguais.
async function atualizarGruposDoPedido({ db, ref, antes, depois }) {
  if (!precisaClassificar(antes, depois)) return null;
  const classificacao = classificarPedido(depois, await carregarMeta({ db, pedido: depois }));
  await ref.update(classificacao);
  return classificacao;
}

module.exports = {
  GRUPOS,
  GRUPOS_VERSAO,
  atualizarGruposDoPedido,
  carregarMeta,
  classificarPedido,
  grupoDaCategoria,
  grupoDoProduto,
  precisaClassificar,
  valorDoItem,
};
