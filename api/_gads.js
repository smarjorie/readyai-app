// Google Ads direto pela API oficial (REST), com o OAuth do próprio app.
// Credenciais na Vercel: GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET (cliente OAuth "Aplicativo da Web" no Google Cloud).
// Opcionais: GOOGLE_ADS_API_VERSION (padrão v26), GOOGLE_REDIRECT_URI, GOOGLE_ADS_DEVELOPER_TOKEN.
// O refresh token de cada cliente fica só no banco (nunca vai para o navegador).
import crypto from "node:crypto";
import { HttpError, cmd } from "./_store.js";

const P = process.env.KV_PREFIX || "readyai-app:";
const K = {
  token: cid => P + "gads:" + cid,            // { refreshToken, email, scope, at }
  state: s => P + "gstate:" + s,              // { cid, origin }, vale 10 minutos
  access: cid => P + "gads-at:" + cid,        // access token em cache (~55 min)
};
export const SCOPE = "https://www.googleapis.com/auth/adwords";
const VERSION = () => process.env.GOOGLE_ADS_API_VERSION || "v26";
// valores colados na Vercel às vezes vêm com espaço, quebra de linha ou aspas
const env = k => String(process.env[k] || "").trim().replace(/^["']|["']$/g, "").trim();
const CLIENT_ID = () => env("GOOGLE_CLIENT_ID"), CLIENT_SECRET = () => env("GOOGLE_CLIENT_SECRET");
export const googleReady = () => !!(CLIENT_ID() && CLIENT_SECRET());

// o endereço de retorno precisa ser idêntico ao cadastrado no Google Cloud
export function redirectUri(req) {
  if (env("GOOGLE_REDIRECT_URI")) return env("GOOGLE_REDIRECT_URI");
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000";
  const proto = req.headers["x-forwarded-proto"] || (String(host).startsWith("localhost") ? "http" : "https");
  return proto + "://" + host + "/api/google-callback";
}

// ---------- autorização ----------
export async function authUrl(req, cid) {
  if (!googleReady()) throw new HttpError(503, "A conexão com o Google Ads ainda não está configurada. Faltam GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET na Vercel.", "no_google");
  if (!/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(CLIENT_ID())) throw new HttpError(503, "O GOOGLE_CLIENT_ID na Vercel não parece um ID de cliente OAuth. Ele tem o formato 123456789012-abc123.apps.googleusercontent.com (Google Cloud → Google Auth Platform → Clientes).", "bad_client");
  const state = crypto.randomBytes(24).toString("base64url");
  await cmd("SET", K.state(state), JSON.stringify({ cid, at: Date.now() }), "EX", "600");
  const q = new URLSearchParams({
    client_id: CLIENT_ID(), redirect_uri: redirectUri(req), response_type: "code",
    // só o escopo do Google Ads: com um escopo só, o Google mostra "Permitir" em vez de caixinhas que podem ficar desmarcadas
    scope: SCOPE, access_type: "offline", prompt: "consent", state,
  });
  return "https://accounts.google.com/o/oauth2/v2/auth?" + q;
}

// troca o código do retorno pelo refresh token e guarda no cadastro do cliente
export async function finishAuth(req, code, state) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(state || ""))) throw new HttpError(400, "Link de autorização inválido.");
  const raw = await cmd("GET", K.state(state));
  if (!raw) throw new HttpError(400, "Esta autorização expirou. Volte para a metrikabr e clique em Autorizar no Google de novo.");
  await cmd("DEL", K.state(state));
  const { cid } = JSON.parse(raw);
  const j = await tokenCall({ code, grant_type: "authorization_code", redirect_uri: redirectUri(req) });
  if (!String(j.scope || "").split(/\s+/).includes(SCOPE)) throw new HttpError(400, "O acesso ao Google Ads não foi liberado. Clique em Autorizar no Google de novo e, se o Google mostrar uma caixa de seleção, marque a permissão do Google Ads antes de continuar.", "no_scope");
  if (!j.refresh_token) throw new HttpError(400, "O Google não devolveu a autorização permanente. Tente de novo.");
  let email = null; // o e-mail só vem quando o login já tinha liberado o escopo de e-mail antes
  try { email = JSON.parse(Buffer.from(String(j.id_token || "").split(".")[1] || "", "base64url").toString()).email || null; } catch (e) {}
  await cmd("SET", K.token(cid), JSON.stringify({ refreshToken: j.refresh_token, email, scope: j.scope, at: new Date().toISOString() }));
  await cmd("SET", K.access(cid), j.access_token, "EX", String(Math.max(60, (j.expires_in || 3600) - 300)));
  return { cid, email };
}

async function tokenCall(params) {
  let r;
  try {
    r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CLIENT_ID(), client_secret: CLIENT_SECRET(), ...params }) });
  } catch (e) { throw new HttpError(502, "Não consegui falar com o Google agora. Tente de novo."); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (j.error === "invalid_grant") throw new HttpError(401, "A autorização do Google Ads expirou ou foi revogada. Clique em Autorizar no Google de novo.", "needs_auth");
    if (j.error === "invalid_client" || j.error === "unauthorized_client") throw new HttpError(503, "O Google recusou as credenciais do app (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET). Confira os valores na Vercel.", "bad_client");
    throw new HttpError(502, "O Google recusou a autorização: " + (j.error_description || j.error || r.status));
  }
  return j;
}

export async function tokenInfo(cid) { const v = await cmd("GET", K.token(cid)); return v ? JSON.parse(v) : null; }

async function accessToken(cid) {
  const cached = await cmd("GET", K.access(cid));
  if (cached) return cached;
  const t = await tokenInfo(cid);
  if (!t) throw new HttpError(401, "O Google Ads deste cliente ainda não foi autorizado. Clique em Autorizar no Google.", "needs_auth");
  const j = await tokenCall({ refresh_token: t.refreshToken, grant_type: "refresh_token" });
  await cmd("SET", K.access(cid), j.access_token, "EX", String(Math.max(60, (j.expires_in || 3600) - 300)));
  return j.access_token;
}

// remove a autorização: apaga do banco e revoga no Google
export async function revoke(cid) {
  const t = await tokenInfo(cid);
  await cmd("DEL", K.token(cid)); await cmd("DEL", K.access(cid));
  if (t && t.refreshToken) await fetch("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: t.refreshToken }) }).catch(() => null);
}
export const tokenKeys = cid => [K.token(cid), K.access(cid)];

// ---------- chamadas à API ----------
async function ads(cid, path, { method = "GET", body, login } = {}) {
  const at = await accessToken(cid);
  const headers = { authorization: "Bearer " + at, "content-type": "application/json" };
  if (process.env.GOOGLE_ADS_DEVELOPER_TOKEN) headers["developer-token"] = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (login) headers["login-customer-id"] = String(login).replace(/\D/g, "");
  let r;
  try { r = await fetch(`https://googleads.googleapis.com/${VERSION()}/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }); }
  catch (e) { throw new HttpError(502, "Não consegui falar com o Google Ads agora. Tente de novo."); }
  const j = await r.json().catch(() => null);
  if (!r.ok) throw adsError(r.status, j);
  return j;
}
function adsError(status, j) {
  const err = Array.isArray(j) ? j[0] && j[0].error : j && j.error;
  const details = JSON.stringify((err && err.details) || []);
  const msg = (err && err.message) || "";
  if (status === 401) return new HttpError(401, "A autorização do Google Ads expirou. Clique em Autorizar no Google de novo.", "needs_auth");
  if (/DEVELOPER_TOKEN_NOT_APPROVED|only approved for use with test accounts|TEST_ACCOUNT/i.test(details + msg))
    return new HttpError(403, "O projeto do Google Cloud da metrikabr ainda só tem acesso de teste à API do Google Ads. Peça o acesso Explorer em Google Ads API → Níveis de acesso, no Google Cloud.", "test_access");
  if (/USER_PERMISSION_DENIED|CUSTOMER_NOT_ENABLED|NOT_ADS_USER/i.test(details))
    return new HttpError(403, "O login do Google usado não tem acesso a essa conta do Google Ads (ou a conta está desativada).", "no_permission");
  if (/AUTHORIZATION_ERROR|PERMISSION_DENIED/i.test(details + msg) || status === 403)
    return new HttpError(403, "O Google Ads recusou o acesso: " + (msg || "permissão negada") + ". Se o acesso Explorer foi liberado há pouco, aguarde alguns minutos.", "denied");
  if (status === 404) return new HttpError(502, "A versão da API do Google Ads configurada não existe mais. Atualize GOOGLE_ADS_API_VERSION.", "version");
  return new HttpError(502, "O Google Ads recusou a consulta: " + (msg || "erro " + status).slice(0, 220));
}
// GAQL com searchStream; devolve todas as linhas
async function query(cid, customerId, gaql, login) {
  const pages = await ads(cid, `customers/${customerId}/googleAds:searchStream`, { method: "POST", body: { query: gaql }, login: login || customerId });
  return (Array.isArray(pages) ? pages : [pages]).flatMap(p => (p && p.results) || []);
}

// ---------- contas ----------
const fmtId = id => String(id).replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3");
export async function listAccounts(cid) {
  const j = await ads(cid, "customers:listAccessibleCustomers");
  const ids = ((j && j.resourceNames) || []).map(r => r.split("/")[1]).filter(Boolean).slice(0, 20);
  const out = [];
  await Promise.all(ids.map(async id => {
    let me;
    try { me = (await query(cid, id, "SELECT customer.id, customer.descriptive_name, customer.manager, customer.status, customer.currency_code FROM customer LIMIT 1", id))[0]; }
    catch (e) { if (e.code === "test_access" || e.code === "needs_auth") throw e; return; } // conta sem permissão ou desativada: fica de fora
    if (!me) return;
    const c = me.customer;
    if (c.status && c.status !== "ENABLED") return;
    out.push({ id, label: fmtId(id), name: c.descriptiveName || "", manager: !!c.manager, currency: c.currencyCode || null });
    if (!c.manager) return;
    // gerenciadora (MCC): as campanhas ficam nas subcontas
    const kids = await query(cid, id, "SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.status, customer_client.level, customer_client.currency_code FROM customer_client WHERE customer_client.level <= 2 AND customer_client.status = 'ENABLED'", id).catch(() => []);
    for (const k of kids) {
      const cc = k.customerClient; const kid = String(cc.id);
      if (kid === id || cc.manager) continue;
      out.push({ id: kid, label: fmtId(kid), name: cc.descriptiveName || "", manager: false, via: id, viaLabel: fmtId(id), currency: cc.currencyCode || null });
    }
  }));
  // a mesma conta pode aparecer direta e via MCC: fica a direta
  const seen = new Map();
  for (const a of out) if (!seen.has(a.id) || (seen.get(a.id).via && !a.via)) seen.set(a.id, a);
  return [...seen.values()].sort((a, b) => (a.manager - b.manager) || a.name.localeCompare(b.name));
}

// ---------- campanhas no formato do painel ----------
const micros = v => (Number(v) || 0) / 1e6;
const num = v => Number(v) || 0;
const r2 = v => Math.round(v * 100) / 100;
const during = r => `segments.date BETWEEN '${r.since}' AND '${r.until}'`;
const CAMP_FIELDS = "campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.amount_micros, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value";

export async function campaignData(cid, customerId, login, P) {
  const q = range => query(cid, customerId, `SELECT ${CAMP_FIELDS} FROM campaign WHERE ${during(range)} AND campaign.status != 'REMOVED'`, login);
  const [cur, prev, w1, w0, daily] = await Promise.all([
    q(P), q(P.prev), q(P.w1), q(P.w0),
    query(cid, customerId, `SELECT segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM customer WHERE ${during(P.last14)}`, login),
  ]);
  const byId = rows => Object.fromEntries(rows.map(r => [String(r.campaign.id), r]));
  const W1 = byId(w1), W0 = byId(w0);
  const campaigns = cur.map(r => {
    const m = r.metrics || {}, spend = micros(m.costMicros);
    if (spend <= 0) return null;
    const id = String(r.campaign.id), rev = num(m.conversionsValue);
    const last = W1[id] ? micros(W1[id].metrics.costMicros) : 0, before = W0[id] ? micros(W0[id].metrics.costMicros) : 0;
    return {
      id: "g" + id, name: r.campaign.name, ch: "google",
      status: r.campaign.status === "ENABLED" ? "ativa" : "pausada",
      type: r.campaign.advertisingChannelType || null,
      budget: Math.round(micros(r.campaignBudget && r.campaignBudget.amountMicros)),
      spend: r2(spend), purchases: r2(num(m.conversions)),
      revenue: r2(rev), noRev: rev <= 0, // sem valor de conversão (ex.: campanha de leads) não entra no ROAS
      clicks: num(m.clicks), impr: num(m.impressions), freq: 0,
      d7: before > 0 ? Math.max(-1, Math.min(5, r2((last - before) / before))) : 0,
    };
  }).filter(Boolean).sort((a, b) => b.spend - a.spend);
  const pv = prev.reduce((a, r) => {
    const m = r.metrics || {}, sp = micros(m.costMicros), rev = num(m.conversionsValue);
    return { spend: a.spend + sp, revenue: a.revenue + rev, purchases: a.purchases + num(m.conversions), clicks: a.clicks + num(m.clicks), impr: a.impr + num(m.impressions), tracked: a.tracked + (rev > 0 ? sp : 0) };
  }, { spend: 0, revenue: 0, purchases: 0, clicks: 0, impr: 0, tracked: 0 });
  const dmap = Object.fromEntries(daily.map(r => [r.segments.date, r.metrics || {}]));
  const days = P.days14.map(d => { const m = dmap[d] || {}; return { d, spend: r2(micros(m.costMicros)), impr: num(m.impressions), clicks: num(m.clicks), compras: r2(num(m.conversions)), leads: 0, conversas: 0, revenue: r2(num(m.conversionsValue)) }; });
  const others = cur.filter(r => micros(r.metrics && r.metrics.costMicros) <= 0).slice(0, 50).map(r => ({ id: "g" + r.campaign.id, name: r.campaign.name, on: r.campaign.status === "ENABLED", metaStatus: r.campaign.status, statusLabel: r.campaign.status === "ENABLED" ? "Ativa" : "Pausada" }));
  return {
    account: { id: customerId, label: fmtId(customerId) },
    campaigns, prev: { ...pv, spend: r2(pv.spend), revenue: r2(pv.revenue) }, days, others,
    period: { since: P.since, until: P.until },
    note: campaigns.length ? undefined : "Nenhuma campanha com investimento nesse período. Se for uma conta gerenciadora (MCC), escolha a subconta onde as campanhas estão.",
  };
}
