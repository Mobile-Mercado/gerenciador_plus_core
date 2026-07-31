const admin = require('firebase-admin');
const {
  contributionFromOrder,
  reconcileOrderHourlySales,
} = require('../hourlySalesAggregation');

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function usage() {
  return [
    'Uso:',
    '  node scripts/backfillHourlySales.js --apply --establishment ID --year AAAA [--max-orders 10000] [--page-size 250]',
    '',
    'A rotina le somente os pedidos da loja e do ano informados.',
    'Ela nao imprime nomes, itens, valores ou outros dados dos clientes.',
  ].join('\n');
}

async function markCoverageReady(db, FieldValue, establishmentId, year) {
  const establishmentRef = db.collection('estabelecimentos').doc(establishmentId);
  const now = new Date();
  const currentYear = now.getFullYear();
  const coverageEnd = year === currentYear
    ? admin.firestore.Timestamp.fromDate(now)
    : admin.firestore.Timestamp.fromDate(new Date(`${year + 1}-01-01T02:59:59.999Z`));
  const coverageStart = admin.firestore.Timestamp.fromDate(
    new Date(`${year}-01-01T03:00:00.000Z`),
  );
  const batch = db.batch();
  const metadata = {
    hourlySalesReady: true,
    hourlySalesCoverageStart: coverageStart,
    hourlySalesCoverageEnd: coverageEnd,
    hourlySalesBackfilledAt: FieldValue.serverTimestamp(),
  };

  batch.set(
    establishmentRef.collection('Stats').doc(`sales-${year}`),
    {
      ...metadata,
      hourlySalesPeriod: 'year',
      hourlySalesYear: year,
    },
    { merge: true },
  );

  for (let month = 1; month <= 12; month += 1) {
    const monthId = `01-${String(month).padStart(2, '0')}-${year}`;
    batch.set(
      establishmentRef.collection('MonthlyStats').doc(monthId),
      {
        ...metadata,
        hourlySalesPeriod: 'month',
        hourlySalesYear: year,
        hourlySalesMonth: month,
      },
      { merge: true },
    );
  }
  await batch.commit();
}

async function main() {
  if (!process.argv.includes('--apply')) {
    throw new Error(`Nenhuma leitura foi executada.\n\n${usage()}`);
  }

  const establishmentId = argument('establishment');
  const year = Number(argument('year'));
  const maxOrders = Math.max(1, Number(argument('max-orders')) || 10000);
  const pageSize = Math.min(500, Math.max(1, Number(argument('page-size')) || 250));
  const projectId = argument('project') || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;

  if (!establishmentId || !Number.isInteger(year) || year < 2020 || year > 2100) {
    throw new Error(usage());
  }

  admin.initializeApp(projectId ? { projectId } : undefined);
  const db = admin.firestore();
  const FieldValue = admin.firestore.FieldValue;
  const companyReference = db.collection('estabelecimentos').doc(establishmentId);
  const start = admin.firestore.Timestamp.fromDate(new Date(`${year}-01-01T03:00:00.000Z`));
  const end = admin.firestore.Timestamp.fromDate(new Date(`${year + 1}-01-01T03:00:00.000Z`));

  let lastDocument = null;
  let scanned = 0;
  let confirmed = 0;
  let reconciled = 0;

  while (true) {
    let ordersQuery = db
      .collection('PurchaseRequests')
      .where('companyReference', '==', companyReference)
      .where('createdAt', '>=', start)
      .where('createdAt', '<', end)
      .orderBy('createdAt')
      .limit(pageSize);
    if (lastDocument) ordersQuery = ordersQuery.startAfter(lastDocument);

    const snapshot = await ordersQuery.get();
    if (snapshot.empty) break;
    if (scanned + snapshot.size > maxOrders) {
      throw new Error(
        `Limite de seguranca atingido (${maxOrders}). Os acumulados parciais foram mantidos, `
        + 'mas ainda nao foram marcados como prontos. Aumente --max-orders e execute novamente.',
      );
    }

    for (const orderDocument of snapshot.docs) {
      scanned += 1;
      if (contributionFromOrder(orderDocument.data())) confirmed += 1;
      const result = await reconcileOrderHourlySales({
        db,
        FieldValue,
        orderRef: orderDocument.ref,
      });
      if (result.changed) reconciled += 1;
    }

    lastDocument = snapshot.docs.at(-1);
  }

  await markCoverageReady(db, FieldValue, establishmentId, year);
  console.log(JSON.stringify({
    success: true,
    establishmentId,
    year,
    scannedOrders: scanned,
    confirmedOrders: confirmed,
    reconciledOrders: reconciled,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
