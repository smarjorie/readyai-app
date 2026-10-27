// Base do servidor: banco (Upstash Redis via REST), sessões, senhas e e-mail (Resend).
// Arquivos que começam com "_" dentro de api/ não viram rota na Vercel.
import crypto from "node:crypto";

// ---------- banco ----------
// A integração Upstash da Vercel cria KV_REST_API_URL e KV_REST_API_TOKEN (ou UPSTASH_REDIS_REST_*).
const KV_URL = () => (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const KV_TOKEN = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
export const dbReady = () => !!(KV_URL() && KV_TOKEN());
export const emailReady = () => !!process.env.RESEND_API_KEY;

export class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

async function kv(path, body) {
  if (!dbReady()) throw new HttpError(503, "O banco de dados não está configurado. Conecte o Upstash Redis ao projeto na Vercel.", "no_db");
  let r;
  try {
    r = await fetch(KV_URL() + path, { method: "POST", headers: { authorization: "Bearer " + KV_TOKEN(), "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) { throw new HttpError(503, "Não consegui falar com o banco de dados agora. Tente de novo.", "db_down"); }
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) throw new HttpError(503, "O banco de dados respondeu com erro (" + r.status + ").", "db_error");
  return j;
}
export async function cmd(...args) { const j = await kv("", args); if (j.error) throw new HttpError(503, "Erro no banco: " + j.error, "db_error"); return j.result; }
export async function pipe(cmds) {
  if (!cmds.length) return [];
  const j = await kv("/pipeline", cmds);
  return j.map(x => { if (x.error) throw new HttpError(503, "Erro no banco: " + x.error, "db_error"); return x.result; });
}

// Prefixo próprio do app: o servidor MCP da ReadyAI usa "readyai:" no mesmo tipo de banco,
// então os dois projetos podem dividir o mesmo Upstash sem misturar os cadastros.
const P = process.env.KV_PREFIX || "readyai-app:";
const K = {
  ids: P + "clients",
  client: id => P + "client:" + id,
  email: e => P + "email:" + e.toLowerCase(),
  invite: h => P + "invite:" + h,
};

export async function getClient(id) { const v = await cmd("GET", K.client(id)); return v ? JSON.parse(v) : null; }
// o índice de e-mail aponta para "idDoCliente" (responsável) ou "idDoCliente#idDoUsuario" (acesso extra)
export async function getClientByEmail(email) { const v = await cmd("GET", K.email(email)); return v ? getClient(String(v).split("#")[0]) : null; }
export async function findLogin(email) {
  const v = await cmd("GET", K.email(email));
  if (!v) return null;
  const [cid, uid] = String(v).split("#");
  const c = await getClient(cid);
  if (!c) return null;
  const u = uid ? (c.users || []).find(x => x.id === uid) || null : null;
  if (uid && !u) return null;
  return { c, u };
}
export async function listClients() {
  const ids = await cmd("SMEMBERS", K.ids) || [];
  if (!ids.length) return [];
  const vals = await pipe(ids.map(id => ["GET", K.client(id)]));
  return vals.filter(Boolean).map(v => JSON.parse(v)).sort((a, b) => String(b.createdAt || b.since).localeCompare(String(a.createdAt || a.since)));
}
// prevEmails: e-mails que deixaram de valer (troca de e-mail ou acesso removido)
export async function saveClient(c, prevEmails) {
  const cmds = [["SET", K.client(c.id), JSON.stringify(c)], ["SADD", K.ids, c.id], ["SET", K.email(c.email), c.id]];
  for (const u of c.users || []) cmds.push(["SET", K.email(u.email), c.id + "#" + u.id]);
  const current = new Set([c.email, ...(c.users || []).map(u => u.email)].map(e => e.toLowerCase()));
  for (const e of [].concat(prevEmails || [])) if (e && !current.has(e.toLowerCase())) cmds.push(["DEL", K.email(e)]);
  await pipe(cmds);
  return c;
}
export async function deleteClient(c) {
  const cmds = [["DEL", K.client(c.id)], ["SREM", K.ids, c.id], ["DEL", K.email(c.email)]];
  if (c.invite && c.invite.tokenHash) cmds.push(["DEL", K.invite(c.invite.tokenHash)]);
  for (const u of c.users || []) {
    cmds.push(["DEL", K.email(u.email)]);
    if (u.invite && u.invite.tokenHash) cmds.push(["DEL", K.invite(u.invite.tokenHash)]);
  }
  await pipe(cmds);
}

// ---------- convites ----------
const INVITE_DAYS = 7;
export const sha256 = s => crypto.createHash("sha256").update(String(s)).digest("hex");
// convite do responsável (u ausente) ou de um acesso extra (u)
export async function newInvite(c, u) {
  const who = u || c;
  const token = crypto.randomBytes(24).toString("base64url");
  const tokenHash = sha256(token);
  const cmds = [["SET", K.invite(tokenHash), u ? c.id + "#" + u.id : c.id, "EX", String(INVITE_DAYS * 86400)]];
  if (who.invite && who.invite.tokenHash) cmds.push(["DEL", K.invite(who.invite.tokenHash)]); // o link anterior deixa de valer
  await pipe(cmds);
  who.invite = { ...(who.invite || {}), tokenHash, expiresAt: new Date(Date.now() + INVITE_DAYS * 86400e3).toISOString(), acceptedAt: null };
  return token;
}
export async function inviteTarget(token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ""))) return null;
  const v = await cmd("GET", K.invite(sha256(token)));
  if (!v) return null;
  const [cid, uid] = String(v).split("#");
  const c = await getClient(cid);
  if (!c) return null;
  const u = uid ? (c.users || []).find(x => x.id === uid) || null : null;
  if (uid && !u) return null;
  return { c, u };
}
export async function clientByInvite(token) { const t = await inviteTarget(token); return t ? t.c : null; }
export async function dropInvite(who) { if (who && who.invite && who.invite.tokenHash) await cmd("DEL", K.invite(who.invite.tokenHash)); }

// ---------- senhas ----------
export function hashPassword(p) {
  const salt = crypto.randomBytes(16).toString("hex");
  return "scrypt$" + salt + "$" + crypto.scryptSync(String(p), salt, 32).toString("hex");
}
export function checkPassword(p, stored) {
  if (!stored || !stored.startsWith("scrypt$")) return false;
  const [, salt, hash] = stored.split("$");
  const got = crypto.scryptSync(String(p), salt, 32);
  return crypto.timingSafeEqual(got, Buffer.from(hash, "hex"));
}
export function tempPassword() {
  const c = "abcdefghjkmnpqrstuvwxyz23456789"; let s = "";
  for (const b of crypto.randomBytes(10)) s += c[b % c.length];
  return s;
}

// ---------- admin ----------
// Pode ser trocado pelas variáveis ADMIN_EMAIL e ADMIN_PASSWORD na Vercel.
const ADMIN_EMAIL = () => (process.env.ADMIN_EMAIL || "admin@readyai.com").toLowerCase();
const ADMIN_HASH = "23268d8add1b0d5ea444ebd1c193c553f3bed9a6893066c962658876eb9df72c";
export const ADMIN_NAME = () => process.env.ADMIN_NAME || "Sarah Machado";
export function isAdminLogin(email, pass) {
  if (String(email).toLowerCase() !== ADMIN_EMAIL()) return false;
  if (process.env.ADMIN_PASSWORD) return crypto.timingSafeEqual(Buffer.from(sha256(pass)), Buffer.from(sha256(process.env.ADMIN_PASSWORD)));
  return sha256(pass) === ADMIN_HASH;
}
export const adminEmail = ADMIN_EMAIL;

// ---------- sessões (token assinado, sem estado) ----------
const SECRET = () => process.env.SESSION_SECRET || sha256("readyai-session:" + KV_TOKEN());
const SESSION_DAYS = 14;
export function signSession(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + SESSION_DAYS * 86400e3 })).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET()).update(body).digest("base64url");
  return body + "." + sig;
}
export function readSession(req) {
  const h = String(req.headers.authorization || "");
  const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  const [body, sig] = tok.split(".");
  if (!body || !sig) return null;
  const want = crypto.createHmac("sha256", SECRET()).update(body).digest("base64url");
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try { const p = JSON.parse(Buffer.from(body, "base64url").toString()); return p.exp > Date.now() ? p : null; } catch (e) { return null; }
}

// ---------- e-mail (Resend) ----------
const FROM = () => process.env.RESEND_FROM || "ReadyAI <onboarding@resend.dev>";
export async function sendEmail({ to, subject, html, text, key }) {
  if (!emailReady()) return { sent: false, error: "E-mail não configurado (falta RESEND_API_KEY na Vercel)." };
  let r;
  try {
    r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: "Bearer " + process.env.RESEND_API_KEY, "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      body: JSON.stringify({ from: FROM(), to: [to], subject, html, text, ...(process.env.RESEND_REPLY_TO ? { reply_to: process.env.RESEND_REPLY_TO } : {}) }),
    });
  } catch (e) { return { sent: false, error: "Não consegui falar com o Resend." }; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j.message || j.error || ("erro " + r.status);
    if (r.status === 403 && /resend\.dev|verify|domain/i.test(msg)) return { sent: false, error: "O Resend só entrega para o seu próprio e-mail enquanto o domínio não estiver verificado. Verifique um domínio no Resend e configure RESEND_FROM." };
    if (r.status === 401) return { sent: false, error: "A chave do Resend (RESEND_API_KEY) foi recusada." };
    return { sent: false, error: "O Resend recusou o envio: " + msg };
  }
  return { sent: true, id: j.id };
}

const esc = s => String(s || "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
export function inviteEmail(c, link, planName, u) {
  const first = String((u || c).name || "").split(" ")[0] || "Olá";
  const exp = new Date((u || c).invite.expiresAt).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const subject = `Seu acesso à ReadyAI (${c.company})`;
  const text = `${first}, você foi convidado(a) para acessar a ReadyAI como ${c.company} (plano ${planName}).\n\nCrie sua senha e entre pelo link abaixo:\n${link}\n\nO link vale até ${exp}. Se você não esperava este convite, ignore este e-mail.`;
  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#111827">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e6e8ec;border-radius:14px">
<tr><td style="padding:28px 28px 8px"><div style="font-size:18px;font-weight:700">Ready<span style="color:#1e6bff">AI</span></div>
<div style="font-size:12px;color:#6b7280">Assistente de Marketing</div></td></tr>
<tr><td style="padding:12px 28px 4px"><h1 style="font-size:20px;line-height:1.3;margin:0 0 10px">${esc(first)}, seu acesso está pronto</h1>
<p style="font-size:14px;line-height:1.6;color:#4b5563;margin:0 0 18px">Você foi convidado(a) para acessar a ReadyAI como <b style="color:#111827">${esc(c.company)}</b>, no plano ${esc(planName)}. Crie sua senha para entrar no painel e conectar suas contas de anúncio.</p>
<a href="${esc(link)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 20px;border-radius:10px">Aceitar convite e criar senha</a>
<p style="font-size:12px;line-height:1.6;color:#6b7280;margin:18px 0 0">O link vale até ${esc(exp)}. Se o botão não funcionar, copie e cole este endereço no navegador:<br><span style="word-break:break-all;color:#1557e0">${esc(link)}</span></p></td></tr>
<tr><td style="padding:18px 28px 26px"><p style="font-size:12px;color:#9aa3b1;margin:0">Se você não esperava este convite, ignore este e-mail.</p></td></tr>
</table></td></tr></table></body></html>`;
  return { subject, html, text };
}

export function appUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000";
  const proto = req.headers["x-forwarded-proto"] || (String(host).startsWith("localhost") ? "http" : "https");
  return proto + "://" + host;
}

// o que o navegador recebe: nunca o hash da senha nem o do convite
export function publicClient(c) {
  if (!c) return null;
  const { passHash, ...rest } = c;
  if (rest.invite) { const { tokenHash, ...inv } = rest.invite; rest.invite = inv; }
  rest.hasPassword = !!passHash;
  rest.users = (c.users || []).map(u => {
    const { passHash: ph, ...ru } = u;
    if (ru.invite) { const { tokenHash, ...inv } = ru.invite; ru.invite = inv; }
    ru.hasPassword = !!ph;
    return ru;
  });
  return rest;
}

export function send(res, status, body) {
  res.status(status).setHeader("Cache-Control", "no-store");
  res.json(body);
}
export function readBody(req) { return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {}; }
export function fail(res, e) {
  if (e instanceof HttpError) return send(res, e.status, { error: e.message, code: e.code });
  console.error(e);
  return send(res, 500, { error: "Erro inesperado no servidor. Tente de novo." });
}
