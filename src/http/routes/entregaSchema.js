import { z } from 'zod';

// Entrega da loja: o mesmo contrato no Admin (PATCH /api/admin/estabelecimentos/:lojaId/entrega) e
// na propria loja (PATCH /api/loja/entrega, cola RP-7). So os campos conhecidos; o que nao vier fica
// como esta. As regras (pares, horarios, janelas) ficam no caso de uso EntregaDaLoja.
const numero = z.number().finite().min(0).max(1000000);
const inteiro = z.number().int().min(0).max(100000);
const horario = z.string().regex(/^\d{2}:\d{2}$/);
const vagas = z.number().int().min(1).max(100000);
// Janelas proprias por dia: os 7 dias de deliveryInfo.weekDaysDelivery, horarios em HH:mm.
const diaDeEntregaSchema = z.object({
  weekday: z.number().int().min(1).max(7),
  canDelivery: z.boolean(),
  initTime: horario,
  endTime: horario,
  interval: z.number().int().min(1).max(24),
  maxSchedulesPerTime: vagas,
  scheduleIntervalType: z.enum(['hours', 'days']).optional(),
  customIntervals: z.array(z.object({
    init: horario,
    end: horario,
    freight: numero.nullable().optional(),
    maxSchedulesPerTime: vagas,
    canDelivery: z.boolean(),
  }).strict()).max(24),
}).strict();
export const entregaSchema = z.object({
  deliveryInfo: z.object({
    deliveryCalcType: z.enum(['DeliveryCalcType.distance', 'DeliveryCalcType.fixedValue']).optional(),
    fixedValue: numero.optional(),
    baseValue: numero.optional(),
    minimumDistance: numero.optional(),
    maximunDistance: numero.optional(),
    valuePerKm: numero.optional(),
    minimumDeliveryTimeInMinutes: inteiro.optional(),
    maximumDeliveryTimeInMinutes: inteiro.optional(),
    isConfigured: z.boolean().optional(),
    scheduleDays: z.number().int().min(0).max(60).optional(),
    scheduleIntervalType: z.enum(['hours', 'days']).optional(),
    intervalTimeBetweenSchedules: inteiro.optional(),
    maxSchedulesPerTime: inteiro.optional(),
    // "Pedido perto de fechar": allow, cut ou nextDay (lido pelo getAutoSchedule).
    afterClosingDelivery: z.enum(['allow', 'cut', 'nextDay']).optional(),
    weekDaysDelivery: z.array(diaDeEntregaSchema).length(7).optional(),
  }).strict().optional(),
  minimumPriceCart: numero.optional(),
  openingHours: z.array(z.object({
    weekday: z.number().int().min(1).max(7),
    isOpen: z.boolean(),
    openingHours: horario,
    closeHours: horario,
  })).length(7).optional(),
  scheduling: z.object({ contracted: z.boolean().optional(), enabled: z.boolean().optional() }).strict().optional(),
}).strict();
