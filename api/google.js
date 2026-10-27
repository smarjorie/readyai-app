// Google Ads pelo MCP do Google Ads (o mesmo conector usado no Claude), chamado aqui pelo servidor do app.
// O MCP cuida do login com o Google: cada cliente tem um identificador (client_slug) e autoriza uma vez.
//
// POST /api/google { action: "connect",  slug }                 -> { authorized, url? }
// POST /api/google { action: "accounts", slug }                 -> contas que o login do Google enxerga
// POST /api/google { action: "data",     slug, customer_id }    -> campanhas dos últimos 30 dias, no formato do painel
// Opcional em todas: refresh_token (só quando o MCP não tem banco persistente e pede o token de volta).

import { periodOf } from "./_period.js";

const MCP_URL = process.env.GOOGLE_MCP_URL || "https://google-ads-api-five.vercel.app/mcp";
const PROTOCOL = "2025-06-18";

function send(res, status, body) {
  res.status(status).setHeader("Cache-Control", "no-store");
  res.json(body);
}

class McpError extends Error {
  constructor(message, status = 502, code) { super(message); this.status = status; this.code = code; }
}

// ---------- cliente MCP mínimo (Streamable HTTP) ----------
async function rpc(state, method, params, isNotification) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (state.session) headers["mcp-session-id"] = state.session;
  if (state.protocol) headers["mcp-protocol-version"] = state.protocol;
  const id = isNotification ? undefined : ++state.seq;
  const msg = { jsonrpc: "2.0", method, ...(params ? { params } : {}), ...(isNotification ? {} : { id }) };
  let r;
  try {
    r = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(msg) });
  } catch (e) {
    throw new McpError("Não consegui acessar o MCP do Google Ads. Confira se o endereço dele está no ar.");
  }
  const sid = r.headers.get("mcp-session-id");
  if (sid) state.session = sid;
  if (isNotification) return null;
  const raw = await r.text();
  if (r.status === 401 || r.status === 403) throw new McpError("O MCP do Google Ads recusou o acesso deste app. Se ele usa chave, inclua a chave em GOOGLE_MCP_URL na Vercel.", 502);
  if (!r.ok) throw new McpError("O MCP do Google Ads respondeu com erro (" + r.status + ").", 502);
  // a resposta pode vir como JSON puro ou como stream SSE com linhas "data: {...}"
  let reply = null;
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("text/event-stream") || raw.trimStart().startsWith("event:") || raw.trimStart().startsWith("data:")) {
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try { const j = JSON.parse(line.slice(5).trim()); if (j && j.id === id) reply = j; } catch (e) {}
    }
  } else {
    try { const j = JSON.parse(raw); reply = Array.isArray(j) ? j.find(x => x.id === id) : j; } catch (e) {}
  }
  if (!reply) throw new McpError("Resposta inesperada do MCP do Google Ads.");
  if (reply.error) throw new McpError("O MCP do Google Ads recusou o pedido: " + (reply.error.message || "erro"), 502);
  return reply.result;
}

async function openSession() {
  const state = { seq: 0, session: null, protocol: null };
  const init = await rpc(state, "initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "readyai-app", version: "1.0.0" } });
  state.protocol = (init && init.protocolVersion) || PROTOCOL;
  await rpc(state, "notifications/initialized", null, true);
  return {
    async call(name, args) {
      const result = await rpc(state, "tools/call", { name, arguments: args });
      const text = ((result && result.content) || []).filter(c => c.type === "text").map(c => c.text).join("\n");
      if (result && result.isError) throw new McpError(googleMessage(text), 400, "tool_error");
      return text;
    },
  };
}

function googleMessage(text) {
  if (/ainda não conectou|não conectado|storage não é persistente/i.test(text)) return "O acesso ao Google Ads deste cliente não está autorizado (ou se perdeu). Clique em Autorizar no Google de novo.";
  if (/accounts\.google\.com\/o\/oauth2/.test(text)) return "O acesso ao Google Ads expirou. Clique em Autorizar no Google de novo.";
  return "O Google Ads recusou a consulta: " + text.slice(0, 220);
}
function checkAuth(text) {
  if (/ainda não conectou|storage não é persistente|accounts\.google\.com\/o\/oauth2/i.test(text)) throw new McpError(googleMessage(text), 401, "needs_auth");
  return text;
}

// ---------- leitura das respostas em texto do MCP (formato do conector) ----------
const n = v => { const x = parseFloat(String(v).replace(/,/g, "")); return isFinite(x) ? x : 0; };
const fmtId = id => id.replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3");

function parseCampaigns(text) {
  const re = /^#(\d+)\s+"(.*)"\s+[—-]\s+(\d+)\s+[—-]\s+(\d+)\s+[—-]\s+orçamento:\s*R\$\s*([\d.,]+)/gm;
  return Array.from(text.matchAll(re)).map(m => ({ id: m[1], name: m[2], status: m[3], type: m[4], budget: n(m[5]) }));
}
function parsePerf(text) {
  const re = /"(.*)"\s+\((\d+)\)\s*\n\s*impressões:\s*([\d.,]+)\s*\|\s*cliques:\s*([\d.,]+)\s*\|\s*CTR:[^\n]*\n\s*custo:\s*R\$\s*([\d.,]+)\s*\|\s*conversões:\s*([\d.,]+)/g;
  const out = {};
  for (const m of text.matchAll(re)) out[m[2]] = { name: m[1], impr: n(m[3]), clicks: n(m[4]), spend: n(m[5]), conv: n(m[6]) };
  return out;
}
const sum = perf => Object.values(perf).reduce((a, p) => ({ spend: a.spend + p.spend, impr: a.impr + p.impr, clicks: a.clicks + p.clicks, conv: a.conv + p.conv }), { spend: 0, impr: 0, clicks: 0, conv: 0 });
function periodOfText(text) { const m = text.match(/(\d{4}-\d{2}-\d{2})\s+a\s+(\d{4}-\d{2}-\d{2})/); return m ? { since: m[1], until: m[2] } : null; }

// ---------- ações ----------
async function connect(mcp, base) {
  const text = await mcp.call("google_ads_connect", base);
  const url = (text.match(/https:\/\/accounts\.google\.com\/[^\s)"'<>]+/) || [])[0];
  return url ? { authorized: false, url } : { authorized: true, message: text.slice(0, 300) };
}

async function accounts(mcp, base) {
  const text = checkAuth(await mcp.call("google_ads_list_accounts", base));
  const ids = Array.from(text.matchAll(/^\s*-\s*(\d{10})\b/gm)).map(m => m[1]);
  if (!ids.length && text.trim() && !/nenhuma/i.test(text)) throw new McpError("Resposta inesperada do MCP: " + text.slice(0, 160));
  const out = [];
  // contas gerenciadoras (MCC) listam as subcontas; é nelas que ficam as campanhas
  for (const id of ids.slice(0, 6)) {
    let sub = "";
    try { sub = await mcp.call("google_ads_list_sub_accounts", { ...base, manager_customer_id: id }); } catch (e) {}
    const kids = Array.from(sub.matchAll(/^\s*-\s*(\d{10})\s+"(.*)"\s+[—-]\s+(\d+)/gm)).map(m => ({ id: m[1], name: m[2], status: m[3] }));
    const self = kids.find(k => k.id === id);
    if (!out.some(o => o.id === id)) out.push({ id, label: fmtId(id), name: (self && self.name) || "", manager: kids.length > 1 });
    for (const k of kids) if (k.id !== id && !out.some(o => o.id === k.id)) out.push({ id: k.id, label: fmtId(k.id), name: k.name, manager: false, via: fmtId(id) });
  }
  return { accounts: out };
}

// o MCP do Google aceita só "últimos N dias" (até hoje): o período é convertido para isso
async function data(mcp, base, customerId, period) {
  const P = periodOf(period);
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const D = Math.max(1, Math.round((today - new Date(P.since + "T00:00:00Z")) / 86400e3));
  const endsRecent = (today - new Date(P.until + "T00:00:00Z")) / 86400e3 <= 1;
  const args = { ...base, customer_id: customerId };
  const listText = checkAuth(await mcp.call("google_ads_list_campaigns", args));
  const list = parseCampaigns(listText).filter(c => c.status !== "4");
  if (!list.length) return { campaigns: [], prev: null, note: "Essa conta não tem campanhas. Se for uma conta gerenciadora (MCC), escolha a subconta onde as campanhas estão." };
  // 30 dias atuais, 60 dias (para o período anterior), 7 e 14 dias (para a variação semanal)
  const texts = (await Promise.all([D, D * 2, 7, 14].map(days => mcp.call("google_ads_campaign_performance", { ...args, days })))).map(checkAuth);
  const [p30, p60, p7, p14] = texts.map(parsePerf);
  const byName = perf => Object.fromEntries(Object.values(perf).map(p => [p.name, p]));
  const n30 = byName(p30), n7 = byName(p7), n14 = byName(p14);
  const get = (perf, names, c) => perf[c.id] || names[c.name] || null;
  const campaigns = list.map(c => {
    const cur = get(p30, n30, c);
    if (!cur || cur.spend <= 0) return null;
    const w = get(p7, n7, c), w2 = get(p14, n14, c);
    const last = w ? w.spend : 0, before = w2 ? Math.max(0, w2.spend - last) : 0;
    return {
      id: "g" + c.id, name: c.name, ch: "google",
      status: c.status === "2" ? "ativa" : "pausada",
      budget: Math.round(c.budget),
      spend: Math.round(cur.spend * 100) / 100,
      purchases: Math.round(cur.conv * 100) / 100,
      revenue: 0, noRev: true,
      clicks: Math.round(cur.clicks), impr: Math.round(cur.impr), freq: 0,
      d7: before > 0 ? Math.max(-1, Math.min(5, Math.round((last - before) / before * 100) / 100)) : 0,
    };
  }).filter(Boolean).sort((a, b) => b.spend - a.spend);
  const s30 = sum(p30), s60 = sum(p60);
  return {
    account: { id: customerId, label: fmtId(customerId) },
    campaigns,
    prev: { spend: Math.max(0, s60.spend - s30.spend), tracked: 0, revenue: 0, purchases: Math.max(0, s60.conv - s30.conv), clicks: Math.max(0, s60.clicks - s30.clicks), impr: Math.max(0, s60.impr - s30.impr) },
    period: periodOfText(texts[0]),
    note: endsRecent ? undefined : "O Google Ads só aceita períodos que terminam hoje: mostrando os últimos " + D + " dias.",
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST." });
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const slug = String(body.slug || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) return send(res, 400, { error: "Identificador do cliente inválido." });
  const base = { client_slug: slug };
  if (body.refresh_token) base.refresh_token = String(body.refresh_token).trim();
  try {
    const mcp = await openSession();
    if (body.action === "connect") return send(res, 200, await connect(mcp, base));
    if (body.action === "accounts") return send(res, 200, await accounts(mcp, base));
    if (body.action === "data") {
      const id = String(body.customer_id || "").replace(/\D/g, "");
      if (id.length !== 10) return send(res, 400, { error: "Escolha uma conta do Google Ads (10 dígitos)." });
      return send(res, 200, await data(mcp, base, id, body.period));
    }
    return send(res, 400, { error: "Ação desconhecida." });
  } catch (e) {
    if (e instanceof McpError) return send(res, e.status, { error: e.message, code: e.code });
    return send(res, 502, { error: "Não consegui falar com o MCP do Google Ads agora. Tente de novo." });
  }
}
