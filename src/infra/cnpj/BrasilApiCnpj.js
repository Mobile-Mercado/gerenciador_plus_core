// Consulta do CNPJ na BrasilAPI (dados publicos da Receita). Tres respostas possiveis:
// { encontrado: true, ativa, razaoSocial, endereco }, { encontrado: false } quando a Receita
// nao conhece o numero, ou null quando a consulta falhou (rede, prazo, servico fora). Quem chama
// decide: falha segue o cadastro com cnpjConferido false.
const PRAZO_MS = 6000;

export class BrasilApiCnpj {
  constructor({ fetchImpl = globalThis.fetch, baseUrl = 'https://brasilapi.com.br/api/cnpj/v1', prazoMs = PRAZO_MS } = {}) {
    this.fetch = fetchImpl;
    this.baseUrl = baseUrl;
    this.prazoMs = prazoMs;
  }

  async consultar(cnpj) {
    const controle = new AbortController();
    const relogio = setTimeout(() => controle.abort(), this.prazoMs);
    try {
      const resposta = await this.fetch(`${this.baseUrl}/${cnpj}`, {
        signal: controle.signal,
        headers: { Accept: 'application/json' },
      });
      if (resposta.status === 404) return { encontrado: false };
      if (!resposta.ok) return null;
      return lerEmpresa(await resposta.json());
    } catch {
      return null;
    } finally {
      clearTimeout(relogio);
    }
  }
}

export function lerEmpresa(dados = {}) {
  const situacao = String(dados.descricao_situacao_cadastral || '').trim().toUpperCase();
  const logradouro = [dados.descricao_tipo_de_logradouro, dados.logradouro].filter(Boolean).join(' ').trim();
  return {
    encontrado: true,
    ativa: situacao === 'ATIVA' || Number(dados.situacao_cadastral) === 2,
    situacao: situacao || null,
    razaoSocial: String(dados.razao_social || '').trim() || null,
    endereco: {
      street: logradouro || null,
      number: String(dados.numero || '').trim() || null,
      complement: String(dados.complemento || '').trim() || null,
      neighborhood: String(dados.bairro || '').trim() || null,
      city: String(dados.municipio || '').trim() || null,
      uf: String(dados.uf || '').trim().toUpperCase() || null,
      zipCode: String(dados.cep || '').replace(/\D/g, '') || null,
    },
  };
}
