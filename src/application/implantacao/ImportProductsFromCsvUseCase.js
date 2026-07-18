import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { buildSearchIndex, buildWordKeys } from './catalogSearchIndex.js';

const BATCH_OP_LIMIT = 400;
const PROGRESS_LOG_EVERY = 25;
const EXISTING_PRODUCTS_PAGE_SIZE = 500;

function normalizeKey(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function pick(row, keys) {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return '';
}

function parsePriceValue(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[^\d,.-]/g, '');
  if (!cleaned) return null;
  const normalized = cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')
    ? cleaned.replace(/\./g, '').replace(',', '.')
    : cleaned.replace(/,/g, '');
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCsvLine(line, delimiter) {
  const values = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}

function splitCsvRows(csvText) {
  const rows = [];
  let current = '';
  let quoted = false;
  const text = String(csvText || '').replace(/^\uFEFF/, '');

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') {
      current += '""';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
      current += char;
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') index += 1;
      if (current.trim()) rows.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  if (current.trim()) rows.push(current);
  return rows;
}

function detectDelimiter(headerLine) {
  const commas = (headerLine.match(/,/g) || []).length;
  const semicolons = (headerLine.match(/;/g) || []).length;
  return semicolons > commas ? ';' : ',';
}

function parseCsv(csvText) {
  const lines = splitCsvRows(csvText);
  if (!lines.length) return [];
  const delimiter = detectDelimiter(lines[0]);
  const headers = parseCsvLine(lines[0], delimiter).map((item) => item.trim());
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line, delimiter);
    return headers.reduce((row, header, index) => {
      row[header] = values[index] || '';
      return row;
    }, {});
  });
}

async function loadExistingProductBarcodes(productsRef) {
  const map = new Map();
  let cursor = null;
  for (;;) {
    const query = cursor
      ? productsRef.orderBy('__name__').startAfter(cursor).limit(EXISTING_PRODUCTS_PAGE_SIZE)
      : productsRef.orderBy('__name__').limit(EXISTING_PRODUCTS_PAGE_SIZE);
    // eslint-disable-next-line no-await-in-loop
    const snapshot = await query.get();
    if (snapshot.empty) break;
    snapshot.forEach((productDoc) => {
      const data = productDoc.data();
      if (data.barCode) map.set(String(data.barCode).trim(), productDoc.id);
    });
    cursor = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < EXISTING_PRODUCTS_PAGE_SIZE) break;
  }
  return map;
}

async function loadCategoriesAndSubcategories(categoriesRef, subcategoriesRef) {
  const categories = new Map();
  const subcategories = new Map();
  const [categoriesSnap, subcategoriesSnap] = await Promise.all([
    categoriesRef.get(),
    subcategoriesRef.get(),
  ]);

  categoriesSnap.forEach((docSnap) => {
    const data = docSnap.data();
    if (data.name) categories.set(normalizeKey(data.name), { id: docSnap.id, name: data.name });
  });
  subcategoriesSnap.forEach((docSnap) => {
    const data = docSnap.data();
    if (data.name && data.categoryId) {
      subcategories.set(`${data.categoryId}::${normalizeKey(data.name)}`, { id: docSnap.id, name: data.name });
    }
  });
  return { categories, subcategories };
}

async function resolveCategory(categories, categoryName, categoriesRef, order) {
  const key = normalizeKey(categoryName);
  if (categories.has(key)) return categories.get(key);
  const created = await categoriesRef.add({
    name: categoryName,
    isActive: true,
    icon: '',
    order,
  });
  const entry = { id: created.id, name: categoryName };
  categories.set(key, entry);
  return entry;
}

async function resolveSubcategory(subcategories, subcategoryName, categoryId, subcategoriesRef) {
  const key = `${categoryId}::${normalizeKey(subcategoryName)}`;
  if (subcategories.has(key)) return subcategories.get(key);
  const created = await subcategoriesRef.add({
    name: subcategoryName,
    categoryId,
    isActive: true,
  });
  const entry = { id: created.id, name: subcategoryName };
  subcategories.set(key, entry);
  return entry;
}

export class ImportProductsFromCsvUseCase {
  constructor({ firestore }) {
    this.firestore = firestore;
  }

  async execute({ establishmentId, csvText, onProgress = () => {} }) {
    const rows = parseCsv(csvText);
    if (!rows.length) {
      return { created: 0, updated: 0, skipped: 0, total: 0 };
    }

    onProgress({ step: '01', pct: 0, status: 'executando', message: 'Lendo catalogo atual da loja...' });

    const productsRef = this.firestore.collection('estabelecimentos').doc(establishmentId).collection('Products');
    const categoriesRef = this.firestore.collection('estabelecimentos').doc(establishmentId).collection('ProductCategories');
    const subcategoriesRef = this.firestore.collection('estabelecimentos').doc(establishmentId).collection('ProductSubcategories');
    const establishmentRef = this.firestore.collection('estabelecimentos').doc(establishmentId);

    const [existingBarcodes, { categories, subcategories }] = await Promise.all([
      loadExistingProductBarcodes(productsRef),
      loadCategoriesAndSubcategories(categoriesRef, subcategoriesRef),
    ]);

    let processed = 0;
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let batch = this.firestore.batch();
    let opsInBatch = 0;
    const pendingCommits = [];

    const flushBatch = () => {
      if (opsInBatch === 0) return;
      pendingCommits.push(batch.commit());
      batch = this.firestore.batch();
      opsInBatch = 0;
    };

    for (const row of rows) {
      processed += 1;

      const name = pick(row, ['Nome', 'nome']);
      const description = pick(row, ['Descrição', 'descrição', 'Descricao', 'descricao']);
      const priceRaw = pick(row, ['Preço', 'preço', 'Preco', 'preco']);
      const ean = pick(row, ['EAN', 'ean']);
      const categoryName = pick(row, ['Mercadológico nível 1', 'Mercadologico nivel 1', 'mercadológico nível 1', 'mercadologico nivel 1']);
      const subcategoryName = pick(row, ['Mercadológico nível 2', 'Mercadologico nivel 2', 'mercadológico nível 2', 'mercadologico nivel 2']);
      const photoUrl = pick(row, ['Foto do produto', 'foto do produto']);
      const price = parsePriceValue(priceRaw);

      if (!name || !ean || price === null) {
        skipped += 1;
        continue;
      }

      let categoryId = '';
      let resolvedCategoryName = '';
      if (categoryName) {
        // eslint-disable-next-line no-await-in-loop
        const category = await resolveCategory(categories, categoryName, categoriesRef, categories.size);
        categoryId = category.id;
        resolvedCategoryName = category.name;
      }

      let subcategoryId = '';
      let resolvedSubcategoryName = '';
      if (subcategoryName && categoryId) {
        // eslint-disable-next-line no-await-in-loop
        const subcategory = await resolveSubcategory(subcategories, subcategoryName, categoryId, subcategoriesRef);
        subcategoryId = subcategory.id;
        resolvedSubcategoryName = subcategory.name;
      }

      const shelves = categoryId
        ? [{
          id: `${categoryId}_${subcategoryId}`,
          productCategoryId: categoryId,
          productSubcategoryId: subcategoryId,
          categoryName: resolvedCategoryName,
          subcategoryName: resolvedSubcategoryName,
        }]
        : [];

      const existingProductId = existingBarcodes.get(ean);
      const isNewProduct = !existingProductId;
      const productId = existingProductId || productsRef.doc().id;
      const productRef = productsRef.doc(productId);
      const timestamp = FieldValue.serverTimestamp();
      const historyTimestamp = Timestamp.now();

      const sharedFields = {
        name,
        description,
        currentPrice: price,
        agranelValue: price,
        barCode: ean,
        hasBarCode: true,
        shelves,
        shelvesIds: shelves.map((shelf) => shelf.id),
        categoriesIds: shelves.map((shelf) => shelf.productCategoryId).filter(Boolean),
        subcategoriesIds: shelves.map((shelf) => shelf.productSubcategoryId).filter(Boolean),
        updatedAt: timestamp,
      };
      if (photoUrl && /^https?:\/\//i.test(photoUrl)) {
        sharedFields.images = [{
          fileUrl: photoUrl,
          fileName: '',
          folderPath: '',
          quality: 100,
          itsFromPlatform: true,
          reference: null,
        }];
      }

      if (isNewProduct) {
        batch.set(productRef, {
          ...sharedFields,
          isActive: true,
          isTrashed: false,
          mobileId: null,
          publicProductRef: null,
          externalId: null,
          companyRef: establishmentRef,
          quantityInStock: 0,
          unitQuantity: 1,
          unityType: 'un',
          images: sharedFields.images || [],
          historyPrice: [{ createdAt: historyTimestamp, price, fromPrice: price }],
          searchIndex: buildSearchIndex(name, description),
          wordKeys: buildWordKeys(name),
          deletedAt: null,
          createdAt: timestamp,
        });
        opsInBatch += 1;

        batch.set(productsRef.doc(productId).collection('barCode').doc(), {
          code: ean,
          createdAt: timestamp,
          isActive: true,
        });
        opsInBatch += 1;

        const globalRef = this.firestore.collection('produtos').doc();
        batch.set(globalRef, {
          id: globalRef.id,
          name,
          description,
          barCode: ean,
          searchIndex: buildSearchIndex(name, description),
        });
        opsInBatch += 1;

        existingBarcodes.set(ean, productId);
        created += 1;
      } else {
        batch.set(productRef, sharedFields, { merge: true });
        opsInBatch += 1;
        updated += 1;
      }

      if (opsInBatch >= BATCH_OP_LIMIT) flushBatch();

      if (processed % PROGRESS_LOG_EVERY === 0 || processed === rows.length) {
        onProgress({
          step: '01',
          pct: Math.round((processed / rows.length) * 100),
          status: 'executando',
          message: `Processando ${processed}/${rows.length}`,
          summary: { created, updated, skipped, total: rows.length },
        });
      }
    }

    flushBatch();
    await Promise.all(pendingCommits);

    const summary = { created, updated, skipped, total: rows.length };
    onProgress({ step: '01', pct: 100, status: 'concluido', message: 'Importacao concluida', summary });
    return summary;
  }
}
