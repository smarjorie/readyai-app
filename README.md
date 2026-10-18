# ReadyAI · Assistente de Marketing

Painel de marketing multicanal com um copilot conversacional.

- **Dados reais:** Meta Ads pela Marketing API (token de acesso) e Google Ads pelo MCP do Google Ads.
- **Copilot:** conversa usando Claude (Anthropic) ou ChatGPT (OpenAI) com a chave de API da própria pessoa.
- Sem contas conectadas, o painel mostra dados de exemplo, com um aviso no topo.

## Estrutura

```
public/index.html   app completo (React via CDN, sem build)
api/chat.js         conversa do copilot -> Anthropic ou OpenAI
api/meta.js         Meta Ads -> Graph API v25 (contas, campanhas, 30 dias, semana, período anterior)
api/google.js       Google Ads -> MCP do Google Ads (autorização, contas, campanhas)
vercel.json         config da Vercel (pasta public + timeout das funções)
```

Não há dependências para instalar.

## Passo a passo: novo cliente com dados reais

1. Entre como admin (`admin@readyai.com`) e clique em **Novo cliente**. Informe empresa, gestor, e-mail, meta de ROAS e plano.
2. Na gaveta do cliente, clique em **Conectar contas deste cliente**. A plataforma abre como esse cliente, direto em Integrações.
3. **Meta Ads → Conectar:** cole o token, clique em *Validar e buscar contas*, escolha a conta de anúncio e clique em *Conectar conta*.
4. **Google Ads → Conectar:** clique em *Autorizar no Google*.
   - Se aparecer *Abrir login do Google*, quem tem acesso à conta faz o login.
   - Depois, volte e clique em *Já autorizei, buscar contas*.
   - Escolha a conta (não a gerenciadora/MCC) e clique em *Conectar conta*.
5. O topo passa a mostrar **Dados reais** com as contas conectadas. Painel, campanhas, insights e copilot usam esses números.

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

## Copilot (Claude ou ChatGPT)

Em Integrações (ou no próprio chat), clique em **Conectar Claude** ou **Conectar ChatGPT** e cole a chave de API.

- A chave fica salva só no navegador.
- A cada pergunta, o app envia a conversa e os dados da conta aberta para `/api/chat`, que repassa ao provedor.
- Propostas de alteração (pausar, reativar, mudar orçamento) só valem com o clique em **Confirmar**, e por enquanto são simulação.

Onde criar as chaves:
- Claude: https://console.anthropic.com/settings/keys
- ChatGPT: https://platform.openai.com/api-keys

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

## Acessos de demonstração

| Perfil | E-mail | Senha |
|---|---|---|
| Gestora (console) | admin@readyai.com | readyAI@2026 |
| Cliente plano Pro | camila@lojaaurora.com.br | demo123 |
| Cliente plano Starter | marina@studiovitta.com.br | demo123 |
| Agência (plano Scale) | rafael@nortex.com.br | demo123 |

## Limites desta versão

- **Tudo fica no navegador.** Clientes, senhas, conexões e tokens ficam no localStorage de quem configurou.
  - Se você conecta as contas de um cliente no seu computador, o cliente não vê essas conexões ao entrar no computador dele.
  - Para produção, o próximo passo é um banco (por exemplo Supabase ou Upstash) e login de verdade.
- **Login de demonstração.** Os usuários e as senhas estão no código, e qualquer pessoa com o link pode ver.
- **Tokens no navegador.** O token da Meta e as chaves de IA ficam em texto no localStorage. Use em navegador de confiança.
