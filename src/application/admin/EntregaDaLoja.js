import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { AppError } from '../../domain/errors/AppError.js';
import { horarioDoValor, millisDoHorario, minutosDoHorario } from '../../domain/loja/horariosDaLoja.js';

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

export class EntregaDaLoja {
  constructor({
    firestore,
    serverTimestamp = () => FieldValue.serverTimestamp(),
    paraTimestamp = (ms) => Timestamp.fromMillis(ms),
  }) {
    this.firestore = firestore;
    this.serverTimestamp = serverTimestamp;
    this.paraTimestamp = paraTimestamp;
  }

  lojaRef(lojaId) {
    return this.firestore.collection('estabelecimentos').doc(String(lojaId || ''));
  }

  async ler(lojaId) {
    const loja = await this.lojaRef(lojaId).get();
    if (!loja.exists) throw recusa('Loja não encontrada.', 'loja_nao_encontrada', 404);
    return paraATela(loja.id, loja.data() || {});
  }

  // `entrada`: { deliveryInfo?, minimumPriceCart?, openingHours?, scheduling? }, ja no formato
  // conferido pela rota. Devolve a entrega como ficou e o que havia antes nos campos mudados.
  async salvar(lojaId, entrada = {}) {
    const ref = this.lojaRef(lojaId);
    const resultado = await this.firestore.runTransaction(async (transacao) => {
      const loja = await transacao.get(ref);
      if (!loja.exists) throw recusa('Loja não encontrada.', 'loja_nao_encontrada', 404);
      const atual = loja.data() || {};
      const mudancas = {};
      const antes = {};

      if (entrada.deliveryInfo) {
        const existente = atual.deliveryInfo && typeof atual.deliveryInfo === 'object' ? atual.deliveryInfo : {};
        conferirPares(entrada.deliveryInfo, existente);
        Object.entries(entrada.deliveryInfo).forEach(([campo, valor]) => {
          mudancas[`deliveryInfo.${campo}`] = valor;
          antes[`deliveryInfo.${campo}`] = existente[campo] ?? null;
        });
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

      if (!Object.keys(mudancas).length) throw recusa('Nada para gravar.', 'entrega_sem_mudancas');
      transacao.update(ref, { ...mudancas, updatedAt: this.serverTimestamp() });
      return { antes, campos: Object.keys(mudancas) };
    });
    return { ...resultado, entrega: await this.ler(lojaId) };
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
}

// Entrega como a tela do Admin edita: deliveryInfo como esta gravado e os horarios em "HH:mm".
function paraATela(lojaId, data) {
  const atuais = Array.isArray(data.openingHours) ? data.openingHours : [];
  return {
    lojaId,
    deliveryInfo: data.deliveryInfo || null,
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
  };
}
