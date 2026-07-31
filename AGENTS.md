# Instrucoes do backend

## Contexto

Este backend pertence ao projeto `web_gerenciador_plus`, o painel do lojista do ecossistema Mobile Mercado. Ele deve concentrar chamadas de IA e qualquer logica sensivel que nao pode ficar no frontend.

Os provedores de IA disponiveis sao OpenAI e Groq, selecionados por `AI_PROVIDER`. As chaves devem existir apenas no ambiente do backend (`OPENAI_API_KEY` ou `GROQ_API_KEY`), nunca em React, Vite, HTML, service worker, arquivos publicos ou documentacao com valor real.

Hospedagem inicial prevista: Firebase App Hosting, usando o `backend/apphosting.yaml`.

## Comandos

```powershell
cd C:\Users\lucas\Desktop\mobile_mercado\web_gerenciador_plus\backend
npm install
npm run dev
npm run check
```

## Arquitetura

- `src/server.js`: ponto de entrada HTTP.
- `src/app.js`: composicao do Express, middlewares e rotas.
- `src/config/env.js`: leitura e normalizacao de variaveis de ambiente.
- `src/http/routes`: rotas HTTP.
- `src/http/middlewares`: erros, auth, logs e utilitarios HTTP.
- `src/application`: casos de uso. Deve conter regra de aplicacao, sem depender de Express ou OpenAI diretamente.
- `src/domain`: contratos e erros de dominio.
- `src/infra`: adaptadores externos, como OpenAI, Groq, Firebase Admin e logger.

## Regras SOLID

- Rotas HTTP apenas traduzem request/response. Nao colocar regra de negocio nelas.
- Casos de uso devem depender de contratos, nao de SDKs externos.
- OpenAI, Groq, Firebase e outros provedores entram por adaptadores em `infra`.
- Ao adicionar um novo provedor de IA, crie outro adapter que respeite o contrato `AiGateway`.
- Ao adicionar novos dados do Firestore, leia `../DATABASE.md` antes e nao invente caminhos.
- Nao duplicar validacoes: se uma regra for compartilhada, mova para application/domain.

## Seguranca

- Nunca commitar `.env`.
- Nao logar prompts com dados sensiveis de clientes, tokens, chaves ou respostas completas dos provedores de IA.
- Em producao, manter `REQUIRE_FIREBASE_AUTH=true`.
- Rotas de IA devem aceitar token Firebase do usuario logado antes de consumir cota ou credito do provedor.
- Erros enviados ao frontend devem ser claros, mas sem detalhes internos nem chaves.
- O adapter OpenAI usa ate 8 retries para falhas transitorias. O adapter Groq usa 2 para evitar insistencia excessiva ao atingir a cota gratuita.

## Rotas atuais

- `GET /health`: healthcheck publico.
- `POST /api/ai/responder`: resposta textual para o gerenciador.
- `POST /api/ai/insights`: resposta orientada a dados/JSON para dashboards, analises e explicacoes.
- `POST /api/ai/home-overview`: resumo/insight automatico da Home, limitado a uma geracao diaria por estabelecimento e persistido em `estabelecimentos/{id}/AiDailyInsights/{aaaa-mm-dd}`.
- `POST /api/implantacao/importar-produtos`: recebe CSV em texto, importa produtos/categorias/subcategorias via Firebase Admin e responde em NDJSON com progresso real para a tela Implantacao.
- `/api/implantacao/admin/pipelines`: lista pipelines e aprova verificacoes manuais. Exige token Firebase e UID presente em `IMPLANTATION_ADMIN_UIDS`.
- `GET /api/notifications/web/status/{establishmentId}`: informa se a loja possui navegadores ativos para Web Push.
- `POST /api/notifications/web/test`: envia uma notificacao de teste apenas para a loja vinculada ao usuario autenticado.

## Notificacoes web

- O backend envia Web Push pelo Firebase Admin Messaging; nenhuma credencial FCM fica no frontend.
- Enviar Web Push como mensagem de dados. O Service Worker do frontend e o unico responsavel por montar a notificacao em segundo plano, evitando exibicao duplicada pelo SDK.
- Tokens sao lidos de `FcmTokens`, usando `clientId == establishmentId` e no maximo 100 dispositivos por loja.
- Tokens invalidos sao marcados com `active: false`; nunca registrar o valor do token em logs.
- As rotas de notificacao sempre exigem Firebase Auth, mesmo quando `REQUIRE_FIREBASE_AUTH=false` em desenvolvimento.
- O usuario so pode consultar ou testar notificacoes do estabelecimento associado ao seu documento em `Users`.
- Aprovacoes dos passos 06 e 07 da implantacao enviam um aviso para `/implantacao`. Falhas no Push nao desfazem a aprovacao.

## Implantacao

- A importacao de produtos da tela Implantacao roda no backend, nao no React.
- Caso de uso: `src/application/implantacao/ImportProductsFromCsvUseCase.js`.
- O frontend apenas envia o CSV, acompanha progresso e atualiza os cards.
- Manter o mesmo contrato de Firestore documentado em `../DATABASE.md`: `estabelecimentos/{id}/Products`, `ProductCategories`, `ProductSubcategories` e a colecao global `produtos`.
- Nao expor log completo de CSV, dados de cliente ou tokens.

## Insight diario da Home

- O cache fica em `estabelecimentos/{id}/AiDailyInsights/{aaaa-mm-dd}` e usa o fuso `America/Sao_Paulo`.
- O documento guarda apenas a resposta final, provedor/modelo e timestamps; nunca persistir contexto bruto, UID ou dados de clientes.
- A aquisicao usa uma trava temporaria no Firestore para impedir duas chamadas de IA simultaneas para a mesma loja e dia.
- A rota sempre valida que o UID Firebase pertence ao estabelecimento antes de ler ou gerar o insight.

## Variaveis

- `AI_PROVIDER`: `openai` ou `groq`. Padrao: `openai`.
- `OPENAI_API_KEY`: secret usada quando `AI_PROVIDER=openai`.
- `OPENAI_MODEL`: modelo usado pelo adapter OpenAI. Padrao: `gpt-4.1-mini`.
- `OPENAI_TEMPERATURE`: criatividade da resposta. Padrao: `0.2`.
- `GROQ_API_KEY`: secret usada quando `AI_PROVIDER=groq`.
- `GROQ_MODEL`: modelo usado pelo adapter Groq. Padrao: `qwen/qwen3.6-27b`, com texto, imagem e JSON.
- `GROQ_TEMPERATURE`: criatividade da resposta Groq. Padrao: `0.2`.
- `CORS_ORIGINS`: origens liberadas separadas por virgula.
- `REQUIRE_FIREBASE_AUTH`: `true` em producao.
- `REQUEST_BODY_LIMIT`: limite do corpo JSON.
- `IMPLANTATION_ADMIN_UIDS`: UIDs Firebase autorizados no painel interno, separados por virgula.

## Contexto com outros projetos

Este backend atende o `web_gerenciador_plus`. Quando uma funcionalidade de IA depender de dados gerados no app do cliente ou no agente, verificar tambem os projetos vizinhos:

- `..\agente_mobile_mercado`
- `..\web_gerenciador`
- `..\mobile_gerenciador`
- `..\mobile_cliente`

Se uma funcionalidade criar nova colecao/campo no Firestore, atualizar `../DATABASE.md` e registrar o impacto no projeto que captura ou consome esse dado.

## Fronteira definitiva de dados

- Este repositorio concentra IA, Firebase Admin, Firestore, Web Push e Cloud Functions do gerenciador.
- O frontend usa Firebase no navegador somente para Auth, Messaging, Service Worker e uploads iniciados pelo usuario no Storage.
- `GET /api/session` resolve a conta e o estabelecimento a partir do UID autenticado.
- `/api/data/document`, `/api/data/query`, `/api/data/count`, `/api/data/mutate` e `/api/data/stream` formam o BFF de dados usado pelo React.
- O BFF nunca pode aceitar acesso Firestore arbitrario. Toda nova colecao raiz deve ser explicitamente autorizada em `ManagerDataAccessPolicy.js` e coberta por teste.
- Caminhos sob `estabelecimentos/{id}` so aceitam o `id` da conta autenticada. Pedidos, chats, clientes e conversas do agente possuem verificacao adicional de posse.
- Perfis em `Users` sao limitados aos clientes derivados dos pedidos da loja; campos internos como `userAuthId` nao saem pela API.
- Streams usam NDJSON e Firebase Admin `onSnapshot`; o cliente reconecta quando o App Hosting encerra uma conexao longa.
- Tokens FCM sao registrados por `POST /api/notifications/web/register`; o documento usa hash SHA-256 como ID e guarda o token somente no campo `token`.
- `functions/sendOrderNotification` envia novos pedidos mesmo com o painel fechado. `functions/aggregateOrderHourlySales` mantem agregacoes horarias.
- `firebase deploy --only functions` publica somente os gatilhos. Nao publicar regras/indices sem autorizacao explicita.
