# Instrucoes do backend

## Contexto

Este backend pertence ao projeto `web_gerenciador_plus`, o painel do lojista do ecossistema Mobile Mercado. Ele deve concentrar chamadas de IA e qualquer logica sensivel que nao pode ficar no frontend.

O primeiro provedor de IA e a API da OpenAI. A chave deve existir apenas no ambiente do backend (`OPENAI_API_KEY`), nunca em React, Vite, HTML, service worker, arquivos publicos ou documentacao com valor real.

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
- `src/infra`: adaptadores externos, como OpenAI, Firebase Admin e logger.

## Regras SOLID

- Rotas HTTP apenas traduzem request/response. Nao colocar regra de negocio nelas.
- Casos de uso devem depender de contratos, nao de SDKs externos.
- OpenAI, Firebase e outros provedores entram por adaptadores em `infra`.
- Ao adicionar um novo provedor de IA, crie outro adapter que respeite o contrato `AiGateway`.
- Ao adicionar novos dados do Firestore, leia `../DATABASE.md` antes e nao invente caminhos.
- Nao duplicar validacoes: se uma regra for compartilhada, mova para application/domain.

## Seguranca

- Nunca commitar `.env`.
- Nao logar prompts com dados sensiveis de clientes, tokens, chaves ou respostas completas da OpenAI.
- Em producao, manter `REQUIRE_FIREBASE_AUTH=true`.
- Rotas de IA devem aceitar token Firebase do usuario logado antes de consumir credito da OpenAI.
- Erros enviados ao frontend devem ser claros, mas sem detalhes internos nem chaves.

## Rotas atuais

- `GET /health`: healthcheck publico.
- `POST /api/ai/responder`: resposta textual para o gerenciador.
- `POST /api/ai/insights`: resposta orientada a dados/JSON para dashboards, analises e explicacoes.
- `POST /api/implantacao/importar-produtos`: recebe CSV em texto, importa produtos/categorias/subcategorias via Firebase Admin e responde em NDJSON com progresso real para a tela Implantacao.

## Implantacao

- A importacao de produtos da tela Implantacao roda no backend, nao no React.
- Caso de uso: `src/application/implantacao/ImportProductsFromCsvUseCase.js`.
- O frontend apenas envia o CSV, acompanha progresso e atualiza os cards.
- Manter o mesmo contrato de Firestore documentado em `../DATABASE.md`: `estabelecimentos/{id}/Products`, `ProductCategories`, `ProductSubcategories` e a colecao global `produtos`.
- Nao expor log completo de CSV, dados de cliente ou tokens.

## Variaveis

- `OPENAI_API_KEY`: secret obrigatoria para IA.
- `OPENAI_MODEL`: modelo usado pelo adapter OpenAI. Padrao: `gpt-4.1-mini`.
- `OPENAI_TEMPERATURE`: criatividade da resposta. Padrao: `0.2`.
- `CORS_ORIGINS`: origens liberadas separadas por virgula.
- `REQUIRE_FIREBASE_AUTH`: `true` em producao.
- `REQUEST_BODY_LIMIT`: limite do corpo JSON.

## Contexto com outros projetos

Este backend atende o `web_gerenciador_plus`. Quando uma funcionalidade de IA depender de dados gerados no app do cliente ou no agente, verificar tambem os projetos vizinhos:

- `..\agente_mobile_mercado`
- `..\web_gerenciador`
- `..\mobile_gerenciador`
- `..\mobile_cliente`

Se uma funcionalidade criar nova colecao/campo no Firestore, atualizar `../DATABASE.md` e registrar o impacto no projeto que captura ou consome esse dado.
