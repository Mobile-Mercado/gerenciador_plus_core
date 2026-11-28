// Item 5.10 "Acessos conectados": navegador e sistema mostrados no Admin, lidos do User-Agent que o
// proprio navegador manda (o Core nao confia em nome de navegador vindo no corpo). O Windows 10 e o 11
// mandam o mesmo "Windows NT 10.0"; a versao do sistema vem da dica do navegador
// (navigator.userAgentData, platformVersion), quando ele manda: 13 ou mais e Windows 11.
// "Chrome anonimo" fica de fora: nao ha deteccao confiavel (decisao do plano), sai so "Chrome".

const NAVEGADORES = [
  ['Edge', /\bEdg(?:e|A|iOS)?\//],
  ['Opera', /\bOPR\/|\bOpera\b/],
  ['Samsung Internet', /\bSamsungBrowser\//],
  ['Firefox', /\bFirefox\/|\bFxiOS\//],
  ['Chrome', /\bChrome\/|\bCriOS\//],
  ['Safari', /\bSafari\//],
];

export function navegadorDoAgente(userAgent) {
  const agente = String(userAgent || '');
  const achado = NAVEGADORES.find(([, padrao]) => padrao.test(agente));
  return achado ? achado[0] : 'Navegador';
}

export function sistemaDoAgente(userAgent, versaoDoSistema = null) {
  const agente = String(userAgent || '');
  if (/\biPhone\b/.test(agente)) return 'iPhone';
  if (/\biPad\b/.test(agente)) return 'iPad';
  if (/\bAndroid\b/.test(agente)) return 'Android';
  if (/\bCrOS\b/.test(agente)) return 'ChromeOS';
  if (/\bWindows NT 10\.0\b/.test(agente)) {
    const maior = Number.parseInt(String(versaoDoSistema ?? '').split('.')[0], 10);
    if (Number.isFinite(maior)) return maior >= 13 ? 'Windows 11' : 'Windows 10';
    return 'Windows';
  }
  if (/\bWindows\b/.test(agente)) return 'Windows';
  if (/\bMac OS X\b|\bMacintosh\b/.test(agente)) return 'macOS';
  if (/\bLinux\b/.test(agente)) return 'Linux';
  return 'Sistema desconhecido';
}

// Cola B57-18l, item 2: nome automatico do navegador, "{sistema} · {navegador}" ("Windows 11 · Chrome").
// Sistema desconhecido: so o navegador. Calculado na leitura; o documento guarda so o nome dado.
export function nomeAutomatico({ navegador, sistema } = {}) {
  const partes = [sistema === 'Sistema desconhecido' ? null : sistema, navegador || 'Navegador'];
  return partes.filter(Boolean).join(' · ');
}
