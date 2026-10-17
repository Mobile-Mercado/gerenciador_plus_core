# Regras por dono (proposta, não publicada)

Cola RP-1, parte D, 17/10/2026. `firestore.rules` desta pasta é a proposta. Nenhum `firebase.json` aponta para ela, e ela não deve ser publicada sem a autorização explícita e o que precisa ir junto (abaixo).

## O que muda em relação ao `firestore.rules` da branch

| Coleção | Hoje (publicado) | Proposta |
|---|---|---|
| `PurchaseRequests` (raiz) | qualquer login lê, cria e altera | lê: cliente dono, loja do pedido (`adminOf`) ou claim `internal`. Cria: só em nome de um `Users` do próprio uid. Altera: cliente dono ou loja, sem trocar `clientId`, `clientReference`, `companyReference` nem `companyId` |
| `PurchaseRequests/*/AuditLog` e `collectionGroup('AuditLog')` | qualquer login lê | quem pode ver o pedido; o collectionGroup só pela loja (`companyReference`) ou `internal` |
| `estabelecimentos/{id}/PurchaseRequests` | qualquer login lê | só a loja (`adminOf`) |
| `Chats` e `Messages` | qualquer login lê e grava | participante (`senderId` ou `receiverId` igual ao uid, à loja da claim ou a um `Users` do uid), dono ou loja do pedido da conversa, ou `internal`. Ninguém troca participante nem pedido; ninguém apaga |
| `Users` | qualquer login lê | só os próprios documentos (`userAuthId == uid`) ou `internal`; carrinho também legível por `internal` |

O dono é sempre o `userAuthId` do documento `Users`, porque os apps criam o `Users` com id aleatório. Em produção, nenhum pedido tem `clientId` igual ao uid.

## Teste

O teste roda só no emulador, com um projeto `demo-*`. O `firebase-tools` 15 exige Java 21 ou mais novo.

```bash
JAVA_HOME="/c/Program Files/Eclipse Adoptium/jdk-21.0.12.101-hotspot" PATH="$JAVA_HOME/bin:$PATH" npx -y firebase-tools@15.30.0 emulators:exec --only firestore --project demo-regras "node regras-propostas/por-dono/testar-no-emulador.mjs"
```

O script carrega as regras de `origin/main` (as publicadas) e depois a proposta. Roda os mesmos casos nas duas: cada uso da tabela da cola, com arquivo e linha, mais os ataques que a proposta fecha. Imprime a tabela e sai com código 1 se algum caso fugir do esperado.

## O que precisa ir junto

1. **Claim `internal` para o painel interno** (`web_gerenciador_plus/public/painel_experiencia`). A claim não existe em nenhum repositório. É preciso um script com Admin SDK (`setCustomUserClaims`) para as contas da equipe. Também é preciso preencher `ALLOWED_EMAILS`, que hoje está vazio, ou levar o painel para uma rota do Core.
2. **Claim `adminOf` dos lojistas.** Quatro lojas ativas não têm um dono com `adminOf` igual à loja: uma sem claim, uma com claim de outra loja e duas com o dono sem conta no Auth. Nenhuma das quatro teve pedido nos últimos 90 dias (17/10/2026). Um lojista sem a claim perde a lista de pedidos, mas continua vendo as conversas.
3. **"Admin" do agente** (`agente_mobile_mercado_web/src/app/[slug]/admin`). Hoje qualquer login lê e altera os pedidos da loja. Com a proposta, só quem tem `adminOf`. A saída é pedir a claim ou levar a tela para uma rota com Admin SDK.
4. **Web antiga** (`web_gerenciador`). Perde o telefone e o e-mail do cliente no pedido (`Pedidos.jsx:531`) e o histórico do cliente em todas as lojas (`Mensagens.jsx:152`). A web nova não perde nada, porque lê tudo pelo Core.
5. **App Gerenciador das lojas (versão do master).** Perde o "e-mail já existe" do cadastro antigo (`register_user_service.dart:84`): com o erro, o app responde que o e-mail existe. Esse cadastro antigo já não funciona com as regras da branch (`estabelecimentos` create negado), porque a loja nova nasce pelo Core.
6. **Admin antigo.** Perde a lista de consultores (`gerents-service.ts:19`), que fica numa tela fora das liberadas.
