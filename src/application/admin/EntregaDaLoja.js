import { FieldValue, GeoPoint, Timestamp } from 'firebase-admin/firestore';
import { AppError } from '../../domain/errors/AppError.js';
import { TEMPO_DE_PREPARO_PADRAO_MIN, funcoesDoApp } from '../../domain/loja/appDoCliente.js';
import {
  DESLOCAMENTO_SAO_PAULO_MINUTOS, horarioDoValor, millisDoHorario, minutosDoHorario,
} from '../../domain/loja/horariosDaLoja.js';

// Entrega de qualquer loja pelo Admin (cola 23.2, 17/10/2026): deliveryInfo, minimumPriceCart,
// openingHours, scheduling.contracted e scheduling.enabled.
//
// deliveryInfo muda campo a campo (deliveryInfo.x), como o saveDeliverySettings do painel, que
// espalha o mapa existente e so troca os campos enviados: o mapa nunca e regravado inteiro (foi
// assim que a G&S perdeu o frete, dossie item 23). openingHours segue o saveOpeningHours do
// painel: cada dia guarda o que ja tinha e troca so isOpen, os horarios e open/close.
//
// "Pedido perto de fechar" e deliveryInfo.afterClosingDelivery, o campo que o getAutoSchedule
// publicado em 13/10/2026 le (mobile_old_web_platform, branch agendamento-horarios,
// functions/src/api/schedules/auto-schedule.ts): "allow" (entregar mesmo depois de fechar),
// "cut" (entregar so ate fechar) e "nextDay" (passar para o dia seguinte). Sem o campo, ou com
// valor desconhecido, vale "allow".
export const PEDIDO_PERTO_DE_FECHAR = Object.freeze({
  allow: 'Entregar mesmo depois de fechar',
  cut: 'Entregar só até fechar',
  nextDay: 'Passar para o dia seguinte',
});
export const DIAS_DA_SEMANA = Object.freeze([1, 2, 3, 4, 5, 6, 7]);

// Janelas proprias por dia (cola RP-3, 17/10/2026): deliveryInfo.weekDaysDelivery, os 7 dias, no
// formato que o getAvailablesSchedules le (mobile_old_web_platform, branch agendamento-horarios,
// functions/src/api/schedules/available-schedules.ts) e que os apps gravam e leem (mobile_core,
// weekday_delivery_adapter.dart e custom_interval_adapter.dart):
//   { weekday, canDelivery, initTime, endTime, interval, maxSchedulesPerTime, scheduleIntervalType,
//     customIntervals: [{ canDelivery, maxSchedulesPerTime, freight, init, end }] }
// Horarios em Timestamp com data ficticia; vale so hora e minuto em Sao Paulo (-3 h). Sem
// horario gravado para aproveitar, a data e 01/01/0001, como o app grava. O app le initTime,
// endTime, init e end como Timestamp obrigatorio, entao todo dia vai completo. O servidor de
// agendamento usa customIntervals quando o dia tem janelas; sem elas, os horarios da loja.
// A lista vai inteira numa gravacao so (deliveryInfo.weekDaysDelivery), nunca item a item.
// weekdaysDelivery (d minusculo) e o nome antigo, lido so quando falta o novo (como o app).
const INICIO_DO_ANO_1 = -62135596800000; // 0001-01-01T00:00:00Z

function recusa(mensagem, code, statusCode = 400) {
  return new AppError(mensagem, { statusCode, code });
}

// Prazo minimo menor que o maximo e distancia incluida ate a maxima. Quando so um dos dois vem,
// compara com o valor gravado; sem valor gravado do outro lado, nao ha o que comparar.
function conferirPares(enviado, gravado) {
  const valor = (campo) => {
    const numero = enviado[campo] !== undefined ? enviado[campo] : gravado[campo];
    return typeof numero === 'number' && Number.isFinite(numero) ? numero : null;
  };
  const tocou = (...campos) => campos.some((campo) => enviado[campo] !== undefined);
  if (tocou('minimumDeliveryTimeInMinutes', 'maximumDeliveryTimeInMinutes')) {
    const minimo = valor('minimumDeliveryTimeInMinutes');
    const maximo = valor('maximumDeliveryTimeInMinutes');
    if (minimo !== null && maximo !== null && minimo >= maximo) {
      throw recusa('O prazo mínimo precisa ser menor que o prazo máximo.', 'entrega_prazo_invalido');
    }
  }
  if (tocou('minimumDistance', 'maximunDistance')) {
    const incluida = valor('minimumDistance');
    // Loja antiga pode ter so o espelho com a grafia certa (maximumDistance).
    const maxima = valor('maximunDistance') ?? (enviado.maximunDistance === undefined ? valor('maximumDistance') : null);
    if (incluida !== null && maxima !== null && incluida > maxima) {
      throw recusa('A distância incluída não pode passar da distância máxima.', 'entrega_distancia_invalida');
    }
  }
}

function diaGravado(atuais, weekday, indice) {
  return atuais.find((item) => Number(item?.weekday) === weekday) || atuais[indice] || {};
}

function janelasGravadas(deliveryInfo) {
  const lista = deliveryInfo?.weekDaysDelivery ?? deliveryInfo?.weekdaysDelivery;
  return Array.isArray(lista) ? lista : [];
}

// Janelas por dia como a tela edita: horarios em "HH:mm". Sem lista gravada, null.
function janelasParaATela(deliveryInfo) {
  const gravadas = janelasGravadas(deliveryInfo);
  if (!gravadas.length) return null;
  return [...gravadas].sort((a, b) => Number(a?.weekday) - Number(b?.weekday)).map((dia) => ({
    weekday: Number(dia?.weekday) || null,
    canDelivery: dia?.canDelivery !== false,
    initTime: horarioDoValor(dia?.initTime),
    endTime: horarioDoValor(dia?.endTime),
    interval: Number.isFinite(dia?.interval) ? dia.interval : null,
    maxSchedulesPerTime: Number.isFinite(dia?.maxSchedulesPerTime) ? dia.maxSchedulesPerTime : null,
    scheduleIntervalType: dia?.scheduleIntervalType || 'hours',
    customIntervals: (Array.isArray(dia?.customIntervals) ? dia.customIntervals : []).map((janela) => ({
      init: horarioDoValor(janela?.init),
      end: horarioDoValor(janela?.end),
      freight: typeof janela?.freight === 'number' ? janela.freight : null,
      maxSchedulesPerTime: Number.isFinite(janela?.maxSchedulesPerTime) ? janela.maxSchedulesPerTime : null,
      canDelivery: janela?.canDelivery !== false,
    })),
  }));
}

export class EntregaDaLoja {
  constructor({
    firestore,
    serverTimestamp = () => FieldValue.serverTimestamp(),
    paraTimestamp = (ms) => Timestamp.fromMillis(ms),
    paraGeoPoint = (latitude, longitude) => new GeoPoint(latitude, longitude),
  }) {
    this.firestore = firestore;
    this.serverTimestamp = serverTimestamp;
    this.paraTimestamp = paraTimestamp;
    this.paraGeoPoint = paraGeoPoint;
  }

  lojaRef(lojaId) {
    return this.firestore.collection('estabelecimentos').doc(String(lojaId || ''));
  }

  async ler(lojaId) {
    const loja = await this.lojaRef(lojaId).get();
    if (!loja.exists) throw recusa('Loja não encontrada.', 'loja_nao_encontrada', 404);
    return paraATela(loja.id, loja.data() || {});
  }

  // `entrada`: { deliveryInfo?, minimumPriceCart?, openingHours?, scheduling?, retirada? }, ja no formato
  // conferido pela rota. Devolve a entrega como ficou e o que havia antes nos campos mudados.
  // `contratoSoDoAdmin`: a propria loja grava (PATCH /api/loja/entrega, cola RP-7); "Contratado"
  // so muda pelo Admin, e o mesmo valor gravado passa sem gravar nada.
  async salvar(lojaId, recebida = {}, { contratoSoDoAdmin = false } = {}) {
    const ref = this.lojaRef(lojaId);
    const resultado = await this.firestore.runTransaction(async (transacao) => {
      const loja = await transacao.get(ref);
      if (!loja.exists) throw recusa('Loja não encontrada.', 'loja_nao_encontrada', 404);
      const atual = loja.data() || {};
      let entrada = recebida;
      if (contratoSoDoAdmin && recebida.scheduling?.contracted !== undefined) {
        if (recebida.scheduling.contracted !== (atual.scheduling?.contracted === true)) {
          throw recusa('Só o Admin muda o agendamento contratado.', 'agendamento_contrato_so_admin', 403);
        }
        const { contracted: _mesmoValor, ...scheduling } = recebida.scheduling;
        entrada = { ...recebida, scheduling: Object.keys(scheduling).length ? scheduling : undefined };
      }
      const mudancas = {};
      const antes = {};

      if (entrada.deliveryInfo) {
        const existente = atual.deliveryInfo && typeof atual.deliveryInfo === 'object' ? atual.deliveryInfo : {};
        conferirPares(entrada.deliveryInfo, existente);
        const { weekDaysDelivery, ...campos } = entrada.deliveryInfo;
        Object.entries(campos).forEach(([campo, valor]) => {
          mudancas[`deliveryInfo.${campo}`] = valor;
          antes[`deliveryInfo.${campo}`] = existente[campo] ?? null;
        });
        if (weekDaysDelivery) {
          mudancas['deliveryInfo.weekDaysDelivery'] = this.janelasParaGravar(weekDaysDelivery, janelasGravadas(existente));
          antes['deliveryInfo.weekDaysDelivery'] = janelasParaATela(existente);
        }
        // Espelhos que o painel mantem quando o mapa ja os tem.
        if (entrada.deliveryInfo.deliveryCalcType && Object.hasOwn(existente, 'deliveryType')) {
          mudancas['deliveryInfo.deliveryType'] = entrada.deliveryInfo.deliveryCalcType === 'DeliveryCalcType.fixedValue' ? 'fixed' : 'distance';
          antes['deliveryInfo.deliveryType'] = existente.deliveryType ?? null;
        }
        if (entrada.deliveryInfo.maximunDistance !== undefined && Object.hasOwn(existente, 'maximumDistance')) {
          mudancas['deliveryInfo.maximumDistance'] = entrada.deliveryInfo.maximunDistance;
          antes['deliveryInfo.maximumDistance'] = existente.maximumDistance ?? null;
        }
      }

      if (entrada.minimumPriceCart !== undefined) {
        mudancas.minimumPriceCart = entrada.minimumPriceCart;
        antes.minimumPriceCart = atual.minimumPriceCart ?? null;
      }

      if (entrada.openingHours) {
        mudancas.openingHours = this.horariosParaGravar(entrada.openingHours, atual.openingHours);
        antes.openingHours = paraATela(loja.id, atual).openingHours;
      }

      if (entrada.scheduling) {
        const contratado = entrada.scheduling.contracted ?? atual.scheduling?.contracted === true;
        const ligadoAntes = atual.scheduling?.enabled === true;
        if (entrada.scheduling.enabled === true && !contratado) {
          throw recusa('O agendamento não está contratado para esta loja.', 'agendamento_nao_contratado', 409);
        }
        // Tirar o contrato desliga tambem o agendamento da loja (mesma regra do Admin).
        const ligado = contratado ? (entrada.scheduling.enabled ?? ligadoAntes) : false;
        if (entrada.scheduling.contracted !== undefined) {
          mudancas['scheduling.contracted'] = contratado;
          antes['scheduling.contracted'] = atual.scheduling?.contracted ?? null;
        }
        if (entrada.scheduling.enabled !== undefined || ligado !== ligadoAntes) {
          mudancas['scheduling.enabled'] = ligado;
          antes['scheduling.enabled'] = atual.scheduling?.enabled ?? null;
        }
      }

      if (entrada.retirada) this.retiradaParaGravar(entrada.retirada, atual.retirada, mudancas, antes);

      if (!Object.keys(mudancas).length) throw recusa('Nada para gravar.', 'entrega_sem_mudancas');
      transacao.update(ref, { ...mudancas, updatedAt: this.serverTimestamp() });
      return { antes, campos: Object.keys(mudancas) };
    });
    return { ...resultado, entrega: await this.ler(lojaId) };
  }

  // Retirada na loja (contrato da versao 55, item 1; cola RP-13): retirada.endereco (null = o
  // endereco da loja), retirada.instrucoes, retirada.tempoPreparoMin e retirada.horarios, no mesmo
  // formato e com as mesmas regras de weekDaysDelivery (frete sempre null; null = os horarios da
  // loja). Cada campo e gravado sozinho. Ligar a retirada (featureFlags.retirada) e so do Admin, em
  // AppDoClienteDaLoja.
  retiradaParaGravar(retirada, gravada, mudancas, antes) {
    const atual = gravada && typeof gravada === 'object' ? gravada : {};
    const anterior = paraATela('', { retirada: atual }).retirada;
    if (retirada.endereco !== undefined) {
      mudancas['retirada.endereco'] = retirada.endereco === null ? null : enderecoParaGravar(retirada.endereco, this.paraGeoPoint);
      antes['retirada.endereco'] = anterior.endereco;
    }
    if (retirada.instrucoes !== undefined) {
      const texto = String(retirada.instrucoes ?? '').replace(/\s+/g, ' ').trim();
      mudancas['retirada.instrucoes'] = texto || null;
      antes['retirada.instrucoes'] = anterior.instrucoes;
    }
    if (retirada.tempoPreparoMin !== undefined) {
      mudancas['retirada.tempoPreparoMin'] = retirada.tempoPreparoMin;
      antes['retirada.tempoPreparoMin'] = anterior.tempoPreparoMin;
    }
    if (retirada.horarios !== undefined) {
      mudancas['retirada.horarios'] = retirada.horarios === null ? FieldValue.delete() : this.janelasParaGravar(
        retirada.horarios.map((dia) => ({ ...dia, customIntervals: dia.customIntervals.map((janela) => ({ ...janela, freight: null })) })),
        Array.isArray(atual.horarios) ? atual.horarios : [],
      );
      antes['retirada.horarios'] = anterior.horarios;
    }
  }

  // Os 7 dias, como o saveOpeningHours do painel: o dia gravado fica, e so mudam isOpen,
  // openingHours/closeHours (Timestamp com a data ficticia) e open/close { hours, minutes }.
  horariosParaGravar(dias, gravados) {
    const atuais = Array.isArray(gravados) ? gravados : [];
    const porDia = new Map(dias.map((dia) => [dia.weekday, dia]));
    if (porDia.size !== 7 || !DIAS_DA_SEMANA.every((weekday) => porDia.has(weekday))) {
      throw recusa('Envie os 7 dias da semana, de segunda (1) a domingo (7).', 'entrega_horarios_incompletos');
    }
    return DIAS_DA_SEMANA.map((weekday, indice) => {
      const dia = porDia.get(weekday);
      const abre = minutosDoHorario(dia.openingHours);
      const fecha = minutosDoHorario(dia.closeHours);
      if (abre === null || fecha === null) throw recusa('Informe os horários no formato HH:mm.', 'entrega_horario_invalido');
      if (dia.isOpen && abre >= fecha) {
        throw recusa('O fechamento precisa ocorrer depois da abertura.', 'entrega_horario_invalido');
      }
      const gravado = diaGravado(atuais, weekday, indice);
      const instante = (horario, original) => {
        const millis = millisDoHorario(horario, original, weekday);
        if (typeof original?.toMillis === 'function' && original.toMillis() === millis) return original;
        return this.paraTimestamp(millis);
      };
      return {
        ...gravado,
        weekday,
        isOpen: Boolean(dia.isOpen),
        openingHours: instante(dia.openingHours, gravado.openingHours),
        closeHours: instante(dia.closeHours, gravado.closeHours),
        open: { hours: Math.floor(abre / 60), minutes: abre % 60 },
        close: { hours: Math.floor(fecha / 60), minutes: fecha % 60 },
      };
    });
  }

  // Os 7 dias de weekDaysDelivery, completos. Campo do dia que a tela nao conhece fica como esta
  // gravado; as janelas do dia sao as enviadas, na ordem do horario.
  janelasParaGravar(dias, gravados) {
    const porDia = new Map(dias.map((dia) => [dia.weekday, dia]));
    if (porDia.size !== 7 || !DIAS_DA_SEMANA.every((weekday) => porDia.has(weekday))) {
      throw recusa('Envie os 7 dias da semana, de segunda (1) a domingo (7).', 'entrega_janelas_incompletas');
    }
    const instante = (horario, original) => {
      const alvo = minutosDoHorario(horario);
      if (alvo === null) throw recusa('Informe os horários no formato HH:mm.', 'entrega_janela_invalida');
      if (minutosDoHorario(original) === alvo) return original;
      const millis = minutosDoHorario(original) === null
        ? INICIO_DO_ANO_1 + (alvo - DESLOCAMENTO_SAO_PAULO_MINUTOS) * 60000
        : millisDoHorario(horario, original);
      return this.paraTimestamp(millis);
    };
    return DIAS_DA_SEMANA.map((weekday, indice) => {
      const dia = porDia.get(weekday);
      const gravado = diaGravado(gravados, weekday, indice);
      const inicio = minutosDoHorario(dia.initTime);
      const fim = minutosDoHorario(dia.endTime);
      if (inicio === null || fim === null || (dia.canDelivery && inicio >= fim)) {
        throw recusa('O fim da entrega do dia precisa ser depois do início.', 'entrega_janela_invalida');
      }
      const janelasGravadasDoDia = Array.isArray(gravado.customIntervals) ? gravado.customIntervals : [];
      const janelas = [...dia.customIntervals]
        .sort((a, b) => minutosDoHorario(a.init) - minutosDoHorario(b.init))
        .map((janela, posicao) => {
          const comeca = minutosDoHorario(janela.init);
          const termina = minutosDoHorario(janela.end);
          if (comeca === null || termina === null || comeca >= termina) {
            throw recusa('Cada janela precisa terminar depois de começar.', 'entrega_janela_invalida');
          }
          const original = janelasGravadasDoDia[posicao] || {};
          return {
            canDelivery: janela.canDelivery,
            maxSchedulesPerTime: janela.maxSchedulesPerTime,
            freight: janela.freight ?? null,
            init: instante(janela.init, original.init),
            end: instante(janela.end, original.end),
          };
        });
      // Janelas que entregam nao podem se cruzar no mesmo dia (a vaga de uma invadiria a outra).
      const ativas = janelas.filter((janela) => janela.canDelivery);
      ativas.slice(1).forEach((janela, posicao) => {
        if (minutosDoHorario(janela.init) < minutosDoHorario(ativas[posicao].end)) {
          throw recusa('As janelas do mesmo dia não podem se sobrepor.', 'entrega_janelas_sobrepostas');
        }
      });
      return {
        ...gravado,
        weekday,
        canDelivery: dia.canDelivery,
        initTime: instante(dia.initTime, gravado.initTime),
        endTime: instante(dia.endTime, gravado.endTime),
        interval: dia.interval,
        maxSchedulesPerTime: dia.maxSchedulesPerTime,
        scheduleIntervalType: dia.scheduleIntervalType || gravado.scheduleIntervalType || 'hours',
        customIntervals: janelas,
      };
    });
  }
}

// Entrega como a tela do Admin edita: deliveryInfo como esta gravado, com weekDaysDelivery e os
// horarios da loja em "HH:mm".
function paraATela(lojaId, data) {
  const atuais = Array.isArray(data.openingHours) ? data.openingHours : [];
  let deliveryInfo = null;
  if (data.deliveryInfo) {
    const { weekdaysDelivery: _nomeAntigo, ...resto } = data.deliveryInfo;
    deliveryInfo = { ...resto, weekDaysDelivery: janelasParaATela(data.deliveryInfo) };
  }
  return {
    lojaId,
    deliveryInfo,
    minimumPriceCart: data.minimumPriceCart ?? null,
    openingHours: DIAS_DA_SEMANA.map((weekday, indice) => {
      const gravado = diaGravado(atuais, weekday, indice);
      return {
        weekday,
        isOpen: gravado.isOpen === true,
        openingHours: horarioDoValor(gravado.openingHours ?? gravado.open),
        closeHours: horarioDoValor(gravado.closeHours ?? gravado.close),
      };
    }),
    scheduling: { contracted: data.scheduling?.contracted === true, enabled: data.scheduling?.enabled === true },
    // Como o getAutoSchedule le: ausente ou desconhecido vale "allow".
    pedidoPertoDeFechar: Object.hasOwn(PEDIDO_PERTO_DE_FECHAR, data.deliveryInfo?.afterClosingDelivery)
      ? data.deliveryInfo.afterClosingDelivery
      : 'allow',
    retirada: retiradaParaATela(data),
  };
}

// Retirada como a tela edita. `ligada` (featureFlags.retirada) so para mostrar: muda pelo Admin.
function retiradaParaATela(data) {
  const retirada = data.retirada && typeof data.retirada === 'object' ? data.retirada : {};
  const endereco = retirada.endereco && typeof retirada.endereco === 'object' ? retirada.endereco : null;
  return {
    ligada: funcoesDoApp(data.featureFlags).retirada,
    endereco: endereco ? enderecoParaATela(endereco) : null,
    instrucoes: typeof retirada.instrucoes === 'string' && retirada.instrucoes ? retirada.instrucoes : null,
    tempoPreparoMin: Number.isInteger(retirada.tempoPreparoMin) ? retirada.tempoPreparoMin : TEMPO_DE_PREPARO_PADRAO_MIN,
    horarios: janelasParaATela({ weekDaysDelivery: retirada.horarios }),
  };
}

const CAMPOS_DO_ENDERECO = Object.freeze(['street', 'number', 'complement', 'neighborhood', 'city', 'uf', 'zipCode']);

function enderecoParaATela(endereco) {
  const posicao = endereco.position;
  const latitude = posicao?.latitude ?? posicao?._latitude;
  const longitude = posicao?.longitude ?? posicao?._longitude;
  return {
    ...Object.fromEntries(CAMPOS_DO_ENDERECO.map((campo) => [campo, typeof endereco[campo] === 'string' && endereco[campo] ? endereco[campo] : null])),
    position: Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null,
  };
}

// Endereco de retirada no formato do address da loja: textos limpos e position em GeoPoint.
function enderecoParaGravar(endereco, paraGeoPoint) {
  const limpo = Object.fromEntries(CAMPOS_DO_ENDERECO.map((campo) => {
    const valor = String(endereco[campo] ?? '').replace(/\s+/g, ' ').trim();
    return [campo, valor || null];
  }));
  if (limpo.uf) limpo.uf = limpo.uf.toUpperCase();
  if (!limpo.street || !limpo.city || !limpo.uf) {
    throw recusa('Informe rua, cidade e estado do endereço de retirada.', 'retirada_endereco_incompleto');
  }
  const posicao = endereco.position;
  return { ...limpo, position: posicao ? paraGeoPoint(posicao.latitude, posicao.longitude) : null };
}
