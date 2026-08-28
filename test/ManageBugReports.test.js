import assert from 'node:assert/strict';
import test from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';
import { ManageBugReports } from '../src/application/bugReports/ManageBugReports.js';

function createManager({
  hasEstablishment = true,
  establishmentId = 'loja-1',
  reports = [],
  updates = [],
  listedFilters = [],
} = {}) {
  return new ManageBugReports({
    accessRepository: {
      async findAccountByUid() {
        return { hasEstablishment, establishmentId };
      },
    },
    bugReportRepository: {
      async list(_establishmentId, filters) {
        listedFilters.push(filters);
        return reports;
      },
      async findById(_establishmentId, reportId) {
        return reports.find((report) => report.id === reportId) ?? null;
      },
      async update(_establishmentId, reportId, patch) {
        updates.push({ reportId, ...patch });
      },
    },
    clock: () => new Date('2026-08-27T12:00:00.000Z'),
  });
}

test('listReports rejeita ator sem estabelecimento vinculado', async () => {
  const manager = createManager({ hasEstablishment: false });

  await assert.rejects(
    manager.listReports({ actorUid: 'uid-sem-loja' }),
    (error) => error.code === 'bug_report_no_establishment' && error.statusCode === 403,
  );
});

test('listReports converte o período em Timestamp para a consulta', async () => {
  const listedFilters = [];
  const manager = createManager({ listedFilters });

  await manager.listReports({
    actorUid: 'uid-lojista',
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-27T23:59:59.000Z',
  });

  assert.deepEqual(listedFilters[0].from, Timestamp.fromDate(new Date('2026-08-01T00:00:00.000Z')));
  assert.deepEqual(listedFilters[0].to, Timestamp.fromDate(new Date('2026-08-27T23:59:59.000Z')));
});

test('listReports filtra por status resolvido quando informado', async () => {
  const reports = [
    { id: 'a', resolved: true },
    { id: 'b', resolved: false },
    { id: 'c' },
  ];
  const manager = createManager({ reports });

  const resolvedOnly = await manager.listReports({ actorUid: 'uid-lojista', resolved: true });
  const openOnly = await manager.listReports({ actorUid: 'uid-lojista', resolved: false });
  const all = await manager.listReports({ actorUid: 'uid-lojista', resolved: null });

  assert.deepEqual(resolvedOnly.map((report) => report.id), ['a']);
  assert.deepEqual(openOnly.map((report) => report.id), ['b', 'c']);
  assert.equal(all.length, 3);
});

test('setResolved grava resolvedAt ao resolver e limpa ao reabrir', async () => {
  const updates = [];
  const manager = createManager({ reports: [{ id: 'a', resolved: false }], updates });

  await manager.setResolved({ actorUid: 'uid-lojista', reportId: 'a', resolved: true });
  await manager.setResolved({ actorUid: 'uid-lojista', reportId: 'a', resolved: false });

  assert.equal(updates[0].resolved, true);
  assert.deepEqual(updates[0].resolvedAt, Timestamp.fromDate(new Date('2026-08-27T12:00:00.000Z')));
  assert.equal(updates[1].resolved, false);
  assert.equal(updates[1].resolvedAt, null);
});

test('setResolved rejeita report inexistente', async () => {
  const manager = createManager();

  await assert.rejects(
    manager.setResolved({ actorUid: 'uid-lojista', reportId: 'nao-existe', resolved: true }),
    (error) => error.code === 'bug_report_not_found' && error.statusCode === 404,
  );
});
