export class UpdateImplantationApprovalUseCase {
  constructor({ manageImplantationPipelines, manageWebNotifications, logger }) {
    this.manageImplantationPipelines = manageImplantationPipelines;
    this.manageWebNotifications = manageWebNotifications;
    this.logger = logger;
  }

  async execute(input) {
    const pipeline = await this.manageImplantationPipelines.setApproval(input);

    try {
      await this.manageWebNotifications.sendSystemNotification(
        buildApprovalNotification(input, pipeline),
      );
    } catch (error) {
      this.logger.warn('implantation_approval_notification_failed', {
        establishmentId: input.establishmentId,
        step: input.step,
        checkId: input.checkId,
        code: error?.code || 'notification_failed',
      });
    }

    return pipeline;
  }
}

function buildApprovalNotification(input, pipeline) {
  const check = pipeline.manualChecks?.[input.step]?.[input.checkId];
  const stepCompleted = Number(pipeline.steps?.[input.step]?.pct || 0) >= 100;
  let body = input.approved
    ? `${check?.label || 'Verificacao'} aprovada.`
    : `${check?.label || 'Verificacao'} voltou para revisao.`;

  if (input.approved && input.step === '06' && stepCompleted) {
    body = 'Validacao final aprovada. A ativacao do agente de vendas IA foi liberada.';
  } else if (input.approved && input.step === '07' && stepCompleted) {
    body = 'Todas as verificacoes da ativacao do agente IA foram aprovadas.';
  }

  return {
    establishmentId: input.establishmentId,
    title: input.approved ? 'Implantacao atualizada' : 'Implantacao em revisao',
    body,
    url: '/implantacao',
    tag: `implantacao-${input.step}`,
    data: {
      type: 'implantation_approval',
      step: input.step,
      checkId: input.checkId,
      approved: String(input.approved),
    },
  };
}
