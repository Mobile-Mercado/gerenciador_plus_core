import { FieldValue } from 'firebase-admin/firestore';
import { AppError } from '../../domain/errors/AppError.js';

const PIPELINE_COLLECTION = 'implantacaoGrenciador';
const PIPELINE_DOCUMENT = 'pipeline';
const MANUAL_CHECKS = Object.freeze({
  '06': {
    catalogReviewed: 'Catálogo em homologação revisado',
    pricesAndWeightsChecked: 'Preços e pesos vs. ERP',
    purchaseFlowTested: 'Fluxo de compra testado',
    paymentIntegrationChecked: 'Integração de pagamento ok',
    clientApprovalRecorded: 'Aprovação formal do cliente',
    mobileDevicesTested: 'Teste mobile em 2 dispositivos',
  },
  '07': {
    previousStepsChecked: 'Todos os passos obrigatórios ok',
    agentProfileConfigured: 'Configuração de tom e persona',
    standardResponseTested: 'Teste de resposta padrão',
    channelsConnected: 'Canais conectados',
    responsibleAuthorization: 'Autorizado pelo responsável',
    clientNotified: 'Cliente notificado',
  },
});

export class ManageImplantationPipelines {
  constructor({ firestore }) {
    this.firestore = firestore;
  }

  async list({ maxItems = 100 } = {}) {
    const snapshot = await this.firestore
      .collectionGroup(PIPELINE_COLLECTION)
      .where('type', '==', 'pipeline')
      .limit(Math.min(100, Math.max(1, Number(maxItems) || 100)))
      .get();

    return snapshot.docs
      .filter((document) => document.id === PIPELINE_DOCUMENT)
      .map((document) => normalizePipeline(document.data(), establishmentIdFromPath(document.ref.path)))
      .sort((left, right) => timestampMs(right.updatedAt) - timestampMs(left.updatedAt));
  }

  async get(establishmentId) {
    const snapshot = await this.pipelineRef(establishmentId).get();
    if (!snapshot.exists) {
      throw new AppError('Implantação não encontrada para este estabelecimento.', {
        statusCode: 404,
        code: 'implantation_pipeline_not_found',
      });
    }
    return normalizePipeline(snapshot.data(), establishmentId);
  }

  async setApproval({ establishmentId, step, checkId, approved, note, adminUid }) {
    if (!MANUAL_CHECKS[step]?.[checkId]) {
      throw new AppError('Etapa ou verificação manual inválida.', {
        statusCode: 400,
        code: 'implantation_check_invalid',
      });
    }

    const reference = this.pipelineRef(establishmentId);
    await this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) {
        throw new AppError('Implantação não encontrada para este estabelecimento.', {
          statusCode: 404,
          code: 'implantation_pipeline_not_found',
        });
      }

      const pipeline = normalizePipeline(snapshot.data(), establishmentId);
      const checks = pipeline.manualChecks[step];
      checks[checkId] = {
        ...checks[checkId],
        approved,
        note: String(note || '').trim().slice(0, 500),
        approvedByUid: approved ? adminUid : null,
        approvedAt: approved ? FieldValue.serverTimestamp() : null,
      };

      const values = Object.values(checks);
      const approvedCount = values.filter((item) => item.approved).length;
      const completed = approvedCount === values.length;
      const pct = Math.round((approvedCount / values.length) * 100);
      const unlockedSteps = new Set(pipeline.unlockedSteps);
      unlockedSteps.add(step);
      if (completed && step === '06') unlockedSteps.add('07');

      transaction.set(reference, {
        manualChecks: pipeline.manualChecks,
        steps: {
          ...pipeline.steps,
          [step]: {
            ...pipeline.steps[step],
            pct,
            status: completed ? 'concluido' : 'aguardando aprovação',
            hasRun: pipeline.steps[step]?.hasRun === true || completed,
            lastRunAt: completed ? new Date().toISOString() : pipeline.steps[step]?.lastRunAt || null,
          },
        },
        unlockedSteps: [...unlockedSteps].sort(),
        updatedAt: FieldValue.serverTimestamp(),
        lastApprovalByUid: adminUid,
      }, { merge: true });
    });

    return this.get(establishmentId);
  }

  pipelineRef(establishmentId) {
    return this.firestore
      .collection('estabelecimentos')
      .doc(establishmentId)
      .collection(PIPELINE_COLLECTION)
      .doc(PIPELINE_DOCUMENT);
  }
}

function normalizePipeline(data = {}, establishmentId = '') {
  const manualChecks = {};
  Object.entries(MANUAL_CHECKS).forEach(([step, definitions]) => {
    manualChecks[step] = {};
    Object.entries(definitions).forEach(([checkId, label]) => {
      manualChecks[step][checkId] = {
        label,
        approved: false,
        ...(data.manualChecks?.[step]?.[checkId] || {}),
      };
    });
  });

  return {
    ...data,
    type: 'pipeline',
    establishmentId: data.establishmentId || establishmentId,
    establishmentName: data.establishmentName || data.establishmentId || establishmentId,
    steps: data.steps || {},
    manualChecks,
    unlockedSteps: Array.isArray(data.unlockedSteps) ? data.unlockedSteps : ['01'],
  };
}

function establishmentIdFromPath(path) {
  return String(path || '').split('/')[1] || '';
}

function timestampMs(value) {
  if (typeof value?.toMillis === 'function') return value.toMillis();
  if (typeof value?._seconds === 'number') return value._seconds * 1000;
  if (typeof value?.seconds === 'number') return value.seconds * 1000;
  return Number(value) || 0;
}
