# ReadyAI · Assistente de Marketing

Painel de marketing multicanal (Meta, Google e TikTok Ads) com um copilot conversacional.
O copilot conversa usando **Claude (Anthropic)** ou **ChatGPT (OpenAI)** com a chave de API da própria pessoa.

## Estrutura

```
public/index.html   app completo (React via CDN, sem build)
api/chat.js         função serverless da Vercel: repassa a conversa para Anthropic ou OpenAI
vercel.json         config da Vercel (pasta public + timeout da função)
package.json        só metadados; não há dependências para instalar
```

## Como a parte conversacional funciona

1. Sem IA conectada, o chat mostra **Conectar Claude** e **Conectar ChatGPT** (também em *Integrações*).
2. A pessoa cola a chave de API. O app valida a chave listando os modelos da conta e deixa escolher o modelo.
3. A chave fica salva só no navegador (localStorage). A cada pergunta, o app envia para `/api/chat`
   a conversa e os dados da conta aberta (campanhas, totais, metas, insights). A função repassa para a
   Anthropic ou a OpenAI e devolve a resposta. A chave não é gravada nem logada no servidor.
4. A IA responde em JSON estruturado, que o app desenha como texto, cards de números, recomendações,
   botões de navegação e propostas de alteração (pausar, reativar, mudar orçamento) que só valem com
   o clique em **Confirmar**. O app valida tudo o que a IA devolve: ação para tela inexistente ou
   campanha que não existe é descartada.

Onde criar as chaves:
- Claude: https://console.anthropic.com/settings/keys
- ChatGPT: https://platform.openai.com/api-keys

O uso é cobrado na conta de API de cada provedor, separado das assinaturas Claude Pro ou ChatGPT Plus.

## Publicar: GitHub + Vercel

### 1. Subir para o GitHub

Crie um repositório vazio no GitHub (ex.: `readyai-app`) e, dentro desta pasta:

```bash
git init
git add .
git commit -m "ReadyAI com copilot conectado ao Claude e ao ChatGPT"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/readyai-app.git
git push -u origin main
```

Sem terminal: no GitHub, abra o repositório vazio, clique em *uploading an existing file* e arraste
o conteúdo desta pasta (as pastas `public` e `api` e os arquivos da raiz).

### 2. Importar na Vercel

1. Em https://vercel.com/new, escolha **Import** no repositório.
2. *Framework Preset*: **Other**. Deixe *Build Command* e *Install Command* vazios.
3. *Output Directory* já vem do `vercel.json` (`public`).
4. Não há variáveis de ambiente para configurar. Clique em **Deploy**.

Cada `git push` na `main` publica uma nova versão automaticamente.

## Rodar localmente

A rota `/api/chat` precisa do ambiente da Vercel:

```bash
npm i -g vercel
vercel dev
```

Abrir o `index.html` direto no navegador mostra o app, mas o chat não responde (não há `/api/chat`).

## Acessos de demonstração

| Perfil | E-mail | Senha |
|---|---|---|
| Cliente plano Pro | camila@lojaaurora.com.br | demo123 |
| Cliente plano Starter | marina@studiovitta.com.br | demo123 |
| Agência (plano Scale) | rafael@nortex.com.br | demo123 |
| Gestora (console) | admin@readyai.com | a senha definida na versão original |

## Antes de usar com clientes de verdade

- **Login é de demonstração.** Usuários, senhas e o cadastro de clientes vivem no código e no
  navegador; qualquer pessoa com o link vê o código-fonte. Para produção, troque por autenticação
  real (ex.: Supabase Auth, Clerk ou Auth.js) e um banco de dados.
- **Dados de campanhas são de exemplo.** O copilot analisa os números que estão no app.
- **Conexão com Meta e Google.** A versão no claude.ai usa os conectores (MCP) da conta do Claude,
  uma ponte que só existe dentro do claude.ai. Na Vercel, os dados reais precisam vir das APIs
  (Meta Marketing API com token de acesso; Google Ads API com developer token e OAuth) por novas
  rotas em `api/`, como no projeto Traffiq.
- **Limite de uso.** Como cada pessoa usa a própria chave, o custo fica com ela; mesmo assim, vale
  adicionar limite de requisições em `/api/chat` se o link for público.
