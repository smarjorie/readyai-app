// Meta Ads pela Marketing API (Graph API), no mesmo padrão do Traffiq.
// O token de acesso vem do navegador no header "x-meta-token" e só é usado nesta chamada.
//
// POST /api/meta  { action: "accounts" }                 -> contas de anúncio do token
// POST /api/meta  { action: "data", account_id: "act_" } -> campanhas dos últimos 30 dias, já no formato do painel
// POST /api/meta  { action: "breakdowns", account_id, kind } -> hora do dia, idade, dispositivo e região (30 dias)
// POST /api/meta  { action: "tree", account_id, campaign_id, kind, period } -> conjuntos e anúncios de uma campanha
// POST /api/meta  { action: "ad", account_id, ad_id, kind, period } -> um anúncio em detalhe, com links da postagem

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

// Status que a Meta usa para campanhas, conjuntos e anúncios
const STATUS_PT = {
  ACTIVE: "Ativa", PAUSED: "Pausada", ARCHIVED: "Arquivada", DELETED: "Excluída", IN_PROCESS: "Em processamento", WITH_ISSUES: "Com problemas",
  CAMPAIGN_PAUSED: "Campanha pausada", ADSET_PAUSED: "Conjunto pausado", PENDING_REVIEW: "Em análise", DISAPPROVED: "Reprovado",
  PREAPPROVED: "Pré-aprovado", PENDING_BILLING_INFO: "Pagamento pendente",
};
const isOn = s => s === "ACTIVE" || s === "IN_PROCESS" || s === "WITH_ISSUES";
// Listagem sem excluídas (a lista delas pode ser enorme), mas com arquivadas e com problemas
const LIST_CAMP = ["ACTIVE", "PAUSED", "ARCHIVED", "IN_PROCESS", "WITH_ISSUES"];
const LIST_CHILD = ["ACTIVE", "PAUSED", "CAMPAIGN_PAUSED", "ADSET_PAUSED", "ARCHIVED", "IN_PROCESS", "WITH_ISSUES", "PENDING_REVIEW", "DISAPPROVED", "PREAPPROVED", "PENDING_BILLING_INFO"];
// Nos insights entram também excluídas e arquivadas, para o gasto delas não sumir do total
const INS_CAMP = ["ACTIVE", "PAUSED", "DELETED", "ARCHIVED", "IN_PROCESS", "WITH_ISSUES"];
const INS_CHILD = [...LIST_CHILD, "DELETED"];

// Tenta com o filtro de status; se a Meta recusar o filtro, repete sem ele (melhor dado parcial do que tela vazia)
async function withStatus(path, params, token, pages, field, values) {
  try {
    return await graphAll(path, { ...params, filtering: [...(params.filtering || []), { field, operator: "IN", value: values }] }, token, pages);
  } catch (e) {
    if (e instanceof GraphError && (e.code === 190 || e.code === 17 || e.code === 4 || e.code === 613)) throw e;
    return graphAll(path, params, token, pages);
  }
}

function metrics(r, types) {
  r = r || {};
  const impr = num(r.impressions);
  return {
    spend: Math.round(num(r.spend) * 100) / 100, impr, clicks: num(r.clicks), reach: num(r.reach),
    freq: Math.round(num(r.frequency) * 10) / 10, linkClicks: num(r.inline_link_clicks),
    results: types ? pick(r.actions, types) : result(r.actions).n, revenue: Math.round(pick(r.action_values) * 100) / 100,
  };
}

// Campos do criativo que servem para miniatura, formato, texto e links da postagem
const CREATIVE_FIELDS = "creative.thumbnail_width(600).thumbnail_height(600){id,thumbnail_url,image_url,object_type,video_id,title,body,object_story_spec,asset_feed_spec,effective_object_story_id,instagram_permalink_url,call_to_action_type}";
const CTA_PT = { LEARN_MORE: "Saiba mais", SHOP_NOW: "Comprar agora", SIGN_UP: "Cadastre-se", CONTACT_US: "Fale conosco", WHATSAPP_MESSAGE: "Enviar mensagem no WhatsApp", MESSAGE_PAGE: "Enviar mensagem", SEND_MESSAGE: "Enviar mensagem", APPLY_NOW: "Inscreva-se", GET_QUOTE: "Pedir orçamento", SUBSCRIBE: "Assinar", DOWNLOAD: "Baixar", BOOK_TRAVEL: "Reservar", GET_OFFER: "Ver oferta", ORDER_NOW: "Pedir agora", CALL_NOW: "Ligar agora", NO_BUTTON: "" };

function shapeAd(d, act) {
  d = d || {};
  const cr = d.creative || {}, spec = cr.object_story_spec || {};
  const ld = spec.link_data || {}, vd = spec.video_data || {};
  const afs = cr.asset_feed_spec || {};
  const isVideo = !!(cr.video_id || spec.video_data || cr.object_type === "VIDEO" || (afs.videos && afs.videos.length));
  const isCarousel = !!(ld.child_attachments && ld.child_attachments.length > 1);
  const first = a => (Array.isArray(a) && a[0] && a[0].text) || "";
  const title = cr.title || ld.name || vd.title || first(afs.titles) || "";
  const body = cr.body || ld.message || vd.message || first(afs.bodies) || "";
  const story = cr.effective_object_story_id || "";
  const [pageId, postId] = story.split("_");
  const cta = (ld.call_to_action && ld.call_to_action.type) || (vd.call_to_action && vd.call_to_action.type) || cr.call_to_action_type || "";
  const ctaValue = (ld.call_to_action && ld.call_to_action.value) || (vd.call_to_action && vd.call_to_action.value) || {};
  const actNum = String(act || "").replace(/^act_/, "");
  return {
    format: isCarousel ? "Carrossel" : isVideo ? "Vídeo" : cr.object_type === "STATUS" ? "Post" : "Imagem",
    thumb: cr.image_url || cr.thumbnail_url || null,
    text: String(title || body).slice(0, 90),
    title: String(title).slice(0, 300), body: String(body).slice(0, 1200),
    cta: CTA_PT[cta] != null ? CTA_PT[cta] : cta.replace(/_/g, " ").toLowerCase(),
    dest: ctaValue.link || ld.link || "",
    links: {
      instagram: cr.instagram_permalink_url || null,
      facebook: pageId && postId ? "https://www.facebook.com/" + pageId + "/posts/" + postId : null,
      preview: d.preview_shareable_link || null,
      manager: actNum && d.id ? "https://adsmanager.facebook.com/adsmanager/manage/ads?act=" + actNum + "&selected_ad_ids=" + d.id : null,
    },
  };
}

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

// na conta inteira aparecem vários tipos do mesmo resultado (ex.: lead do formulário e lead do pixel);
// o maior deles é o total, como na soma das campanhas
function pickMax(list, types) {
  const map = {};
  for (const a of list || []) map[a.action_type] = num(a.value);
  return Math.max(0, ...types.map(t => map[t] || 0));
}
function dailySeries(P, rows) {
  const by = Object.fromEntries(rows.map(r => [r.date_start, r]));
  const out = [];
  for (let d = new Date(P.since + "T00:00:00Z"); ymd(d) <= P.until; d.setUTCDate(d.getUTCDate() + 1)) {
    const r = by[ymd(d)] || {};
    out.push({
      d: ymd(d), spend: Math.round(num(r.spend) * 100) / 100, impr: Math.round(num(r.impressions)), clicks: Math.round(num(r.clicks)),
      compras: Math.round(pickMax(r.actions, PURCHASE_TYPES)), leads: Math.round(pickMax(r.actions, LEAD_TYPES)), conversas: Math.round(pickMax(r.actions, CHAT_TYPES)),
      revenue: Math.round(pick(r.action_values) * 100) / 100,
    });
  }
  return out;
}

async function data(token, accountId, period) {
  const act = accountId.startsWith("act_") ? accountId : "act_" + accountId;
  const insFields = "campaign_id,campaign_name,spend,impressions,clicks,frequency,actions,action_values";
  const P = periodOf(period);

  // insights por campanha incluindo excluídas e arquivadas: sem isso o gasto delas some do total
  const insC = (range, fields, extra = {}, pages = 10) => withStatus("/" + act + "/insights", { level: "campaign", time_range: tr(range), fields, limit: 500, ...extra }, token, pages, "campaign.effective_status", INS_CAMP);
  const [info, camps, cur, last7, prev7, prev30, daily, acctDays, periodDays, adsets] = await Promise.all([
    graph("/" + act, { fields: "name,currency,account_status" }, token),
    withStatus("/" + act + "/campaigns", { fields: "id,name,effective_status,daily_budget,lifetime_budget,objective,stop_time", limit: 200 }, token, 10, "effective_status", LIST_CAMP),
    insC(P, insFields),
    insC(P.w1, "campaign_id,spend,action_values,actions"),
    insC(P.w0, "campaign_id,spend,action_values,actions"),
    insC(P.prev, "campaign_id,spend,impressions,clicks,actions,action_values"),
    // dia a dia das últimas 2 semanas do período, para o minigráfico da tabela de campanhas
    insC(P.last14, "campaign_id,spend,actions,action_values", { time_increment: 1 }, 12).catch(() => []),
    // dia a dia da conta no último ano, só para saber a última data com veiculação
    graphAll("/" + act + "/insights", { level: "account", time_range: tr(P.year), time_increment: 1, fields: "spend", limit: 100 }, token, 4).catch(() => []),
    // dia a dia da conta no período, para a linha do tempo da visão geral
    graphAll("/" + act + "/insights", { level: "account", time_range: tr(P), time_increment: 1, fields: "spend,impressions,clicks,actions,action_values", limit: 100 }, token, 4).catch(() => null),
    // conjuntos ativos, para somar o orçamento das campanhas com orçamento no conjunto (ABO)
    graphAll("/" + act + "/adsets", { fields: "campaign_id,daily_budget,lifetime_budget", filtering: [{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }], limit: 500 }, token, 6).catch(() => []),
  ]);
  const adsetBudget = {};
  for (const s of adsets) adsetBudget[s.campaign_id] = (adsetBudget[s.campaign_id] || 0) + num(s.daily_budget);
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
      // campanha excluída não aparece na listagem; o status dela vem só dos insights
      status: isOn(c.effective_status) ? "ativa" : "pausada",
      metaStatus: c.effective_status || "DELETED",
      statusLabel: STATUS_PT[c.effective_status || "DELETED"] || c.effective_status,
      budget: c.daily_budget ? Math.round(num(c.daily_budget) / 100) : Math.round((adsetBudget[r.campaign_id] || 0) / 100),
      budgetLevel: c.daily_budget || c.lifetime_budget ? "campanha" : adsetBudget[r.campaign_id] ? "conjunto" : "",
      lifetimeBudget: c.lifetime_budget ? Math.round(num(c.lifetime_budget) / 100) : undefined,
      metaId: r.campaign_id,
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
  // todas as outras campanhas da conta (sem gasto no período), com o status de cada uma
  const others = camps.filter(c => !spent.has(c.id)).map(c => ({
    id: c.id, name: c.name, objective: c.objective || "", metaStatus: c.effective_status, statusLabel: STATUS_PT[c.effective_status] || c.effective_status, on: isOn(c.effective_status),
    budget: c.daily_budget ? Math.round(num(c.daily_budget) / 100) : Math.round((adsetBudget[c.id] || 0) / 100),
  })).sort((a, b) => (b.on - a.on) || a.name.localeCompare(b.name, "pt-BR"));
  // conferência: a soma das campanhas tem que bater com o gasto da conta inteira no período
  const campSpend = Math.round(campaigns.reduce((a, c) => a + c.spend, 0) * 100) / 100;
  const acctSpend = periodDays ? Math.round(periodDays.reduce((a, r) => a + num(r.spend), 0) * 100) / 100 : null;
  const byStatus = {};
  for (const c of camps) byStatus[c.effective_status] = (byStatus[c.effective_status] || 0) + 1;
  const deletedWithSpend = campaigns.filter(c => c.metaStatus === "DELETED").length;
  const coverage = {
    listed: camps.length + deletedWithSpend, withSpend: campaigns.length, withoutSpend: others.length, byStatus, deletedWithSpend,
    campSpend, acctSpend, diff: acctSpend == null ? null : Math.round((acctSpend - campSpend) * 100) / 100,
    ok: acctSpend == null ? null : Math.abs(acctSpend - campSpend) <= Math.max(1, acctSpend * 0.005),
  };
  return {
    account: { id: act, name: info.name || act, currency: info.currency || "BRL" },
    campaigns,
    idleActive,
    others,
    coverage,
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
  const insA = (range, fields, pages) => withStatus("/" + act + "/insights", { ...base, time_range: tr(range), fields }, token, pages, "ad.effective_status", INS_CHILD);
  const [cur, w1, w0] = await Promise.all([
    insA(P, "ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,spend,impressions,clicks,frequency,actions,action_values", 6),
    insA(P.w1, "ad_id,impressions,clicks", 6).catch(() => []),
    insA(P.w0, "ad_id,impressions,clicks", 6).catch(() => []),
  ]);
  const rows = cur.filter(r => num(r.spend) > 0).sort((a, b) => num(b.spend) - num(a.spend)).slice(0, 120);
  const det = await adDetails(rows.map(r => r.ad_id), token);
  const by = list => Object.fromEntries(list.map(r => [r.ad_id, r]));
  const W1 = by(w1), W0 = by(w0);
  const ctrOf = r => r && num(r.impressions) >= 300 ? num(r.clicks) / num(r.impressions) : null;
  const ads = rows.map(r => {
    const d = det[r.ad_id] || {};
    const s = shapeAd({ ...d, id: r.ad_id }, act);
    const impr = num(r.impressions);
    const a = ctrOf(W1[r.ad_id]), b = ctrOf(W0[r.ad_id]);
    return {
      id: r.ad_id, name: r.ad_name || r.ad_id, campaign: r.campaign_name || "", campaignId: r.campaign_id, adset: r.adset_name || "", adsetId: r.adset_id,
      status: d.effective_status || "DELETED", statusLabel: STATUS_PT[d.effective_status || "DELETED"] || d.effective_status,
      format: s.format, thumb: s.thumb, text: s.text, links: s.links,
      spend: num(r.spend), impr, clicks: num(r.clicks), freq: Math.round(num(r.frequency) * 10) / 10,
      results: types ? pick(r.actions, types) : result(r.actions).n, revenue: pick(r.action_values),
      hook: s.format === "Vídeo" && impr > 0 ? pick(r.actions, ["video_view"]) / impr : null,
      ctrTrend: a != null && b != null && b > 0 ? Math.round((a - b) / b * 100) / 100 : null,
    };
  });
  return { ads, kind: types ? kind : "resultados", total: cur.filter(r => num(r.spend) > 0).length };
}

// detalhes do anúncio e do criativo, até 50 ids por chamada
async function adDetails(ids, token) {
  const det = {};
  const chunks = [];
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50).join(","));
  await Promise.all(chunks.map(c => graph("/", { ids: c, fields: "effective_status,preview_shareable_link," + CREATIVE_FIELDS }, token)
    .then(r => Object.assign(det, r), () => {})));
  return det;
}

// Uma campanha aberta em níveis: conjuntos de anúncios e anúncios, com os números do período.
// Traz todos os conjuntos e anúncios da campanha, inclusive os que não gastaram.
async function tree(token, accountId, campaignId, kind, period) {
  const P = periodOf(period);
  const act = accountId.startsWith("act_") ? accountId : "act_" + accountId;
  const types = KIND_TYPES[kind] || null;
  const mf = "spend,impressions,clicks,reach,frequency,inline_link_clicks,actions,action_values";
  const [camp, setsMeta, adsMeta, setsIns, adsIns] = await Promise.all([
    graph("/" + campaignId, { fields: "id,name,effective_status,objective,daily_budget,lifetime_budget,bid_strategy" }, token),
    withStatus("/" + campaignId + "/adsets", { fields: "id,name,effective_status,daily_budget,lifetime_budget,optimization_goal,end_time", limit: 200 }, token, 5, "effective_status", LIST_CHILD),
    withStatus("/" + campaignId + "/ads", { fields: "id,name,adset_id,effective_status,preview_shareable_link," + CREATIVE_FIELDS, limit: 100 }, token, 6, "effective_status", LIST_CHILD),
    withStatus("/" + campaignId + "/insights", { level: "adset", time_range: tr(P), fields: "adset_id,adset_name," + mf, limit: 500 }, token, 4, "adset.effective_status", INS_CHILD),
    withStatus("/" + campaignId + "/insights", { level: "ad", time_range: tr(P), fields: "ad_id,ad_name,adset_id," + mf, limit: 500 }, token, 6, "ad.effective_status", INS_CHILD),
  ]);
  const SI = Object.fromEntries(setsIns.map(r => [r.adset_id, r]));
  const AI = Object.fromEntries(adsIns.map(r => [r.ad_id, r]));
  // anúncio excluído que gastou no período: aparece só nos insights
  const adRows = adsMeta.map(a => ({ meta: a, ins: AI[a.id] }));
  const known = new Set(adsMeta.map(a => a.id));
  for (const r of adsIns) if (!known.has(r.ad_id) && num(r.spend) > 0) adRows.push({ meta: { id: r.ad_id, name: r.ad_name, adset_id: r.adset_id, effective_status: "DELETED" }, ins: r });
  const ads = adRows.map(({ meta: a, ins }) => {
    const s = shapeAd(a, act), m = metrics(ins, types);
    return {
      id: a.id, name: a.name || (ins && ins.ad_name) || a.id, adsetId: a.adset_id, campaign: camp.name || "", campaignId,
      status: a.effective_status, statusLabel: STATUS_PT[a.effective_status] || a.effective_status, on: isOn(a.effective_status),
      format: s.format, thumb: s.thumb, text: s.text, links: s.links, ...m,
      hook: s.format === "Vídeo" && m.impr > 0 && ins ? pick(ins.actions, ["video_view"]) / m.impr : null,
    };
  }).sort((a, b) => (b.spend - a.spend) || (b.on - a.on));
  const setRows = setsMeta.map(s => ({ meta: s, ins: SI[s.id] }));
  const knownS = new Set(setsMeta.map(s => s.id));
  for (const r of setsIns) if (!knownS.has(r.adset_id) && num(r.spend) > 0) setRows.push({ meta: { id: r.adset_id, name: r.adset_name, effective_status: "DELETED" }, ins: r });
  const adsets = setRows.map(({ meta: s, ins }) => {
    const mine = ads.filter(a => a.adsetId === s.id);
    return {
      id: s.id, name: s.name || s.id, status: s.effective_status, statusLabel: STATUS_PT[s.effective_status] || s.effective_status, on: isOn(s.effective_status),
      budget: s.daily_budget ? Math.round(num(s.daily_budget) / 100) : 0, lifetimeBudget: s.lifetime_budget ? Math.round(num(s.lifetime_budget) / 100) : 0,
      goal: s.optimization_goal || "", ads: mine.length, adsOn: mine.filter(a => a.on).length, ...metrics(ins, types),
    };
  }).sort((a, b) => (b.spend - a.spend) || (b.on - a.on));
  return {
    campaign: {
      id: camp.id, name: camp.name, status: camp.effective_status, statusLabel: STATUS_PT[camp.effective_status] || camp.effective_status, objective: camp.objective || "",
      budget: camp.daily_budget ? Math.round(num(camp.daily_budget) / 100) : 0, budgetLevel: camp.daily_budget || camp.lifetime_budget ? "campanha" : "conjunto",
    },
    adsets, ads, kind: types ? kind : "resultados", period: { since: P.since, until: P.until, days: P.days },
  };
}

// Um anúncio em detalhe, para a barra lateral: textos, links da postagem e números do período, inclusive vídeo e dia a dia
async function adDetail(token, accountId, adId, kind, period) {
  const P = periodOf(period);
  const act = accountId.startsWith("act_") ? accountId : "act_" + accountId;
  const types = KIND_TYPES[kind] || null;
  const vid = "video_p25_watched_actions,video_p50_watched_actions,video_p75_watched_actions,video_p100_watched_actions,video_thruplay_watched_actions,video_avg_time_watched_actions";
  const base = "spend,impressions,reach,frequency,clicks,inline_link_clicks,cpm,actions,action_values";
  const [ad, tot, days, review] = await Promise.all([
    graph("/" + adId, { fields: "id,name,effective_status,created_time,preview_shareable_link,adset{id,name,optimization_goal},campaign{id,name,objective}," + CREATIVE_FIELDS }, token),
    graph("/" + adId + "/insights", { time_range: tr(P), fields: base + "," + vid }, token).catch(() => graph("/" + adId + "/insights", { time_range: tr(P), fields: base }, token)).catch(() => ({ data: [] })),
    graphAll("/" + adId + "/insights", { time_range: tr(P), time_increment: 1, fields: "spend,impressions,clicks,actions,action_values", limit: 100 }, token, 4).catch(() => []),
    // motivo de reprovação ou problema de veiculação, quando houver
    graph("/" + adId, { fields: "issues_info,ad_review_feedback" }, token).catch(() => ({})),
  ]);
  const r = (tot.data && tot.data[0]) || {};
  const s = shapeAd(ad, act), m = metrics(r, types);
  const v = k => pick(r[k], ["video_view"]);
  const isVideo = s.format === "Vídeo";
  const by = Object.fromEntries(days.map(x => [x.date_start, x]));
  const series = [];
  for (let d = new Date(P.since + "T00:00:00Z"); ymd(d) <= P.until; d.setUTCDate(d.getUTCDate() + 1)) {
    const x = by[ymd(d)] || {};
    series.push({ d: ymd(d), spend: num(x.spend), impr: num(x.impressions), clicks: num(x.clicks), results: types ? pick(x.actions, types) : result(x.actions).n });
  }
  const issues = [];
  for (const i of review.issues_info || []) if (i.error_message || i.error_summary) issues.push(i.error_summary || i.error_message);
  const fb = review.ad_review_feedback || {};
  for (const grp of [fb.global, fb.placement_specific].filter(Boolean)) for (const k of Object.keys(grp)) issues.push(typeof grp[k] === "string" ? grp[k] : k);
  return {
    id: ad.id, name: ad.name, status: ad.effective_status, statusLabel: STATUS_PT[ad.effective_status] || ad.effective_status, created: ad.created_time || null,
    adset: ad.adset ? { id: ad.adset.id, name: ad.adset.name, goal: ad.adset.optimization_goal || "" } : null,
    campaign: ad.campaign ? { id: ad.campaign.id, name: ad.campaign.name, objective: ad.campaign.objective || "" } : null,
    ...s, ...m, cpm: num(r.cpm), kind: types ? kind : "resultados",
    video: isVideo && m.impr > 0 ? {
      hook: pick(r.actions, ["video_view"]) / m.impr,
      p25: v("video_p25_watched_actions"), p50: v("video_p50_watched_actions"), p75: v("video_p75_watched_actions"), p100: v("video_p100_watched_actions"),
      thruplay: v("video_thruplay_watched_actions"), avg: v("video_avg_time_watched_actions"), plays: pick(r.actions, ["video_view"]),
    } : null,
    series, issues: [...new Set(issues)].slice(0, 5),
    period: { since: P.since, until: P.until, days: P.days },
  };
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
    if (body.action === "tree") {
      if (!/^(act_)?\d{5,}$/.test(String(body.account_id || ""))) return send(res, 400, { error: "Escolha uma conta de anúncio." });
      if (!/^\d{5,}$/.test(String(body.campaign_id || ""))) return send(res, 400, { error: "Campanha inválida." });
      return send(res, 200, await tree(token, String(body.account_id), String(body.campaign_id), String(body.kind || ""), body.period));
    }
    if (body.action === "ad") {
      if (!/^(act_)?\d{5,}$/.test(String(body.account_id || ""))) return send(res, 400, { error: "Escolha uma conta de anúncio." });
      if (!/^\d{5,}$/.test(String(body.ad_id || ""))) return send(res, 400, { error: "Anúncio inválido." });
      return send(res, 200, await adDetail(token, String(body.account_id), String(body.ad_id), String(body.kind || ""), body.period));
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
