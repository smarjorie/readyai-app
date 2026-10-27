// Cadastro de clientes no banco.
//
// Gestora (sessão admin):
//   { action: "list" }                                   -> { clients }
//   { action: "create", client: {...} }                   -> { client, invite: { sent, error?, link } }
//   { action: "update", id, patch }                       -> { client }
//   { action: "delete", id }                              -> { ok }
//   { action: "resend", id }                              -> { client, invite: { sent, error?, link } }
//   { action: "reset_password", id }                      -> { client, password }
//   { action: "import", clients: [...] }                  -> { imported, skipped, clients }
//   { action: "update", id, patch: { name?, email? } }    -> também troca nome e e-mail do responsável
//   { action: "add_user", id, user: { name, email } }     -> { client, invite }   segundo acesso, com convite
//   { action: "update_user", id, userId, patch }          -> { client }
//   { action: "resend_user", id, userId }                 -> { client, invite }
//   { action: "reset_user_password", id, userId }         -> { client, password }
//   { action: "remove_user", id, userId }                 -> { client }
// Cliente (sessão do próprio cliente):
//   { action: "self_update", patch: { conn?, ai?, targetRoas? } } -> { client }

import crypto from "node:crypto";
import {
  HttpError, send, readBody, fail, readSession,
  listClients, getClient, getClientByEmail, saveClient, deleteClient,
  newInvite, dropInvite, hashPassword, tempPassword, sendEmail, inviteEmail, appUrl, publicClient,
} from "./_store.js";

const PLANS = { starter: "Starter", pro: "Pro", scale: "Scale" };
// pacote padrão de cada plano (o mesmo do app); vale quando o cadastro chega sem a lista de módulos
const PLAN_MODULES = {
  starter: ["copilot", "overview", "campaigns"],
  pro: ["copilot", "overview", "analytics", "campaigns", "creatives", "report", "insights"],
  scale: ["portfolio", "copilot", "overview", "analytics", "campaigns", "creatives", "report", "insights", "skills"],
};
const MODULES = ["copilot", "overview", "analytics", "campaigns", "creatives", "report", "skills", "insights", "portfolio", "whatsapp"];
const STATUS = ["convite", "ativo", "suspenso"];
const isEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const txt = (v, max = 120) => String(v == null ? "" : v).trim().slice(0, max);

function cleanConn(conn) {
  if (!conn || typeof conn !== "object") return {};
  const out = {};
  if (conn.meta && typeof conn.meta === "object") out.meta = Object.fromEntries(Object.entries(conn.meta).filter(([k]) => ["token", "via", "accountId", "accountName", "user", "at"].includes(k)).map(([k, v]) => [k, txt(v, 600)]));
  if (conn.google && typeof conn.google === "object") out.google = Object.fromEntries(Object.entries(conn.google).filter(([k]) => ["slug", "customerId", "customerName", "refreshToken", "at"].includes(k)).map(([k, v]) => [k, txt(v, 600)]));
  return out;
}
// conexão da IA do cliente (Claude, ChatGPT ou Groq); null desconecta
function cleanAi(ai) {
  if (!ai || typeof ai !== "object") return null;
  if (!["anthropic", "openai", "groq"].includes(ai.provider)) return null;
  return { provider: ai.provider, key: txt(ai.key, 300), model: txt(ai.model, 100) };
}
function cleanRoas(v) { if (v === null || v === undefined || String(v).trim() === "") return null; const n = parseFloat(String(v).replace(",", ".")); return n > 0 && n < 100 ? Math.round(n * 100) / 100 : null; }

// campos que a gestora pode alterar
function applyAdminPatch(c, p) {
  if (p.company !== undefined) c.company = txt(p.company) || c.company;
  if (p.name !== undefined) c.name = txt(p.name) || c.name;
  if (p.plan !== undefined && PLANS[p.plan]) c.plan = p.plan;
  if (Array.isArray(p.modules) && p.modules.length) c.modules = [...new Set(p.modules.filter(m => MODULES.includes(m)))];
  else if (p.plan !== undefined && PLANS[p.plan] && !c.modules.length) c.modules = [...PLAN_MODULES[p.plan]];
  if (p.status !== undefined && STATUS.includes(p.status)) c.status = p.status;
  if (p.targetRoas !== undefined) c.targetRoas = cleanRoas(p.targetRoas); // meta é opcional: vazio ou null apaga
  if (p.conn !== undefined) c.conn = cleanConn(p.conn);
  if (p.ai !== undefined) c.ai = cleanAi(p.ai);
  return c;
}

// convite do responsável (u ausente) ou de um acesso extra (u)
async function inviteAndEmail(req, c, u) {
  const who = u || c;
  const token = await newInvite(c, u);
  const link = appUrl(req) + "/?convite=" + token;
  const mail = inviteEmail(c, link, PLANS[c.plan] || c.plan, u);
  const r = await sendEmail({ to: who.email, ...mail, key: "invite-" + who.invite.tokenHash.slice(0, 32) });
  who.invite = { ...who.invite, sentAt: new Date().toISOString(), sentTo: who.email, emailId: r.id || null, emailError: r.sent ? null : r.error };
  await saveClient(c);
  return { sent: r.sent, error: r.error || null, link };
}
const MAX_USERS = 5;
function mustUser(c, userId) {
  const u = (c.users || []).find(x => x.id === String(userId || ""));
  if (!u) throw new HttpError(404, "Esse acesso não existe mais.");
  return u;
}
// e-mail livre para uso (não pode ser de outro cliente nem de outro acesso)
async function emailFree(email, c, exceptSelf) {
  const lc = email.toLowerCase();
  if (lc === String(exceptSelf || "").toLowerCase()) return;
  if (lc === c.email.toLowerCase() || (c.users || []).some(u => u.email.toLowerCase() === lc)) throw new HttpError(409, "Esse e-mail já tem acesso a este cliente.");
  if (await getClientByEmail(email)) throw new HttpError(409, "Esse e-mail já é usado por outro cliente.");
}

async function mustGet(id) {
  const c = await getClient(String(id || ""));
  if (!c) throw new HttpError(404, "Cliente não encontrado. Ele pode ter sido excluído.");
  return c;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST." });
  const body = readBody(req);
  try {
    const s = readSession(req);
    if (!s) throw new HttpError(401, "Sessão expirada. Entre de novo.", "no_session");

    if (body.action === "self_update") {
      if (s.role !== "client") throw new HttpError(403, "Ação só para clientes.");
      const c = await mustGet(s.sub);
      const p = body.patch || {};
      if (p.conn !== undefined) c.conn = cleanConn(p.conn);
      if (p.ai !== undefined) c.ai = cleanAi(p.ai);
      if (p.targetRoas !== undefined) c.targetRoas = cleanRoas(p.targetRoas); // meta é opcional: vazio ou null apaga
      await saveClient(c);
      return send(res, 200, { client: publicClient(c) });
    }

    if (s.role !== "admin") throw new HttpError(403, "Só a gestora pode fazer isso.");

    if (body.action === "list") return send(res, 200, { clients: (await listClients()).map(publicClient) });

    if (body.action === "create") {
      const f = body.client || {};
      const email = txt(f.email).toLowerCase();
      if (!txt(f.company) || !txt(f.name) || !isEmail(email)) throw new HttpError(400, "Preencha empresa, nome e um e-mail válido.");
      if (await getClientByEmail(email)) throw new HttpError(409, "Já existe um cliente com esse e-mail.");
      const plan = PLANS[f.plan] ? f.plan : "pro";
      const now = new Date().toISOString();
      const c = applyAdminPatch({
        id: "cl" + crypto.randomBytes(6).toString("hex"), company: "", name: "", email, plan, modules: [], status: "convite",
        since: now.slice(0, 10), createdAt: now, lastAccess: null, targetRoas: null, conn: {}, invite: null,
      }, { company: f.company, name: f.name, plan, modules: f.modules, targetRoas: f.targetRoas });
      await saveClient(c);
      const invite = await inviteAndEmail(req, c);
      return send(res, 200, { client: publicClient(c), invite });
    }

    if (body.action === "update") {
      const c = await mustGet(body.id);
      const p = body.patch || {};
      let prev = null;
      if (p.email !== undefined) {
        const email = txt(p.email).toLowerCase();
        if (!isEmail(email)) throw new HttpError(400, "Informe um e-mail válido para o responsável.");
        if (email !== c.email.toLowerCase()) { await emailFree(email, c); prev = c.email; c.email = email; }
      }
      applyAdminPatch(c, p);
      await saveClient(c, prev);
      return send(res, 200, { client: publicClient(c) });
    }

    if (body.action === "add_user") {
      const c = await mustGet(body.id);
      const f = body.user || {};
      const email = txt(f.email).toLowerCase(), name = txt(f.name);
      if (!name || !isEmail(email)) throw new HttpError(400, "Preencha nome e um e-mail válido.");
      if ((c.users || []).length >= MAX_USERS) throw new HttpError(400, "Cada cliente pode ter até " + MAX_USERS + " acessos extras.");
      await emailFree(email, c);
      const u = { id: "u" + crypto.randomBytes(5).toString("hex"), name, email, status: "convite", createdAt: new Date().toISOString(), lastAccess: null, invite: null };
      c.users = [...(c.users || []), u];
      await saveClient(c);
      const invite = await inviteAndEmail(req, c, u);
      return send(res, 200, { client: publicClient(c), invite });
    }

    if (body.action === "update_user") {
      const c = await mustGet(body.id);
      const u = mustUser(c, body.userId);
      const p = body.patch || {};
      let prev = null;
      if (p.name !== undefined) u.name = txt(p.name) || u.name;
      if (p.email !== undefined) {
        const email = txt(p.email).toLowerCase();
        if (!isEmail(email)) throw new HttpError(400, "Informe um e-mail válido.");
        if (email !== u.email.toLowerCase()) { await emailFree(email, c); prev = u.email; u.email = email; }
      }
      await saveClient(c, prev);
      return send(res, 200, { client: publicClient(c) });
    }

    if (body.action === "resend_user") {
      const c = await mustGet(body.id);
      const u = mustUser(c, body.userId);
      if (u.passHash && u.invite && u.invite.acceptedAt) throw new HttpError(409, "Essa pessoa já aceitou o convite. Para trocar a senha, use Gerar senha temporária.");
      const invite = await inviteAndEmail(req, c, u);
      return send(res, 200, { client: publicClient(c), invite });
    }

    if (body.action === "reset_user_password") {
      const c = await mustGet(body.id);
      const u = mustUser(c, body.userId);
      const password = tempPassword();
      u.passHash = hashPassword(password);
      await saveClient(c);
      return send(res, 200, { client: publicClient(c), password });
    }

    if (body.action === "remove_user") {
      const c = await mustGet(body.id);
      const u = mustUser(c, body.userId);
      await dropInvite(u);
      c.users = (c.users || []).filter(x => x.id !== u.id);
      await saveClient(c, u.email);
      return send(res, 200, { client: publicClient(c) });
    }

    if (body.action === "delete") {
      const c = await mustGet(body.id);
      await deleteClient(c);
      return send(res, 200, { ok: true });
    }

    if (body.action === "resend") {
      const c = await mustGet(body.id);
      if (c.passHash && c.invite && c.invite.acceptedAt) throw new HttpError(409, "Esse cliente já aceitou o convite e criou a senha. Para trocar a senha, use Gerar senha temporária.");
      const invite = await inviteAndEmail(req, c);
      if (c.status === "ativo" && !c.passHash) { c.status = "convite"; await saveClient(c); }
      return send(res, 200, { client: publicClient(c), invite });
    }

    if (body.action === "reset_password") {
      const c = await mustGet(body.id);
      const password = tempPassword();
      c.passHash = hashPassword(password);
      await saveClient(c);
      return send(res, 200, { client: publicClient(c), password });
    }

    if (body.action === "import") {
      const list = Array.isArray(body.clients) ? body.clients.slice(0, 200) : [];
      let imported = 0, skipped = 0;
      for (const f of list) {
        const email = txt(f.email).toLowerCase();
        if (!isEmail(email) || !txt(f.company) || await getClientByEmail(email)) { skipped++; continue; }
        const now = new Date().toISOString();
        const c = applyAdminPatch({
          id: "cl" + crypto.randomBytes(6).toString("hex"), company: "", name: "", email, plan: PLANS[f.plan] ? f.plan : "pro", modules: [],
          status: "convite", since: /^\d{4}-\d{2}-\d{2}$/.test(f.since) ? f.since : now.slice(0, 10), createdAt: now, lastAccess: null, targetRoas: null, conn: {}, invite: null,
        }, { company: f.company, name: f.name || f.company, plan: f.plan, modules: f.modules, status: f.status, targetRoas: f.targetRoas, conn: f.conn });
        if (f.password) c.passHash = hashPassword(String(f.password));
        if (c.status === "ativo" && !c.passHash) c.status = "convite";
        await saveClient(c);
        imported++;
      }
      return send(res, 200, { imported, skipped, clients: (await listClients()).map(publicClient) });
    }

    throw new HttpError(400, "Ação desconhecida.");
  } catch (e) { return fail(res, e); }
}
