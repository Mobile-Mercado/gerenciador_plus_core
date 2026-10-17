import { FieldValue } from 'firebase-admin/firestore';
import { cpfValido, validarCpf } from '../../domain/cadastro/validacoes.js';
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

  // Dono da loja: o documento de Users apontado em userReference (o mesmo do cadastro, que
  // guardava o CPF em cpfDocument).
  async donoDaLoja(establishmentId, transaction = null) {
    const ler = (ref) => (transaction ? transaction.get(ref) : ref.get());
    const loja = await ler(this.firestore.collection('estabelecimentos').doc(establishmentId));
    const campo = loja.exists ? loja.data()?.userReference : null;
    // Loja antiga pode guardar o caminho em texto ("Users/{id}") em vez da referencia.
    const referencia = typeof campo === 'string' && campo.startsWith('Users/') ? this.firestore.doc(campo) : campo;
    const usuario = referencia && typeof referencia.get === 'function' ? await ler(referencia) : null;
    if (!usuario?.exists) {
      throw new AppError('Esta loja não tem a conta do dono ligada. Fale com a Móbile.', {
        statusCode: 409,
        code: 'implantacao_loja_sem_dono',
      });
    }
    return { loja, usuario };
  }

  // CPF do dono, so com os 2 ultimos numeros a mostra: o painel libera o "Aprovar e lancar".
  async cpfDoDono(establishmentId) {
    const { usuario } = await this.donoDaLoja(establishmentId);
    const cpf = String(usuario.data()?.cpfDocument || '');
    const temCpf = cpfValido(cpf);
    return { temCpf, cpfMascarado: temCpf ? `***.***.***-${cpf.slice(-2)}` : null };
  }

  // Grava o CPF do dono (mesma validacao do cadastro) em Users do dono, campo cpfDocument.
  async gravarCpfDoDono({ establishmentId, cpf, uid }) {
    const digitos = validarCpf(cpf);
    const { usuario } = await this.donoDaLoja(establishmentId);
    await usuario.ref.set({
      cpfDocument: digitos,
      cpfGravadoEm: FieldValue.serverTimestamp(),
      cpfGravadoPor: uid || null,
    }, { merge: true });
    return this.cpfDoDono(establishmentId);
  }

  // Aprovacao formal do lojista (faixa de implantacao do Gerenciador Plus): so depois que a
  // implantacao chega na validacao (etapa 06 liberada). Grava o nome de quem aprovou e a data,
  // e marca a verificacao clientApprovalRecorded da etapa 06.
  async aprovarFormalmente({ establishmentId, nome, uid }) {
    const reference = this.pipelineRef(establishmentId);
    await this.firestore.runTransaction(async (transaction) => {
      // "Aprovar e lancar" so com o CPF do dono gravado (ordem nova de 16/10/2026: o CPF saiu do
      // cadastro e passou para a aprovacao final).
      const { usuario } = await this.donoDaLoja(establishmentId, transaction);
      const snapshot = await transaction.get(reference);
      const pipeline = normalizePipeline(snapshot.exists ? snapshot.data() : {}, establishmentId);
      // Mesma regra da faixa do painel: a 06 aberta ou as etapas antes dela (menos a 05, pulada)
      // terminadas.
      const antesDaValidacao = ['01', '02', '03', '04'].every((step) => Number(pipeline.steps?.[step]?.pct) >= 100);
      if (!pipeline.unlockedSteps.includes('06') && !antesDaValidacao) {
        throw new AppError('A aprovação formal abre quando a implantação chega na validação.', {
          statusCode: 409,
          code: 'implantacao_aprovacao_antes_da_validacao',
        });
      }
      if (pipeline.aprovacaoFormal?.em) {
        throw new AppError('A implantação já tem aprovação formal.', { statusCode: 409, code: 'implantacao_ja_aprovada' });
      }
      if (!cpfValido(usuario.data()?.cpfDocument)) {
        throw new AppError('Preencha o CPF do dono da empresa antes de aprovar o lançamento.', {
          statusCode: 409,
          code: 'implantacao_cpf_obrigatorio',
        });
      }
      transaction.set(reference, {
        aprovacaoFormal: { nome, uid, em: FieldValue.serverTimestamp() },
        manualChecks: {
          '06': {
            clientApprovalRecorded: {
              ...pipeline.manualChecks['06'].clientApprovalRecorded,
              approved: true,
              note: `Aprovação formal de ${nome}`,
              approvedByUid: uid,
              approvedAt: FieldValue.serverTimestamp(),
            },
          },
        },
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });
    return this.get(establishmentId);
  }

  // Fase final da Ficha no Admin: "App nas lojas", marcada pela equipe.
  async marcarAppNasLojas({ establishmentId, feito, uid }) {
    await this.pipelineRef(establishmentId).set({
      type: 'pipeline',
      appNasLojas: feito ? { em: FieldValue.serverTimestamp(), uid } : null,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
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
