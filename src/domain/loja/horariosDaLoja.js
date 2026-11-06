// Horarios de openingHours, na mesma regra da tela de Configuracoes do painel (copia de
// web_gerenciador_plus/src/features/shell/statusDaLoja.js e settings/settingsUtils.js, 17/10/2026):
// so hora e minuto valem, em America/Sao_Paulo com deslocamento fixo de 3 horas; a data dos
// Timestamps gravados e ficticia (0001, 1969, 1970, 2000) e fica como esta. Mudou la, muda aqui.
export const DESLOCAMENTO_SAO_PAULO_MINUTOS = -3 * 60;

export function minutosDoHorario(valor) {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === 'object' && typeof valor.hours === 'number' && typeof valor.minutes === 'number') {
    if (valor.hours < 0 || valor.hours > 23 || valor.minutes < 0 || valor.minutes > 59) return null;
    return valor.hours * 60 + valor.minutes;
  }
  if (typeof valor === 'string') {
    const partes = valor.match(/^(\d{1,2}):(\d{2})$/);
    if (!partes) return null;
    const horas = Number(partes[1]);
    const minutos = Number(partes[2]);
    if (horas > 23 || minutos > 59) return null;
    return horas * 60 + minutos;
  }
  const ms = millisDe(valor);
  if (ms === null || !Number.isFinite(ms)) return null;
  const deslocado = new Date(ms + DESLOCAMENTO_SAO_PAULO_MINUTOS * 60000);
  return deslocado.getUTCHours() * 60 + deslocado.getUTCMinutes();
}

function millisDe(valor) {
  if (!valor) return null;
  if (typeof valor.toMillis === 'function') return valor.toMillis();
  if (typeof valor.toDate === 'function') return valor.toDate().getTime();
  if (valor instanceof Date) return valor.getTime();
  if (typeof valor.seconds === 'number') return valor.seconds * 1000;
  return null;
}

export function horarioDoValor(valor) {
  const minutos = minutosDoHorario(valor);
  if (minutos === null) return null;
  return `${String(Math.floor(minutos / 60)).padStart(2, '0')}:${String(minutos % 60).padStart(2, '0')}`;
}

// Instante a gravar para "HH:mm". Com o Timestamp que ja estava gravado, so desloca a diferenca
// de minutos (horario que nao mudou devolve o mesmo instante); sem ele, 2 de janeiro de 2000 mais
// o dia da semana, como o painel.
export function millisDoHorario(horario, original, weekday) {
  const alvo = minutosDoHorario(String(horario ?? ''));
  if (alvo === null) return null;
  const instante = millisDe(original);
  const atual = minutosDoHorario(original);
  if (instante !== null && atual !== null) return instante + (alvo - atual) * 60000;
  return Date.UTC(2000, 0, 2 + Number(weekday || 1)) + (alvo - DESLOCAMENTO_SAO_PAULO_MINUTOS) * 60000;
}
