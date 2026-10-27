// Meta Ads pela Marketing API (Graph API), no mesmo padrão do Traffiq.
// O token de acesso vem do navegador no header "x-meta-token" e só é usado nesta chamada.
//
// POST /api/meta  { action: "accounts" }                 -> contas de anúncio do token
// POST /api/meta  { action: "data", account_id: "act_" } -> campanhas dos últimos 30 dias, já no formato do painel
// POST /api/meta  { action: "breakdowns", account_id, kind } -> hora do dia, idade, dispositivo e região (30 dias)

import { periodOf, tr } from "./_period.js";

const GRAPH = "https://graph.facebook.com/v25.0";

// Tipos de ação de compra, em ordem de preferência. Usa só o primeiro que aparecer,
// porque a Meta repete a mesma compra em vários tipos (somar todos conta em dobro).
const PURCHASE_TYPES = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase", "onsite_web_purchase", "website_purchase"];

function send(res, status, body) {
  res.status(status).setHeader("Cache-Control", "no-store");
  res.json(body);
}

class GraphError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

function friendly(err) {
  const e = (err && err.error) || {};
  if (e.code === 190) return "O token da Meta expirou ou é inválido. Gere um novo e conecte de novo.";
  if (e.code === 200 || e.code === 10 || e.code === 294) return "O token não tem permissão para ler anúncios. Gere o token com a permissão ads_read.";
  if (e.code === 17 || e.code === 4 || e.code === 613 || e.code === 80004) return "A Meta limitou as consultas por alguns minutos. Tente de novo daqui a pouco.";
  if (e.code === 100 && /does not exist|Unsupported get request/i.test(e.message || "")) return "Essa conta de anúncio não existe ou o token não tem acesso a ela.";
  return "A Meta recusou a consulta: " + (e.error_user_msg || e.message || "erro desconhecido");
}

async function graph(path, params, token) {
  const u = new URL(GRAPH + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
  }
  u.searchParams.set("access_token", token);
  const r = await fetch(u, { headers: { accept: "application/json" } });
  let j = null;
  try { j = await r.json(); } catch (e) {}
  if (!r.ok || !j || j.error) throw new GraphError(friendly(j), r.status === 200 ? 400 : r.status, j && j.error && j.error.code);
  return j;
}

// Paginação com teto: conta grande não pode estourar o limite da Graph API
async function graphAll(path, params, token, maxPages = 5) {
  let out = [];
  let page = await graph(path, params, token);
  out = out.concat(page.data || []);
  let n = 1;
  while (page.paging && page.paging.next && n < maxPages) {
    const r = await fetch(page.paging.next);
    page = await r.json();
    if (page.error) throw new GraphError(friendly(page), r.status, page.error.code);
    out = out.concat(page.data || []);
    n++;
  }
  return out;
}

const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
// Quando a campanha não vende (leads, conversas no WhatsApp), o resultado dela vira a conversão principal
const LEAD_TYPES = ["onsite_conversion.lead_grouped", "lead", "offsite_conversion.fb_pixel_lead"];
const CHAT_TYPES = ["onsite_conversion.messaging_conversation_started_7d", "onsite_conversion.total_messaging_connection"];
function pick(list, types = PURCHASE_TYPES) {
  const map = {};
  for (const a of list || []) map[a.action_type] = num(a.value);
  for (const t of types) if (map[t] !== undefined) return map[t];
  return 0;
}
function result(actions) {
  const p = pick(actions);
  if (p > 0) return { n: p, kind: "compras" };
  const l = pick(actions, LEAD_TYPES);
  if (l > 0) return { n: l, kind: "leads" };
  const c = pick(actions, CHAT_TYPES);
  if (c > 0) return { n: c, kind: "conversas" };
  return { n: 0, kind: "compras" };
}
const ymd = d => d.toISOString().slice(0, 10);
function daysAgo(n) { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d; }

async function accounts(token) {
  const [me, list] = await Promise.all([
    graph("/me", { fields: "name" }, token),
    graphAll("/me/adaccounts", { fields: "account_id,name,account_status,currency", limit: 100 }, token, 3),
  ]);
  const STATUS = { 1: "Ativa", 2: "Desativada", 3: "Pagamento pendente", 7: "Em análise", 9: "Período de carência", 101: "Encerrada" };
  return {
    user: me.name || "",
    accounts: list.map(a => ({ id: "act_" + a.account_id, name: a.name || a.account_id, status: STATUS[a.account_status] || "Outro", active: a.account_status === 1, currency: a.currency || "BRL" }))
      .sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name, "pt-BR")),
  };
}

function dailySeries(P, rows) {
  const by = Object.fromEntries(rows.map(r => [r.date_start, r]));
  const out = [];
  for (let d = new Date(P.since + "T00:00:00Z"); ymd(d) <= P.until; d.setUTCDate(d.getUTCDate() + 1)) {
    const r = by[ymd(d)] || {};
    out.push({
      d: ymd(d), spend: Math.round(num(r.spend) * 100) / 100, impr: Math.round(num(r.impressions)), clicks: Math.round(num(r.clicks)),
      compras: Math.round(pick(r.actions)), leads: Math.round(pick(r.actions, LEAD_TYPES)), conversas: Math.round(pick(r.actions, CHAT_TYPES)),
      revenue: Math.round(pick(r.action_values) * 100) / 100,
    });
  }
  return out;
}

async function data(token, accountId, period) {
  const act = accountId.startsWith("act_") ? accountId : "act_" + accountId;
  const insFields = "campaign_id,campaign_name,spend,impressions,clicks,frequency,actions,action_values";
  const P = periodOf(period);

  const [info, camps, cur, last7, prev7, prev30, daily, acctDays, periodDays] = await Promise.all([
    graph("/" + act, { fields: "name,currency,account_status" }, token),
    graphAll("/" + act + "/campaigns", {
      fields: "id,name,effective_status,daily_budget,lifetime_budget,objective",
      filtering: [{ field: "effective_status", operator: "IN", value: ["ACTIVE", "PAUSED"] }],
      limit: 100,
    }, token, 5),
    graphAll("/" + act + "/insights", { level: "campaign", time_range: tr(P), fields: insFields, limit: 200 }, token, 5),
    graphAll("/" + act + "/insights", { level: "campaign", time_range: tr(P.w1), fields: "campaign_id,spend,action_values,actions", limit: 200 }, token, 5),
    graphAll("/" + act + "/insights", { level: "campaign", time_range: tr(P.w0), fields: "campaign_id,spend,action_values,actions", limit: 200 }, token, 5),
    graphAll("/" + act + "/insights", { level: "campaign", time_range: tr(P.prev), fields: "campaign_id,spend,impressions,clicks,actions,action_values", limit: 200 }, token, 5),
    // dia a dia das últimas 2 semanas do período, para o minigráfico da tabela de campanhas
    graphAll("/" + act + "/insights", { level: "campaign", time_range: tr(P.last14), time_increment: 1, fields: "campaign_id,spend,actions,action_values", limit: 500 }, token, 8).catch(() => []),
    // dia a dia da conta no último ano, só para saber a última data com veiculação
    graphAll("/" + act + "/insights", { level: "account", time_range: tr(P.year), time_increment: 1, fields: "spend", limit: 100 }, token, 4).catch(() => []),
    // dia a dia da conta no período, para a linha do tempo da visão geral
    graphAll("/" + act + "/insights", { level: "account", time_range: tr(P), time_increment: 1, fields: "spend,impressions,clicks,actions,action_values", limit: 100 }, token, 4).catch(() => null),
  ]);
  const lastSpend = acctDays.filter(r => num(r.spend) > 0).map(r => r.date_start).sort().pop() || null;
  const days14 = P.days14;
  const dailyBy = {};
  for (const r of daily) (dailyBy[r.campaign_id] = dailyBy[r.campaign_id] || {})[r.date_start] = r;

  const byId = Object.fromEntries(camps.map(c => [c.id, c]));
  const map7 = Object.fromEntries(last7.map(r => [r.campaign_id, r]));
  const mapP7 = Object.fromEntries(prev7.map(r => [r.campaign_id, r]));

  const campaigns = cur.filter(r => num(r.spend) > 0).map(r => {
    const c = byId[r.campaign_id] || {};
    const revenue = pick(r.action_values);
    const res = result(r.actions);
    // variação de 7 dias: receita quando há receita, senão investimento
    const a = map7[r.campaign_id], b = mapP7[r.campaign_id];
    const metric = x => x ? (revenue > 0 ? pick(x.action_values) : num(x.spend)) : 0;
    const m7 = metric(a), mp = metric(b);
    const d7 = mp > 0 ? (m7 - mp) / mp : 0;
    const dd = dailyBy[r.campaign_id] || {};
    return {
      id: "m" + r.campaign_id,
      name: r.campaign_name || c.name || r.campaign_id,
      ch: "meta",
      status: c.effective_status === "ACTIVE" ? "ativa" : "pausada",
      budget: c.daily_budget ? Math.round(num(c.daily_budget) / 100) : 0,
      spend: Math.round(num(r.spend) * 100) / 100,
      purchases: Math.round(res.n),
      result: res.kind,
      revenue: Math.round(revenue * 100) / 100,
      // campanha que não é de venda (leads, conversas, alcance) não é julgada pelo ROAS
      noRev: revenue === 0 && !/SALES|CONVERSIONS|PRODUCT_CATALOG/.test(c.objective || "") ? true : undefined,
      clicks: Math.round(num(r.clicks)),
      impr: Math.round(num(r.impressions)),
      freq: Math.round(num(r.frequency) * 10) / 10,
      d7: Math.max(-1, Math.min(5, Math.round(d7 * 100) / 100)),
      objective: c.objective || "",
      // mesma métrica da variação de 7 dias: receita quando a campanha vende, senão investimento
      daily: days14.map(d => Math.round(metric(dd[d]) * 100) / 100),
      dailyMetric: revenue > 0 ? "receita" : "investimento",
    };
  }).sort((a, b) => b.spend - a.spend);

  // período anterior somado por campanha; "tracked" é o investimento das campanhas que entram no ROAS
  const isSales = id => /SALES|CONVERSIONS|PRODUCT_CATALOG/.test((byId[id] || {}).objective || "");
  const prev = prev30.reduce((a, r) => {
    const rev = pick(r.action_values), sp = num(r.spend);
    return { spend: a.spend + sp, revenue: a.revenue + rev, purchases: a.purchases + result(r.actions).n, clicks: a.clicks + num(r.clicks), impr: a.impr + num(r.impressions), tracked: a.tracked + (rev > 0 || isSales(r.campaign_id) ? sp : 0) };
  }, { spend: 0, revenue: 0, purchases: 0, clicks: 0, impr: 0, tracked: 0 });
  // campanhas com status Ativa na Meta que não gastaram nada nos últimos 30 dias
  const spent = new Set(cur.filter(r => num(r.spend) > 0).map(r => r.campaign_id));
  const idleActive = camps.filter(c => c.effective_status === "ACTIVE" && !spent.has(c.id)).map(c => ({ id: c.id, name: c.name, objective: c.objective || "" }));
  return {
    account: { id: act, name: info.name || act, currency: info.currency || "BRL" },
    campaigns,
    idleActive,
    prev,
    period: { since: P.since, until: P.until, days: P.days },
    lastSpend,
    // um ponto por dia do período (dias sem veiculação vêm zerados); resultados separados por tipo
    days: periodDays ? dailySeries(P, periodDays) : null,
  };
}

// Quebras da conta nos últimos 30 dias: hora do dia, faixa etária, dispositivo e região.
// "kind" diz qual resultado contar (compras, leads ou conversas), para todas as quebras usarem o mesmo.
const REGION_PT = { "Federal District": "Distrito Federal", "Distrito Federal (state)": "Distrito Federal" };
const KIND_TYPES = { compras: PURCHASE_TYPES, leads: LEAD_TYPES, conversas: CHAT_TYPES };
const DEVICE = { iphone: "Celular", android_smartphone: "Celular", ipod: "Celular", mobile_web: "Celular", ipad: "Tablet", android_tablet: "Tablet", desktop: "Desktop" };
async function breakdowns(token, accountId, kind, period) {
  const P = periodOf(period);
  const act = accountId.startsWith("act_") ? accountId : "act_" + accountId;
  const types = KIND_TYPES[kind] || null;
  const q = b => graphAll("/" + act + "/insights", { level: "account", time_range: tr(P), breakdowns: b, fields: "spend,impressions,clicks,actions", limit: 500 }, token, 4)
    .then(rows => ({ ok: true, rows }), e => ({ ok: false, error: e.message }));
  const [hour, age, device, region] = await Promise.all([
    // hora do dia separada por data, para montar o mapa dia da semana x hora
    graphAll("/" + act + "/insights", { level: "account", time_range: tr(P), time_increment: 1, breakdowns: "hourly_stats_aggregated_by_advertiser_time_zone", fields: "spend,impressions,clicks,actions", limit: 500 }, token, 6)
      .then(rows => ({ ok: true, rows }), e => ({ ok: false, error: e.message })),
    q("age"), q("impression_device"), q("region")]);
  const row = r => ({ spend: num(r.spend), impr: num(r.impressions), clicks: num(r.clicks), results: types ? pick(r.actions, types) : result(r.actions).n });
  const group = (res, keyOf) => {
    if (!res.ok) return { error: res.error };
    const m = {};
    for (const r of res.rows) {
      const k = keyOf(r); if (!k) continue;
      const v = row(r), a = m[k] || (m[k] = { label: k, spend: 0, impr: 0, clicks: 0, results: 0 });
      a.spend += v.spend; a.impr += v.impr; a.clicks += v.clicks; a.results += v.results;
    }
    return { rows: Object.values(m) };
  };
  const hourOf = r => parseInt(String(r.hourly_stats_aggregated_by_advertiser_time_zone || "").slice(0, 2), 10);
  const hours = group(hour, r => String(hourOf(r)));
  // heat[dia da semana 0=domingo][hora] e quantos dias tiveram veiculação
  let heat = null, activeDays = 0;
  if (hour.ok) {
    heat = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ spend: 0, impr: 0, clicks: 0, results: 0 })));
    const days = new Set();
    for (const r of hour.rows) {
      const h = hourOf(r); if (!(h >= 0 && h < 24) || !r.date_start) continue;
      const v = row(r); if (v.spend > 0 || v.impr > 0) days.add(r.date_start);
      const c = heat[new Date(r.date_start + "T12:00:00Z").getUTCDay()][h];
      c.spend += v.spend; c.impr += v.impr; c.clicks += v.clicks; c.results += v.results;
    }
    activeDays = days.size;
  }
  if (hours.rows) {
    const by = Object.fromEntries(hours.rows.map(x => [x.label, x]));
    hours.rows = Array.from({ length: 24 }, (_, h) => by[String(h)] || { label: String(h), spend: 0, impr: 0, clicks: 0, results: 0 });
  }
  const ages = group(age, r => r.age && r.age !== "Unknown" ? r.age : null);
  if (ages.rows) ages.rows.sort((a, b) => a.label.localeCompare(b.label));
  const devices = group(device, r => DEVICE[r.impression_device] || "Outros");
  if (devices.rows) devices.rows.sort((a, b) => b.impr - a.impr);
  const regions = group(region, r => r.region && r.region !== "Unknown" ? (REGION_PT[r.region] || r.region.replace(/^State of /, "").replace(/ \(state\)$/, "")) : null);
  if (regions.rows) regions.rows.sort((a, b) => (b.results - a.results) || (b.spend - a.spend));
  return { kind: types ? kind : "resultados", hours, heat, activeDays, ages, devices, regions, period: { since: P.since, until: P.until, days: P.days } };
}

// Criativos: anúncios com investimento nos últimos 30 dias, com miniatura e sinais de fadiga
async function creatives(token, accountId, kind, period) {
  const P = periodOf(period);
  const act = accountId.startsWith("act_") ? accountId : "act_" + accountId;
  const types = KIND_TYPES[kind] || null;
  const base = { level: "ad", limit: 500 };
  const [cur, w1, w0] = await Promise.all([
    graphAll("/" + act + "/insights", { ...base, time_range: tr(P), fields: "ad_id,ad_name,campaign_id,campaign_name,spend,impressions,clicks,frequency,actions,action_values" }, token, 4),
    graphAll("/" + act + "/insights", { ...base, time_range: tr(P.w1), fields: "ad_id,impressions,clicks" }, token, 4).catch(() => []),
    graphAll("/" + act + "/insights", { ...base, time_range: tr(P.w0), fields: "ad_id,impressions,clicks" }, token, 4).catch(() => []),
  ]);
  const rows = cur.filter(r => num(r.spend) > 0).sort((a, b) => num(b.spend) - num(a.spend)).slice(0, 60);
  // detalhes do anúncio e do criativo, até 50 ids por chamada
  const det = {};
  for (let i = 0; i < rows.length; i += 50) {
    const ids = rows.slice(i, i + 50).map(r => r.ad_id).join(",");
    try {
      Object.assign(det, await graph("/", { ids, fields: "effective_status,creative.thumbnail_width(600).thumbnail_height(600){id,thumbnail_url,image_url,object_type,video_id,title,body,object_story_spec,asset_feed_spec}" }, token));
    } catch (e) {}
  }
  const by = list => Object.fromEntries(list.map(r => [r.ad_id, r]));
  const W1 = by(w1), W0 = by(w0);
  const ctrOf = r => r && num(r.impressions) >= 300 ? num(r.clicks) / num(r.impressions) : null;
  const ads = rows.map(r => {
    const d = det[r.ad_id] || {}, cr = d.creative || {};
    const spec = cr.object_story_spec || {};
    const isVideo = !!(cr.video_id || spec.video_data || cr.object_type === "VIDEO");
    const isCarousel = !!(spec.link_data && spec.link_data.child_attachments && spec.link_data.child_attachments.length > 1);
    const text = cr.title || (spec.link_data && (spec.link_data.name || spec.link_data.message)) || (spec.video_data && (spec.video_data.title || spec.video_data.message)) || cr.body || "";
    const impr = num(r.impressions);
    const a = ctrOf(W1[r.ad_id]), b = ctrOf(W0[r.ad_id]);
    return {
      id: r.ad_id, name: r.ad_name || r.ad_id, campaign: r.campaign_name || "", status: d.effective_status || "",
      format: isCarousel ? "Carrossel" : isVideo ? "Vídeo" : cr.object_type === "STATUS" ? "Post" : "Imagem",
      thumb: cr.image_url || cr.thumbnail_url || null, text: String(text).slice(0, 90),
      spend: num(r.spend), impr, clicks: num(r.clicks), freq: Math.round(num(r.frequency) * 10) / 10,
      results: types ? pick(r.actions, types) : result(r.actions).n, revenue: pick(r.action_values),
      hook: isVideo && impr > 0 ? pick(r.actions, ["video_view"]) / impr : null,
      ctrTrend: a != null && b != null && b > 0 ? Math.round((a - b) / b * 100) / 100 : null,
    };
  });
  return { ads, kind: types ? kind : "resultados", total: cur.filter(r => num(r.spend) > 0).length };
}

// Carteira da agência: todas as contas que o token acessa, com os números de cada uma.
// Usa campos aninhados (insights dentro de /me/adaccounts) para não fazer uma chamada por conta.
async function portfolio(token) {
  const met = "{spend,impressions,clicks,actions,action_values}";
  const tr = (a, b) => `insights.time_range(${JSON.stringify({ since: ymd(daysAgo(a)), until: ymd(daysAgo(b)) })})${met}`;
  const q = fields => graphAll("/me/adaccounts", { fields: "account_id," + fields, limit: 25 }, token, 4);
  const [base, w1, w0, yday, month] = await Promise.all([
    q("name,account_status,disable_reason,currency,business{name},insights.date_preset(last_30d)" + met),
    q("insights.date_preset(last_7d)" + met),
    q(tr(14, 8)),
    q("insights.date_preset(yesterday)" + met),
    q("insights.date_preset(this_month)" + met),
  ]);
  const ins = row => {
    const r = (row && row.insights && row.insights.data && row.insights.data[0]) || {};
    const res = result(r.actions);
    return { spend: num(r.spend), revenue: pick(r.action_values), purchases: res.n, result: res.kind, clicks: num(r.clicks), impr: num(r.impressions) };
  };
  const by = list => Object.fromEntries(list.map(a => [a.account_id, a]));
  const W1 = by(w1), W0 = by(w0), Y = by(yday), M = by(month);
  const STATUS = { 1: "Ativa", 2: "Desativada", 3: "Pagamento pendente", 7: "Em análise", 8: "Pagamento pendente", 9: "Período de carência", 100: "Encerramento pendente", 101: "Encerrada" };
  const REASON = { 1: "política de anúncios", 2: "revisão de propriedade intelectual", 3: "risco de pagamento", 5: "revisão de anúncios", 7: "encerramento definitivo", 8: "conta de revenda sem uso", 9: "conta sem uso" };
  const accounts = base.map(a => ({
    id: "act_" + a.account_id,
    name: a.name || a.account_id,
    status: a.account_status,
    statusLabel: STATUS[a.account_status] || "Outro",
    reason: REASON[a.disable_reason] || "",
    business: (a.business && a.business.name) || "",
    currency: a.currency || "BRL",
    m30: ins(a), w1: ins(W1[a.account_id]), w0: ins(W0[a.account_id]),
    yday: ins(Y[a.account_id]).spend, month: ins(M[a.account_id]).spend,
  })).sort((x, y) => (y.m30.spend - x.m30.spend) || x.name.localeCompare(y.name, "pt-BR"));
  return { accounts, truncated: base.length >= 100 };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST." });
  const token = String(req.headers["x-meta-token"] || "").trim();
  if (token.length < 20) return send(res, 400, { error: "Cole um token de acesso da Meta válido." });
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  try {
    if (body.action === "accounts") return send(res, 200, await accounts(token));
    if (body.action === "portfolio") return send(res, 200, await portfolio(token));
    if (body.action === "data") {
      if (!/^(act_)?\d{5,}$/.test(String(body.account_id || ""))) return send(res, 400, { error: "Escolha uma conta de anúncio." });
      return send(res, 200, await data(token, String(body.account_id), body.period));
    }
    if (body.action === "creatives") {
      if (!/^(act_)?\d{5,}$/.test(String(body.account_id || ""))) return send(res, 400, { error: "Escolha uma conta de anúncio." });
      return send(res, 200, await creatives(token, String(body.account_id), String(body.kind || ""), body.period));
    }
    if (body.action === "breakdowns") {
      if (!/^(act_)?\d{5,}$/.test(String(body.account_id || ""))) return send(res, 400, { error: "Escolha uma conta de anúncio." });
      return send(res, 200, await breakdowns(token, String(body.account_id), String(body.kind || ""), body.period));
    }
    return send(res, 400, { error: "Ação desconhecida." });
  } catch (e) {
    if (e instanceof GraphError) return send(res, e.status >= 400 && e.status < 600 ? e.status : 400, { error: e.message, code: e.code });
    return send(res, 502, { error: "Não consegui falar com a Meta agora. Tente de novo." });
  }
}
