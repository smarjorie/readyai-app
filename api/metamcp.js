// Meta Ads pelo MCP oficial da Meta (https://mcp.facebook.com/ads).
// O MCP aceita chamadas de programas com o token de usuário no cabeçalho Authorization: Bearer.
// O token precisa das permissões ads_mcp_management e ads_read.
// Devolve os mesmos formatos de /api/meta, então o painel funciona igual pelos dois caminhos.
//
// POST /api/metamcp { action: "accounts" | "data" | "portfolio", account_id? }   header: x-meta-token

import { openMcp, McpError } from "./_mcp.js";

const MCP_URL = process.env.META_MCP_URL || "https://mcp.facebook.com/ads";

function send(res, status, body) {
  res.status(status).setHeader("Cache-Control", "no-store");
  res.json(body);
}

// ---------- leitura dos valores do MCP ----------
// os números chegam como "12.3", { value, unit }, { values: [{ value }] } ou "Not available"
function val(v) {
  if (v == null) return 0;
  if (typeof v === "number") return isFinite(v) ? v : 0;
  if (typeof v === "string") { const n = parseFloat(v); return isFinite(n) ? n : 0; }
  if (Array.isArray(v)) return val(v[0] && (v[0].value !== undefined ? v[0].value : v[0]));
  if (typeof v === "object") {
    if (Array.isArray(v.values)) return val(v.values[0] && v.values[0].value);
    if ("value" in v) return val(v.value);
  }
  return 0;
}
function resultOf(e) {
  const p = val(e.omni_purchase);
  if (p > 0) return { n: p, kind: "compras" };
  const r = e.results || {};
  const n = val(r);
  const ind = String(r.indicator || "");
  const kind = /messaging|conversation/.test(ind) ? "conversas" : /lead/.test(ind) ? "leads" : /purchase/.test(ind) ? "compras" : "resultados";
  return { n, kind };
}
const isSalesObj = o => /SALES|CONVERSIONS|PRODUCT_CATALOG/.test(o || "");
const ymd = d => d.toISOString().slice(0, 10);
function daysAgo(n) { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d; }
const range = (a, b) => JSON.stringify({ since: ymd(daysAgo(a)), until: ymd(daysAgo(b)) });
const cid = () => Array.from({ length: 20 }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 62)]).join("");

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

function client(mcp) {
  const base = { client_conversation_id: cid(), advertiser_job: "report_measure_or_look_up" };
  return {
    async accounts() {
      let all = [], cursor;
      for (let p = 0; p < 4; p++) {
        const { data } = await mcp.call("ads_get_ad_accounts", { ...base, limit: 50, ...(cursor ? { cursor } : {}) });
        all = all.concat((data && data.ad_accounts) || []);
        cursor = data && data.next_cursor;
        if (!cursor) break;
      }
      return all;
    },
    async entities(args, maxPages = 3) {
      let all = [], cursor;
      for (let p = 0; p < maxPages; p++) {
        const { data } = await mcp.call("ads_get_ad_entities", { ...base, include_additional_context: false, ...args, ...(cursor ? { cursor } : {}) });
        let list = data && data.ad_entities;
        if (typeof list === "string") { try { list = JSON.parse(list); } catch (e) { list = []; } }
        all = all.concat(Array.isArray(list) ? list : []);
        cursor = data && data.pagination && data.pagination.next_cursor;
        if (!cursor) break;
      }
      return all;
    },
  };
}

const STATUS = { ACTIVE: [1, "Ativa"], DISABLED: [2, "Desativada"], UNSETTLED: [3, "Pagamento pendente"], PENDING_RISK_REVIEW: [7, "Em análise"], PENDING_SETTLEMENT: [8, "Pagamento pendente"], IN_GRACE_PERIOD: [9, "Período de carência"], PENDING_CLOSURE: [100, "Encerramento pendente"], CLOSED: [101, "Encerrada"] };
const statusOf = a => STATUS[String(a.account_status || "").toUpperCase()] || [a.account_status === 1 ? 1 : 0, String(a.account_status || "Outro")];

// ---------- ações ----------
async function accounts(c) {
  const list = await c.accounts();
  return {
    user: "",
    accounts: list.filter(a => a.is_ads_mcp_enabled !== false).map(a => {
      const [code, label] = statusOf(a);
      return { id: "act_" + a.ad_account_id, name: a.ad_account_name || a.ad_account_id, status: label + (a.is_queryable === false ? " · sem consulta" : ""), active: code === 1 && a.is_queryable !== false, currency: a.currency || "BRL", business: a.business_name || "" };
    }).sort((x, y) => (y.active - x.active) || x.name.localeCompare(y.name, "pt-BR")),
  };
}

async function data(c, accountId) {
  const id = String(accountId).replace(/^act_/, "");
  const F = ["id", "name", "effective_status", "objective", "daily_budget", "amount_spent", "impressions", "clicks", "frequency", "omni_purchase", "purchase_roas", "results"];
  const W = ["id", "objective", "amount_spent", "impressions", "clicks", "omni_purchase", "purchase_roas", "results"];
  const [cur, w1, w0, p30] = await Promise.all([
    c.entities({ ad_account_id: id, level: "campaign", fields: F, date_preset: "last_30d", limit: 200 }),
    c.entities({ ad_account_id: id, level: "campaign", fields: W, date_preset: "last_7d", limit: 200 }),
    c.entities({ ad_account_id: id, level: "campaign", fields: W, time_range: range(14, 8), limit: 200 }),
    c.entities({ ad_account_id: id, level: "campaign", fields: W, time_range: range(60, 31), limit: 200 }),
  ]);
  const rev = e => Math.round(val(e.amount_spent) * val(e.purchase_roas) * 100) / 100;
  const by = list => Object.fromEntries(list.map(e => [e.id, e]));
  const A = by(w1), B = by(w0);
  const campaigns = cur.filter(e => val(e.amount_spent) > 0).map(e => {
    const revenue = rev(e), res = resultOf(e);
    const metric = x => x ? (revenue > 0 ? rev(x) : val(x.amount_spent)) : 0;
    const m7 = metric(A[e.id]), mp = metric(B[e.id]);
    return {
      id: "m" + e.id, name: e.name || e.id, ch: "meta",
      status: e.effective_status === "ACTIVE" ? "ativa" : "pausada",
      budget: Math.round(val(e.daily_budget)),
      spend: Math.round(val(e.amount_spent) * 100) / 100,
      purchases: Math.round(res.n), result: res.kind,
      revenue, noRev: revenue === 0 && !isSalesObj(e.objective) ? true : undefined,
      clicks: Math.round(val(e.clicks)), impr: Math.round(val(e.impressions)),
      freq: Math.round(val(e.frequency) * 10) / 10,
      d7: mp > 0 ? Math.max(-1, Math.min(5, Math.round((m7 - mp) / mp * 100) / 100)) : 0,
      objective: e.objective || "",
    };
  }).sort((a, b) => b.spend - a.spend);
  const prev = p30.reduce((a, e) => {
    const r = rev(e), sp = val(e.amount_spent);
    return { spend: a.spend + sp, revenue: a.revenue + r, purchases: a.purchases + resultOf(e).n, clicks: a.clicks + val(e.clicks), impr: a.impr + val(e.impressions), tracked: a.tracked + (r > 0 || isSalesObj(e.objective) ? sp : 0) };
  }, { spend: 0, revenue: 0, purchases: 0, clicks: 0, impr: 0, tracked: 0 });
  return { account: { id: "act_" + id, name: "act_" + id, currency: "BRL" }, campaigns, prev, period: { since: ymd(daysAgo(30)), until: ymd(daysAgo(1)) }, via: "mcp" };
}

async function portfolio(c) {
  const list = (await c.accounts()).filter(a => a.is_ads_mcp_enabled !== false).slice(0, 40);
  const fields = ["amount_spent", "impressions", "clicks", "omni_purchase", "purchase_roas"];
  const acct = async (id, args) => {
    try { const e = (await c.entities({ ad_account_id: id, level: "ad_account", fields, ...args }, 1))[0] || {}; const sp = val(e.amount_spent);
      return { spend: sp, revenue: Math.round(sp * val(e.purchase_roas) * 100) / 100, purchases: val(e.omni_purchase), result: "compras", clicks: val(e.clicks), impr: val(e.impressions) };
    } catch (err) { return { spend: 0, revenue: 0, purchases: 0, result: "compras", clicks: 0, impr: 0, error: true }; }
  };
  const zero = { spend: 0, revenue: 0, purchases: 0, result: "compras", clicks: 0, impr: 0 };
  // 30 dias para todas; semana, ontem e mês só para as contas que gastaram
  const m30 = await pool(list, 8, a => a.is_queryable === false ? zero : acct(a.ad_account_id, { date_preset: "last_30d" }));
  const extra = await pool(list, 4, async (a, k) => {
    if (!(m30[k].spend > 0)) return [zero, zero, zero, zero];
    return Promise.all([acct(a.ad_account_id, { date_preset: "last_7d" }), acct(a.ad_account_id, { time_range: range(14, 8) }), acct(a.ad_account_id, { date_preset: "yesterday" }), acct(a.ad_account_id, { date_preset: "this_month" })]);
  });
  const accounts = list.map((a, k) => {
    const [code, label] = statusOf(a);
    return {
      id: "act_" + a.ad_account_id, name: a.ad_account_name || a.ad_account_id,
      status: code, statusLabel: label, reason: a.not_queryable_reason || a.is_ads_mcp_disabled_reason || "",
      business: a.business_name || "", currency: a.currency || "BRL",
      m30: m30[k], w1: extra[k][0], w0: extra[k][1], yday: extra[k][2].spend, month: extra[k][3].spend,
    };
  }).sort((x, y) => (y.m30.spend - x.m30.spend) || x.name.localeCompare(y.name, "pt-BR"));
  return { accounts, truncated: list.length >= 40, via: "mcp" };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST." });
  const token = String(req.headers["x-meta-token"] || "").trim();
  if (token.length < 20) return send(res, 400, { error: "Cole um token de acesso da Meta válido." });
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  try {
    const mcp = await openMcp(MCP_URL, { authorization: "Bearer " + token }, "MCP da Meta");
    const c = client(mcp);
    if (body.action === "accounts") return send(res, 200, await accounts(c));
    if (body.action === "portfolio") return send(res, 200, await portfolio(c));
    if (body.action === "data") {
      if (!/^(act_)?\d{5,}$/.test(String(body.account_id || ""))) return send(res, 400, { error: "Escolha uma conta de anúncio." });
      return send(res, 200, await data(c, String(body.account_id)));
    }
    return send(res, 400, { error: "Ação desconhecida." });
  } catch (e) {
    if (e instanceof McpError) {
      if (e.code === "unauthorized") return send(res, 401, { error: "O MCP da Meta recusou o token. Ele precisa das permissões ads_mcp_management e ads_read; gere um novo token com essas permissões.", code: e.code });
      if (e.code === "tool_error" && /token|session|oauth|permission/i.test(e.message)) return send(res, 401, { error: "O MCP da Meta recusou o token: " + e.message.slice(0, 200), code: "unauthorized" });
      return send(res, e.status, { error: e.message, code: e.code });
    }
    return send(res, 502, { error: "Não consegui falar com o MCP da Meta agora. Tente de novo." });
  }
}
