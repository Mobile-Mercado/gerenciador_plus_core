import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { AppError } from '../../domain/errors/AppError.js';
import instalacoesApp from '../../../functions/instalacoesApp.js';

// Fontes do botao "Atualizar agora" (tela Instalacoes do Admin): o bucket de relatorios da Google
// Play e a chave de leitura da Apple, como na rotina instalacoesAppNightly. A rotina roda como a conta
// relatorios-lojas; aqui o Core pede um token dessa conta (IAM Credentials) com a credencial dele, o
// que exige o papel "Criador de token da conta de servico" para a conta do Core na relatorios-lojas.
// Sem conta configurada (local), usa a credencial padrao.
const { leitorDaApple } = instalacoesApp;
const ESCOPO = 'https://www.googleapis.com/auth/cloud-platform';
const NOME_DO_APP = 'relatorios-lojas';

async function tokenDaConta({ contaDeServico, credencial, buscar }) {
  const origem = await credencial.getAccessToken();
  if (!contaDeServico) return origem;
  const resposta = await buscar(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(contaDeServico)}:generateAccessToken`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${origem.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: [ESCOPO], lifetime: '1800s' }),
    },
  );
  if (!resposta.ok) {
    throw new AppError(`O Core não conseguiu agir como ${contaDeServico} (${resposta.status}).`, { statusCode: 503, code: 'instalacoes_sem_acesso' });
  }
  const { accessToken, expireTime } = await resposta.json();
  return { access_token: accessToken, expires_in: Math.max(60, Math.floor((Date.parse(expireTime) - Date.now()) / 1000)) };
}

export function criarFontesDeInstalacoes({
  projeto, contaDeServico, bucket, segredo, issuerId, keyId, credencial = null, fetch: buscar = fetch,
}) {
  return async () => {
    if (!bucket || !issuerId || !keyId || !segredo) {
      throw new AppError('Faltam no Core os parâmetros dos relatórios das lojas de apps.', { statusCode: 503, code: 'instalacoes_sem_configuracao' });
    }
    const origem = credencial || applicationDefault();
    const pegarToken = () => tokenDaConta({ contaDeServico, credencial: origem, buscar });
    const token = await pegarToken();
    const resposta = await buscar(`https://secretmanager.googleapis.com/v1/projects/${projeto}/secrets/${segredo}/versions/latest:access`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!resposta.ok) {
      throw new AppError(`Não foi possível ler o segredo ${segredo} (${resposta.status}).`, { statusCode: 503, code: 'instalacoes_sem_segredo' });
    }
    const { payload } = await resposta.json();
    const chaveP8 = Buffer.from(payload?.data || '', 'base64').toString('utf8');
    const app = getApps().find((item) => item.name === NOME_DO_APP)
      || initializeApp({ credential: { getAccessToken: pegarToken }, projectId: projeto }, NOME_DO_APP);
    return { bucket: getStorage(app).bucket(bucket), apple: leitorDaApple({ chaveP8, issuerId, keyId, fetch: buscar }) };
  };
}
