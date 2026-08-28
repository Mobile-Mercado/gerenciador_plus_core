export class BugReportRepository {
  async list(_establishmentId, _filters) {
    throw new Error('BugReportRepository.list nao implementado.');
  }

  async findById(_establishmentId, _reportId) {
    throw new Error('BugReportRepository.findById nao implementado.');
  }

  async update(_establishmentId, _reportId, _patch) {
    throw new Error('BugReportRepository.update nao implementado.');
  }
}
