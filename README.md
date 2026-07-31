# Backend do web_gerenciador_plus

Backend do gerenciador para dados, IA, notificacoes e processos assincronos. Ele fica separado do frontend Vite para manter Firestore Admin, chaves, prompts internos e regras de acesso fora do navegador.

Esta pasta esta ignorada no reposititorio principal do `web_gerenciador_plus`. Quando chegar a hora, ela deve virar um repositorio proprio.

## Stack

- Node.js 20+
- Express
- Firebase Admin
- OpenAI API ou Groq API
- Zod
- Firebase App Hosting

## Comandos locais

```powershell
cd C:\Users\lucas\Desktop\mobile_mercado\web_gerenciador_plus\backend
npm install
npm run dev
npm run check
```

O servidor local usa a porta `8080` por padrao.

## Variaveis de ambiente

Crie um arquivo `.env` usando `.env.example` como base.

```env
NODE_ENV=development
PORT=8080
CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
AI_PROVIDER=openai
OPENAI_API_KEY=sua_chave_apenas_no_backend
OPENAI_MODEL=gpt-4.1-mini
OPENAI_TEMPERATURE=0.2
GROQ_API_KEY=sua_chave_apenas_no_backend
GROQ_MODEL=qwen/qwen3.6-27b
GROQ_TEMPERATURE=0.2
REQUEST_BODY_LIMIT=10mb
REQUIRE_FIREBASE_AUTH=false
```

Regras:

- Use `AI_PROVIDER=openai` ou `AI_PROVIDER=groq`.
- Nunca colocar `OPENAI_API_KEY` ou `GROQ_API_KEY` no frontend.
- Nunca commitar `.env`.
- Em producao, manter `REQUIRE_FIREBASE_AUTH=true`.
- Em producao, configurar a chave do provedor escolhido como secret do Firebase App Hosting.
- Nao existe fallback automatico entre provedores: isso evita consumir a OpenAI paga quando a cota gratuita da Groq terminar.

Para usar a Groq localmente:

```env
AI_PROVIDER=groq
GROQ_API_KEY=sua_chave_groq
GROQ_MODEL=qwen/qwen3.6-27b
```

O modelo Groq padrao aceita texto, imagem e JSON. O plano gratuito possui limites de requisicoes e tokens; uma implantacao completa com milhares de produtos pode consumir a cota antes de terminar.

## Rotas

### `GET /health`

Verifica se o backend esta online.

### Sessao e dados

```text
GET  /api/session
POST /api/data/document
POST /api/data/query
POST /api/data/count
POST /api/data/mutate
POST /api/data/stream
```

Todas exigem token Firebase. A API resolve o estabelecimento pelo UID e restringe os caminhos antes de usar Firebase Admin. `/api/data/stream` entrega snapshots em NDJSON para manter as telas em tempo real sem expor o SDK Firestore no frontend.

### `POST /api/ai/responder`

Gera uma resposta em texto para o painel.

Exemplo de corpo:

```json
{
  "prompt": "Explique por que as vendas cairam hoje.",
  "context": {
    "vendasHoje": 1200,
    "vendasOntem": 1800
  }
}
```

### `POST /api/ai/insights`

Gera uma resposta orientada a dados, preferencialmente em JSON.

Exemplo de corpo:

```json
{
  "question": "Quais pontos merecem atencao?",
  "data": {
    "pedidosCancelados": 12,
    "pedidosEntregues": 80
  }
}
```

### `POST /api/ai/home-overview`

Retorna o resumo e o insight diario da Home. O backend gera no maximo uma resposta por estabelecimento por dia e reutiliza o documento:

```text
estabelecimentos/{establishmentId}/AiDailyInsights/{aaaa-mm-dd}
```

O cache guarda somente a resposta final. Contexto bruto, UID e dados de clientes nao sao persistidos.

### `POST /api/implantacao/importar-produtos`

Importa o CSV de produtos no servidor e grava em:

- `estabelecimentos/{id}/Products`
- `estabelecimentos/{id}/ProductCategories`
- `estabelecimentos/{id}/ProductSubcategories`
- `produtos`

A resposta usa NDJSON para enviar progresso linha a linha enquanto o backend processa o arquivo.

Exemplo de corpo:

```json
{
  "establishmentId": "q0IPIusmpEq3pHbMyfWY",
  "fileName": "catalogo.csv",
  "csvText": "Nome;Descricao;Preco;EAN\nProduto;Descricao;9,99;789..."
}
```

Quando `REQUIRE_FIREBASE_AUTH=true`, as rotas `/api/ai/*` e `/api/implantacao/*` exigem:

```http
Authorization: Bearer <firebase-id-token>
```

### Painel administrativo de implantação

```text
GET   /api/implantacao/admin/pipelines
GET   /api/implantacao/admin/pipelines/{establishmentId}
PATCH /api/implantacao/admin/pipelines/{establishmentId}/checks/{step}/{checkId}
```

Além do token Firebase, o UID precisa existir em `IMPLANTATION_ADMIN_UIDS`. Separe múltiplos UIDs por vírgula. O painel lê e altera somente o documento compacto `implantacaoGrenciador/pipeline`.

### Notificacoes web

```text
POST /api/notifications/web/register
GET  /api/notifications/web/status/{establishmentId}
POST /api/notifications/web/test
```

As rotas sempre exigem `Authorization: Bearer <firebase-id-token>`. O backend confere em `Users` se o UID autenticado pertence ao estabelecimento, portanto uma loja nao pode registrar, consultar ou disparar notificacoes para outra. A rota `register` recebe o token criado pelo Firebase Messaging no navegador e o persiste pelo Firebase Admin.

Corpo da notificacao de teste:

```json
{
  "establishmentId": "id_do_estabelecimento_logado"
}
```

O envio usa os documentos ativos de `FcmTokens`, em lotes de ate 500 tokens. Tokens expirados ou invalidos sao desativados automaticamente. O payload e enviado como mensagem de dados; o Service Worker do frontend monta e exibe uma unica notificacao, inclusive com a pagina fechada. A aprovacao manual dos passos 06 e 07 da implantacao tambem gera uma notificacao direcionada para `/implantacao`.

## Script de contexto do Firestore

Gera um rascunho local para complementar o `DATABASE.md`, sem aplicar automaticamente:

```powershell
npm run db:context
```

Modo seguro por padrão:

- Não imprime valores reais de documentos.
- Não amostra coleções sensíveis como usuários, conversas, mensagens, pedidos e endereços.
- Ignora sempre `AgenteVendas`, `Agentes` e `Automacoes`.
- Coleções grandes, como `estabelecimentos/{id}/Products`, devem ter um ID específico em `scripts/firestore-context.config.example.json`.
- O arquivo gerado deve ser revisado localmente antes de qualquer uso.

## Arquitetura

```text
src/
  app.js
  server.js
  config/
  domain/
  application/
  infra/
  http/
```

Responsabilidades:

- `http`: entrada e saida HTTP.
- `application`: casos de uso.
- `domain`: contratos e erros centrais.
- `infra`: OpenAI, Firebase Admin e outros servicos externos.
- `config`: variaveis de ambiente.

Arquivos centrais do BFF Firestore:

- `src/application/data/ManageManagerData.js`: caso de uso de dados.
- `src/infra/firebase/ManagerDataAccessPolicy.js`: autorizacao por loja e por recurso.
- `src/infra/firebase/FirestoreManagerDataGateway.js`: consultas, contagens, streams e mutacoes.
- `src/infra/firebase/firestoreTransport.js`: referencias, timestamps e valores especiais no transporte HTTP.

O controller nao deve conter regra de negocio. A regra fica nos casos de uso, e os servicos externos ficam em adapters.

## Firebase App Hosting

O arquivo `apphosting.yaml` ja deixa o backend preparado para App Hosting.

Antes de publicar com OpenAI:

1. Configure a secret `OPENAI_API_KEY` no Firebase.
2. Ajuste `CORS_ORIGINS` para o dominio real do frontend.
3. Mantenha `REQUIRE_FIREBASE_AUTH=true`.

Para publicar com Groq:

1. Crie a secret: `firebase apphosting:secrets:set GROQ_API_KEY --project appmobileprod-19505`.
2. No `apphosting.yaml`, troque `AI_PROVIDER` para `groq`.
3. Adicione `GROQ_API_KEY` ao bloco `env` usando `secret: GROQ_API_KEY`.
4. Nao remova a secret OpenAI se quiser poder voltar ao provedor anterior.

### Cloud Functions

Os gatilhos de novo pedido e agregacao horaria ficam em `functions/` deste repositorio. App Hosting e Cloud Functions possuem deploys separados:

```powershell
firebase deploy --only functions --project appmobileprod-19505
```

Esse comando nao publica `firestore.rules` nem `firestore.indexes.json`. Alteracoes nesses dois arquivos devem ser implantadas somente com autorizacao explicita.

## Repositorio proprio

Esta pasta ja e um repositorio Git proprio e permanece ignorada pelo repositorio do frontend. Commits e deploys devem ser feitos a partir dela:

```powershell
cd C:\Users\lucas\Desktop\mobile_mercado\web_gerenciador_plus\backend
git add .
git commit -m "Atualiza backend do gerenciador"
git push
```
