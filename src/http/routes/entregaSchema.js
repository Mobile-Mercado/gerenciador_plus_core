import { z } from 'zod';
import { INSTRUCOES_MAXIMO, TEMPO_DE_PREPARO_MAXIMO_MIN } from '../../domain/loja/appDoCliente.js';

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
// Retirada na loja (contrato da versao 55, item 1): endereco, instrucoes, tempo de preparo e os
// horarios no formato de weekDaysDelivery (o frete das janelas e gravado null).
const textoDoEndereco = (maximo) => z.string().max(maximo).nullish();
const retiradaSchema = z.object({
  endereco: z.object({
    street: textoDoEndereco(200),
    number: textoDoEndereco(40),
    complement: textoDoEndereco(200),
    neighborhood: textoDoEndereco(120),
    city: textoDoEndereco(120),
    uf: textoDoEndereco(2),
    zipCode: textoDoEndereco(20),
    position: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).strict().nullish(),
  }).strict().nullable().optional(),
  instrucoes: z.string().max(INSTRUCOES_MAXIMO).nullable().optional(),
  tempoPreparoMin: z.number().int().min(0).max(TEMPO_DE_PREPARO_MAXIMO_MIN).optional(),
  horarios: z.array(diaDeEntregaSchema).length(7).nullable().optional(),
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
  retirada: retiradaSchema.optional(),
}).strict();
