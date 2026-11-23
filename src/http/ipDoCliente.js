// Atras do Cloud Run (App Hosting), o IP do cliente vem no primeiro salto do X-Forwarded-For
// (mesma leitura de cadastroRoutes.js e deliveryRoutes.js).
export function ipDoCliente(request) {
  const encaminhado = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return encaminhado || request.ip || null;
}
