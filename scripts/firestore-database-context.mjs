import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_OUTPUT = '../DATABASE.firestore-context.generated.md';
const DEFAULT_DATABASE_MD = '../DATABASE.md';
const START_MARKER = '<!-- FIRESTORE_AUTO_CONTEXT_START -->';
const END_MARKER = '<!-- FIRESTORE_AUTO_CONTEXT_END -->';

const NEVER_SAMPLE_COLLECTIONS = new Set([
  'AgenteVendas',
  'Agentes',
  'Automacoes',
]);

const SENSITIVE_COLLECTIONS = new Set([
  'Chats',
  'Messages',
  'PurchaseRequests',
  'User',
  'Users',
  'addresses',
]);

const DEFAULT_SAFE_SAMPLE_COLLECTIONS = new Set([
  'Banners',
  'DailyStats',
  'MonthlyStats',
  'ProductCategories',
  'ProductSubcategories',
  'Products',
  'Stats',
  'implantacaoGrenciador',
  'paymentMethods',
]);

const SENSITIVE_FIELD_PATTERN = /(access|address|api.?key|auth|bearer|cep|city|cnpj|cpf|credential|email|endereco|lat|lng|location|longitude|latitude|password|phone|secret|senha|street|token|uid|zip)/i;

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(__dirname, '..');
let AdminFieldPath = null;
let adminGetFirestoreDb = null;

async function loadFirebaseAdmin() {
  if (AdminFieldPath && adminGetFirestoreDb) return;
  const firestoreModule = await import('firebase-admin/firestore');
  const firebaseAdminModule = await import('../src/infra/firebase/firebaseAdmin.js');
  AdminFieldPath = firestoreModule.FieldPath;
  adminGetFirestoreDb = firebaseAdminModule.getFirestoreDb;
}

function parseArgs(argv) {
  const args = {
    apply: false,
    config: 'scripts/firestore-context.config.example.json',
    database: DEFAULT_DATABASE_MD,
    out: DEFAULT_OUTPUT,
    maxDepth: 4,
    maxCollections: 250,
    sampleDocs: 1,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--config') args.config = next();
    else if (arg === '--database') args.database = next();
    else if (arg === '--out') args.out = next();
    else if (arg === '--max-depth') args.maxDepth = boundedInteger(next(), 1, 8, args.maxDepth);
    else if (arg === '--max-collections') args.maxCollections = boundedInteger(next(), 1, 1000, args.maxCollections);
    else if (arg === '--sample-docs') args.sampleDocs = boundedInteger(next(), 1, 3, args.sampleDocs);
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Argumento desconhecido: ${arg}`);
  }

  return args;
}

function boundedInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function helpText() {
  return `Uso:
  node scripts/firestore-database-context.mjs [opcoes]

Modo seguro:
  - Nao imprime valores reais dos documentos.
  - Nao amostra colecoes sensiveis por padrao.
  - Ignora sempre: ${[...NEVER_SAMPLE_COLLECTIONS].join(', ')}.
  - Para colecoes grandes, use docIds explicitos no JSON de config.

Opcoes:
  --config <arquivo>        JSON de configuracao. Padrao: scripts/firestore-context.config.example.json
  --out <arquivo>           Arquivo gerado para revisao. Padrao: ${DEFAULT_OUTPUT}
  --apply                   Insere o resultado no DATABASE.md entre marcadores.
  --database <arquivo>      DATABASE.md usado com --apply. Padrao: ${DEFAULT_DATABASE_MD}
  --max-depth <n>           Profundidade maxima de subcolecoes. Padrao: 4.
  --sample-docs <n>         Docs por colecao segura, entre 1 e 3. Padrao: 1.
  --max-collections <n>     Trava de seguranca. Padrao: 250.
`;
}

async function loadConfig(configPath) {
  if (!configPath) return {};
  try {
    const raw = await readFile(resolve(backendRoot, configPath), 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function normalizePath(path) {
  return String(path || '').replace(/^\/+|\/+$/g, '');
}

function parts(path) {
  return normalizePath(path).split('/').filter(Boolean);
}

function collectionName(path) {
  const items = parts(path);
  return items[items.length - 1] || '';
}

function wildcardPath(path) {
  return parts(path).map((part, index) => (index % 2 === 1 ? '*' : part)).join('/');
}

function configDocIds(path, config) {
  const normalized = normalizePath(path);
  const wildcard = wildcardPath(normalized);
  const map = config.docIdsByCollectionPath || {};
  const ids = map[normalized] || map[wildcard] || [];
  return Array.isArray(ids)
    ? ids.map((id) => String(id).trim()).filter((id) => id && !id.startsWith('COLOQUE_AQUI'))
    : [];
}

function manualContext(path, config) {
  const name = collectionName(path);
  return config.manualContextCollections?.[path]
    || config.manualContextCollections?.[wildcardPath(path)]
    || config.manualContextCollections?.[name]
    || '';
}

function safeSampleCollections(config) {
  return new Set([
    ...DEFAULT_SAFE_SAMPLE_COLLECTIONS,
    ...(Array.isArray(config.safeSampleCollections) ? config.safeSampleCollections : []),
  ]);
}

function shouldNeverSample(path) {
  return NEVER_SAMPLE_COLLECTIONS.has(collectionName(path));
}

function shouldSkipSensitive(path, config) {
  const name = collectionName(path);
  const configured = new Set([
    ...SENSITIVE_COLLECTIONS,
    ...(Array.isArray(config.sensitiveCollections) ? config.sensitiveCollections : []),
  ]);
  return configured.has(name);
}

function canSampleSchema(path, config) {
  if (shouldNeverSample(path) || shouldSkipSensitive(path, config)) return false;
  return safeSampleCollections(config).has(collectionName(path));
}

async function getDocRefs(collectionRef, path, config, sampleDocs) {
  const explicitIds = configDocIds(path, config);
  if (explicitIds.length) {
    return explicitIds.slice(0, sampleDocs).map((id) => collectionRef.doc(id));
  }

  const snapshot = await collectionRef
    .orderBy(AdminFieldPath.documentId())
    .limit(sampleDocs)
    .select()
    .get();
  return snapshot.docs.map((doc) => doc.ref);
}

async function sampleSchemaDocs(collectionRef, path, config, sampleDocs) {
  if (!canSampleSchema(path, config)) return [];

  const explicitIds = configDocIds(path, config);
  if (!explicitIds.length && collectionName(path) === 'Products') {
    return [];
  }

  const refs = await getDocRefs(collectionRef, path, config, sampleDocs);
  const snapshots = [];
  for (const ref of refs) {
    // Leitura de documento completo ocorre somente para colecoes consideradas seguras.
    // Valores nunca sao gravados no markdown.
    // eslint-disable-next-line no-await-in-loop
    const snapshot = await ref.get();
    if (snapshot.exists) snapshots.push(snapshot);
  }
  return snapshots;
}

function fieldType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    const first = value.find((item) => item !== null && item !== undefined);
    return `array<${first === undefined ? 'unknown' : fieldType(first)}>`;
  }
  if (value?.toDate && typeof value.toDate === 'function') return 'timestamp';
  if (value?.latitude !== undefined && value?.longitude !== undefined) return 'geopoint';
  if (value && typeof value === 'object') return 'object';
  return typeof value;
}

function flattenFields(data, prefix = '') {
  const rows = [];
  Object.entries(data || {}).forEach(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (SENSITIVE_FIELD_PATTERN.test(path)) return;
    rows.push({ path, type: fieldType(value) });
    if (value && typeof value === 'object' && !Array.isArray(value) && !value.toDate && value.latitude === undefined) {
      rows.push(...flattenFields(value, path));
    }
  });
  return rows;
}

function mergeFields(snapshots) {
  const map = new Map();
  snapshots.forEach((snapshot) => {
    flattenFields(snapshot.data() || {}).forEach((field) => {
      const current = map.get(field.path) || { path: field.path, types: new Set() };
      current.types.add(field.type);
      map.set(field.path, current);
    });
  });
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function scanCollection(collectionRef, path, options, config, stats, depth = 1) {
  if (stats.collections >= options.maxCollections) return null;

  stats.collections += 1;
  const entry = {
    path,
    mode: 'sampled',
    reason: '',
    manualContext: manualContext(path, config),
    sampleDocIds: [],
    fields: [],
    children: [],
  };

  if (shouldNeverSample(path)) {
    entry.mode = 'excluded';
    entry.reason = 'colecao excluida por regra do projeto';
    return entry;
  }

  if (shouldSkipSensitive(path, config)) {
    entry.mode = 'manual';
    entry.reason = 'colecao sensivel; documentos nao foram lidos';
  } else if (!canSampleSchema(path, config)) {
    entry.mode = 'manual';
    entry.reason = 'colecao fora da lista segura; preencha manualmente se necessario';
  } else {
    const samples = await sampleSchemaDocs(collectionRef, path, config, options.sampleDocs);
    stats.documentReads += samples.length;
    entry.sampleDocIds = samples.map((snapshot) => snapshot.id);
    entry.fields = mergeFields(samples);
    if (!samples.length) {
      entry.mode = 'manual';
      entry.reason = collectionName(path) === 'Products'
        ? 'colecao grande; defina um ID especifico no config antes de amostrar'
        : 'nenhum documento de amostra encontrado';
    }
  }

  if (depth >= options.maxDepth) return entry;

  const refsForSubcollections = await getDocRefs(collectionRef, path, config, 1);
  stats.metadataReads += refsForSubcollections.length;
  for (const ref of refsForSubcollections) {
    // listCollections usa apenas a referencia do documento de amostra.
    // eslint-disable-next-line no-await-in-loop
    const subcollections = await ref.listCollections();
    for (const subcollection of subcollections) {
      const childPath = `${path}/{${collectionName(path)}Id}/${subcollection.id}`;
      // eslint-disable-next-line no-await-in-loop
      const child = await scanCollection(subcollection, childPath, options, config, stats, depth + 1);
      if (child) entry.children.push(child);
    }
  }

  return entry;
}

async function scanFirestore(options, config) {
  await loadFirebaseAdmin();
  const db = adminGetFirestoreDb();
  const stats = { collections: 0, documentReads: 0, metadataReads: 0 };
  const rootCollections = await db.listCollections();
  const entries = [];

  for (const collectionRef of rootCollections.sort((a, b) => a.id.localeCompare(b.id))) {
    // eslint-disable-next-line no-await-in-loop
    const entry = await scanCollection(collectionRef, collectionRef.id, options, config, stats);
    if (entry) entries.push(entry);
  }

  return { entries, stats };
}

function renderEntry(entry, level = 2) {
  const lines = [`${'#'.repeat(level)} ${entry.path}`, ''];

  lines.push(`- Modo: ${entry.mode}.`);
  if (entry.reason) lines.push(`- Motivo: ${entry.reason}.`);
  if (entry.manualContext) lines.push(`- Contexto manual sugerido: ${entry.manualContext}`);
  else lines.push('- Contexto a preencher: _descreva aqui o papel desta colecao no produto._');
  if (entry.sampleDocIds.length) lines.push(`- Documento amostrado: ${entry.sampleDocIds.map((id) => `\`${id}\``).join(', ')}.`);

  lines.push('', '| Campo | Tipos encontrados | Contexto |', '| --- | --- | --- |');
  if (entry.fields.length) {
    entry.fields.forEach((field) => {
      lines.push(`| \`${field.path}\` | ${[...field.types].join(' / ')} | _preencher_ |`);
    });
  } else {
    lines.push('| _nao amostrado_ | - | _preencher manualmente, se necessario_ |');
  }

  if (entry.children.length) {
    lines.push('', ...entry.children.map((child) => renderEntry(child, level + 1)));
  }

  return `${lines.join('\n')}\n`;
}

function renderMarkdown(result, options) {
  return `# Contexto Firestore Gerado

Gerado em: ${new Date().toISOString()}

Este arquivo e um rascunho local para completar o \`DATABASE.md\`.

## Garantias do modo seguro

- Nao grava valores reais de documentos no arquivo.
- Nao amostra colecoes sensiveis por padrao: ${[...SENSITIVE_COLLECTIONS].map((name) => `\`${name}\``).join(', ')}.
- Ignora sempre as colecoes solicitadas: ${[...NEVER_SAMPLE_COLLECTIONS].map((name) => `\`${name}\``).join(', ')}.
- Campos com nomes sensiveis, como token, senha, email, telefone, CPF/CNPJ e endereco, sao removidos da tabela.
- Colecoes grandes como \`Products\` exigem ID especifico no arquivo de configuracao.
- O resultado deve ser revisado antes de entrar no \`DATABASE.md\`.

## Leituras estimadas

- Colecoes visitadas: ${result.stats.collections}.
- Leituras de documentos para schema: ${result.stats.documentReads}.
- Leituras/referencias para descobrir subcolecoes: ${result.stats.metadataReads}.
- Profundidade maxima: ${options.maxDepth}.
- Amostras por colecao segura: ${options.sampleDocs}.

${result.entries.map((entry) => renderEntry(entry)).join('\n')}
`;
}

async function applyToDatabase(markdown, databasePath) {
  const target = resolve(backendRoot, databasePath);
  let current = '';
  try {
    current = await readFile(target, 'utf8');
  } catch {
    current = '# DATABASE.md\n';
  }

  const block = `${START_MARKER}\n${markdown.trim()}\n${END_MARKER}`;
  const start = current.indexOf(START_MARKER);
  const end = current.indexOf(END_MARKER);
  const next = start >= 0 && end > start
    ? `${current.slice(0, start)}${block}${current.slice(end + END_MARKER.length)}`
    : `${current.trimEnd()}\n\n${block}\n`;

  await writeFile(target, next, 'utf8');
  return target;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(helpText());
    return;
  }

  await import('dotenv/config').catch(() => {});
  const config = await loadConfig(options.config);
  const result = await scanFirestore(options, config);
  const markdown = renderMarkdown(result, options);

  if (options.apply) {
    const target = await applyToDatabase(markdown, options.database);
    console.log(`DATABASE.md atualizado em: ${target}`);
  } else {
    const output = resolve(backendRoot, options.out);
    await writeFile(output, markdown, 'utf8');
    console.log(`Arquivo gerado para revisao: ${output}`);
  }

  console.log(`Leituras de documentos para schema: ${result.stats.documentReads}`);
  console.log(`Referencias usadas para subcolecoes: ${result.stats.metadataReads}`);
  console.log(`Colecoes visitadas: ${result.stats.collections}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
