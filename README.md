# Backend do web_gerenciador_plus

Backend inicial do gerenciador para recursos de IA. Ele fica separado do frontend Vite para manter chaves, prompts internos e chamadas pagas da OpenAI fora do navegador.

Esta pasta esta ignorada no reposititorio principal do `web_gerenciador_plus`. Quando chegar a hora, ela deve virar um repositorio proprio.

## Stack

- Node.js 20+
- Express
- Firebase Admin
- OpenAI API
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
OPENAI_API_KEY=sua_chave_apenas_no_backend
OPENAI_MODEL=gpt-4.1-mini
OPENAI_TEMPERATURE=0.2
REQUEST_BODY_LIMIT=10mb
REQUIRE_FIREBASE_AUTH=false
```

Regras:

- Nunca colocar `OPENAI_API_KEY` no frontend.
- Nunca commitar `.env`.
- Em producao, manter `REQUIRE_FIREBASE_AUTH=true`.
- Em producao, configurar `OPENAI_API_KEY` como secret do Firebase App Hosting.

## Rotas

### `GET /health`

Verifica se o backend esta online.

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
GET  /api/notifications/web/status/{establishmentId}
POST /api/notifications/web/test
```

As duas rotas sempre exigem `Authorization: Bearer <firebase-id-token>`. O backend confere em `Users` se o UID autenticado pertence ao estabelecimento informado, portanto uma loja nao pode consultar ou disparar notificacoes para outra.

Corpo da notificacao de teste:

```json
{
  "establishmentId": "id_do_estabelecimento_logado"
}
```

O envio usa os documentos ativos de `FcmTokens`, em lotes de ate 500 tokens. Tokens expirados ou invalidos sao desativados automaticamente. A aprovacao manual dos passos 06 e 07 da implantacao tambem gera uma notificacao direcionada para `/implantacao`.

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

O controller nao deve conter regra de negocio. A regra fica nos casos de uso, e os servicos externos ficam em adapters.

## Firebase App Hosting

O arquivo `apphosting.yaml` ja deixa o backend preparado para App Hosting.

Antes de publicar:

1. Configure a secret `OPENAI_API_KEY` no Firebase.
2. Ajuste `CORS_ORIGINS` para o dominio real do frontend.
3. Mantenha `REQUIRE_FIREBASE_AUTH=true`.

## Repositorio proprio

Quando for separar:

```powershell
cd C:\Users\lucas\Desktop\mobile_mercado\web_gerenciador_plus\backend
git init
git add .
git commit -m "Backend inicial do gerenciador plus"
```

Depois conecte ao repositorio remoto proprio do backend.
