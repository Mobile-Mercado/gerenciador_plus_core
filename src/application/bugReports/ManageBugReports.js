import { Timestamp } from 'firebase-admin/firestore';
import { AppError } from '../../domain/errors/AppError.js';

export class ManageBugReports {
  constructor({ bugReportRepository, accessRepository, clock = () => new Date() }) {
    this.bugReportRepository = bugReportRepository;
    this.accessRepository = accessRepository;
    this.clock = clock;
  }

  async listReports({ actorUid, from, to, resolved }) {
    const account = await this.requireEstablishment(actorUid);
    const filters = {
      from: from ? Timestamp.fromDate(new Date(from)) : null,
      to: to ? Timestamp.fromDate(new Date(to)) : null,
    };
    const reports = await this.bugReportRepository.list(account.establishmentId, filters);
    if (resolved == null) return reports;
    return reports.filter((report) => Boolean(report.resolved) === resolved);
  }

  async setResolved({ actorUid, reportId, resolved }) {
    const account = await this.requireEstablishment(actorUid);
    const report = await this.bugReportRepository.findById(account.establishmentId, reportId);
    if (!report) {
      throw new AppError('Report nao encontrado.', {
        statusCode: 404,
        code: 'bug_report_not_found',
      });
    }
    await this.bugReportRepository.update(account.establishmentId, reportId, {
      resolved,
      resolvedAt: resolved ? Timestamp.fromDate(this.clock()) : null,
    });
  }

  async requireEstablishment(actorUid) {
    const account = await this.accessRepository.findAccountByUid(actorUid);
    if (!account?.hasEstablishment) {
      throw new AppError('Conta sem estabelecimento vinculado.', {
        statusCode: 403,
        code: 'bug_report_no_establishment',
      });
    }
    return account;
  }
}
