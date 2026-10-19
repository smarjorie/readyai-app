# ReadyAI · Assistente de Marketing

Painel de marketing multicanal com um copilot conversacional.

- **Dados reais:** Meta Ads pela Marketing API (token de acesso) e Google Ads pelo MCP do Google Ads.
- **Copilot:** conversa usando Claude (Anthropic), ChatGPT (OpenAI) ou Groq com a chave de API da própria pessoa.
- Sem contas conectadas, o painel mostra dados de exemplo, com um aviso no topo.

## Estrutura

```
public/index.html   app completo (React via CDN, sem build)
api/chat.js         conversa do copilot -> Anthropic, OpenAI ou Groq
api/meta.js         Meta Ads -> Graph API v25 (contas, campanhas, 30 dias, semana, período anterior)
api/metamcp.js      Meta Ads -> MCP oficial da Meta (mcp.facebook.com/ads), mesmo formato do meta.js
api/google.js       Google Ads -> MCP do Google Ads (autorização, contas, campanhas)
api/_mcp.js         cliente MCP usado pelas rotas (não vira rota)
api/auth.js         login, sessão e aceite do convite
api/clients.js      cadastro de clientes: criar (com convite por e-mail), editar, excluir, reenviar convite
api/_store.js       banco (Upstash Redis), senhas, sessões e envio de e-mail (Resend)
vercel.json         config da Vercel (pasta public + timeout das funções)
```

Não há dependências para instalar.

## Banco e e-mail (convites)

Com o banco configurado, os clientes ficam no servidor. Cada pessoa entra do próprio computador, e o cadastro de um novo cliente envia um convite por e-mail.

**Como funciona o convite**
1. A gestora cria o cliente no console. O app envia um e-mail com o botão **Aceitar convite e criar senha**. O link vale 7 dias.
2. A pessoa abre o link, cria a senha e já entra na plataforma.
3. O console recebe o aceite: a lista se atualiza a cada 20 segundos e quando você volta para a aba. O cliente passa de "Convite enviado" para "Ativo", aparece "Aceito hoje, 10:01" e um aviso na tela. Com `NOTIFY_EMAIL` configurado, a gestora também recebe um e-mail.
4. Na ficha do cliente dá para **reenviar o convite** (gera um link novo e invalida o anterior), copiar o link quando o e-mail não sai e gerar uma senha temporária.
5. **Excluir cliente:** pelo ícone de lixeira na lista ou no fim da ficha, sempre com confirmação. Remove o acesso, as contas conectadas e o convite pendente.

**Configurar na Vercel**
1. **Banco:** em *Storage* (ou *Marketplace*), adicione **Upstash for Redis** e conecte ao projeto. Ele cria `KV_REST_API_URL` e `KV_REST_API_TOKEN`.
2. **E-mail:** crie uma conta no [Resend](https://resend.com) e gere uma API key. Na Vercel, crie `RESEND_API_KEY`.
3. **Remetente:**
   - Sem domínio verificado, o Resend usa `onboarding@resend.dev`, que **só entrega para o e-mail da sua própria conta do Resend**. Serve para testar com você mesma.
   - Para enviar a clientes, verifique um domínio no Resend (registros DNS) e crie `RESEND_FROM`, por exemplo `ReadyAI <convites@seudominio.com.br>`.
4. Faça um **Redeploy** depois de criar as variáveis.

| Variável | Obrigatória | Para quê |
|---|---|---|
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Sim | Banco (criadas pela integração do Upstash) |
| `RESEND_API_KEY` | Para enviar e-mail | Envio dos convites |
| `RESEND_FROM` | Para enviar a clientes | Remetente com domínio verificado |
| `SESSION_SECRET` | Recomendada | Assina as sessões (texto longo aleatório) |
| `ADMIN_PASSWORD` | Recomendada | Troca a senha da gestora (`ADMIN_EMAIL` troca o e-mail) |
| `APP_URL` | Opcional | Endereço usado no link do convite (padrão: o domínio da Vercel) |
| `NOTIFY_EMAIL` | Opcional | Recebe um e-mail quando um cliente aceita o convite |
| `RESEND_REPLY_TO` | Opcional | Endereço de resposta dos convites |

**Clientes antigos:** os cadastros feitos antes do banco ficam no navegador de quem cadastrou. Ao entrar no console com o banco ativo, aparece **Importar para o banco**, que leva senhas e contas conectadas sem enviar e-mail.

Sem banco, o app continua funcionando no modo local, com o aviso "Modo local" no console.

## Passo a passo: novo cliente com dados reais

1. Entre como admin (`admin@readyai.com`) e clique em **Novo cliente**. Informe empresa, gestor, e-mail, meta de ROAS e plano.
2. Na gaveta do cliente, clique em **Conectar contas deste cliente**. A plataforma abre como esse cliente, direto em Integrações.
3. **Meta Ads → Conectar:** cole o token, clique em *Validar e buscar contas*, escolha a conta de anúncio e clique em *Conectar conta*.
4. **Google Ads → Conectar:** clique em *Autorizar no Google*.
   - Se aparecer *Abrir login do Google*, quem tem acesso à conta faz o login.
   - Depois, volte e clique em *Já autorizei, buscar contas*.
   - Escolha a conta (não a gerenciadora/MCC) e clique em *Conectar conta*.
5. O topo passa a mostrar **Dados reais** com as contas conectadas. Painel, campanhas, insights e copilot usam esses números.

### Meta: Marketing API ou MCP da Meta

Na conexão da Meta há duas formas, com o mesmo token:

- **Marketing API:** o servidor lê a Graph API v25. O token precisa de `ads_read`.
- **MCP da Meta:** o servidor chama o MCP oficial em `https://mcp.facebook.com/ads`, com o token no cabeçalho `Authorization: Bearer`, como a Meta documenta para integrações programáticas.
  - O token precisa de `ads_mcp_management` e `ads_read`.
  - Pelo MCP, a receita é calculada como investimento × ROAS de compras.
  - Campanhas de conversa ou lead usam o resultado que o MCP informa.

O painel, a carteira da agência e o copilot funcionam igual nos dois caminhos. Se o MCP recusar um token de usuário do sistema, use a Marketing API.

### Token da Meta

- **Para testar:** no [Graph API Explorer](https://developers.facebook.com/tools/explorer/), escolha um app, adicione a permissão `ads_read` e gere o token. Ele expira em poucas horas.
- **Para uso contínuo:** no Business Manager, em Configurações do negócio › Usuários do sistema, crie um usuário do sistema, dê acesso às contas de anúncio e gere um token com `ads_read`. Esse token não expira.

### MCP do Google Ads

- Por padrão o app usa `https://google-ads-api-five.vercel.app/mcp`. Para outro endereço, crie a variável `GOOGLE_MCP_URL` na Vercel. Se o MCP exigir chave na URL, inclua a chave nela.
- Cada cliente tem um identificador no MCP (padrão `readyai-<empresa>`). Se o cliente já usa o conector no Claude com outro identificador, informe o mesmo em *Opções avançadas*.
- Se o MCP não tiver banco persistente, ele mostra um `refresh_token` na página de sucesso do login. Cole esse token em *Opções avançadas*.

## Agência (plano Scale)

1. Crie o cliente com o plano **Scale** e clique em **Conectar contas deste cliente**.
2. Em **Meta Ads → Conectar**, cole o token e clique em *Validar e buscar contas*.
   - O app mostra todas as contas que o token acessa.
   - Clique em *Conectar carteira*.
3. Em **Carteira de clientes**, cada conta de anúncio aparece como um cliente, na lateral e na tabela.
   - A **Fila de hoje** mostra contas desativadas ou com pagamento pendente, ROAS de 7 dias abaixo de 1,5x, contas sem conversão na semana e oportunidades de escala.
4. Clique numa conta para abrir o painel dela com as campanhas reais. Para trocar de conta, use o seletor do topo.

Use um token de usuário do sistema do Business Manager da agência, com acesso a todas as contas dos clientes.

## Copilot (Claude, ChatGPT ou Groq)

Em Integrações (ou no próprio chat), clique em **Conectar Claude**, **Conectar ChatGPT** ou **Conectar Groq** e cole a chave de API.

- A chave é de cada cliente: fica no cadastro dele (no banco, quando há banco) e não vale para as outras contas, mesmo no mesmo navegador.
- A cada pergunta, o app envia a conversa e os dados da conta aberta para `/api/chat`, que repassa ao provedor.
- Propostas de alteração (pausar, reativar, mudar orçamento) só valem com o clique em **Confirmar**, e por enquanto são simulação.

Onde criar as chaves:
- Claude: https://console.anthropic.com/settings/keys
- ChatGPT: https://platform.openai.com/api-keys
- Groq: https://console.groq.com/keys (modelo padrão `openai/gpt-oss-120b`; o plano gratuito tem limite de requisições por minuto e por dia)

## O que já é real e o que ainda é exemplo

| Parte | Com contas conectadas |
|---|---|
| Investimento, receita, compras/leads/conversas, ROAS, CPA, CTR | Real (Meta e Google) |
| Comparação com os 30 dias anteriores e variação da semana | Real |
| Insights, saúde da conta, recomendações por campanha, copilot | Calculados sobre os dados reais |
| Google Ads: receita e ROAS | Aparecem como n/d. O MCP ainda não devolve valor de conversão |
| Gráfico diário, horário, público, região, criativos | Ainda de exemplo (sinalizado na tela) |
| TikTok Ads | Ainda sem conector |
| Carteira da agência (plano Scale) | Real para a Meta: cada conta de anúncio do token vira um cliente (até 100 contas) |
| Ritmo do mês na carteira | Ainda sem orçamento mensal por cliente |
| Google Ads e TikTok na carteira | Ainda não entram |
| Pausar e mudar orçamento | Simulação; nada muda nas contas |

Campanhas de leads, conversas ou alcance na Meta não entram no ROAS. Elas são avaliadas pelo custo por resultado.

## Publicar

1. **GitHub:** suba o conteúdo desta pasta (as pastas `public` e `api` e os arquivos da raiz) para o repositório.
2. **Vercel:** importe o repositório com *Framework Preset* **Other** e deixe os comandos de build vazios.

Cada `git push` publica de novo. Para testar localmente: `npm i -g vercel` e depois `vercel dev`.

## Acessos de demonstração (modo local)

| Perfil | E-mail | Senha |
|---|---|---|
| Gestora (console) | admin@readyai.com | readyAI@2026 |
| Cliente plano Pro | camila@lojaaurora.com.br | demo123 |
| Cliente plano Starter | marina@studiovitta.com.br | demo123 |
| Agência (plano Scale) | rafael@nortex.com.br | demo123 |

Com o banco ativo, só a gestora entra de cara (com a mesma senha, ou a de `ADMIN_PASSWORD`). Os clientes de demonstração entram depois de importados.

## Limites desta versão

- **Sem banco, tudo fica no navegador.** Sem o Upstash configurado, o app volta ao modo local: clientes, senhas e conexões ficam no localStorage de quem configurou, e não há convite por e-mail.
- **Admin no código.** O acesso da gestora tem senha padrão no código (só o hash). Troque com `ADMIN_PASSWORD` na Vercel.
- **Tokens no banco em texto.** Com banco, o token da Meta, o identificador do Google e a chave da IA ficam no cadastro de cada cliente, no Upstash, sem criptografia.
- **Pausar e mudar orçamento continuam simulação.**
