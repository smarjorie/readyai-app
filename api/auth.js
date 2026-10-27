// Login, sessão e aceite de convite.
//
// POST /api/auth { action: "status" }                      -> { db, email }  (o app usa para saber se há banco)
// POST /api/auth { action: "login", email, password }      -> { token, role, client? }
// POST /api/auth { action: "me" }            (Bearer)      -> { role, client?, admin? }
// POST /api/auth { action: "invite_info", token }          -> { company, name, email, plan }
// POST /api/auth { action: "accept", token, password }     -> { token, role, client }

import {
  dbReady, emailReady, HttpError, send, readBody, fail,
  getClient, findLogin, saveClient, inviteTarget, dropInvite,
  hashPassword, checkPassword, isAdminLogin, adminEmail, ADMIN_NAME,
  signSession, readSession, publicClient, sendEmail,
} from "./_store.js";

const BAD_LOGIN = "E-mail ou senha incorretos. Confira os dados e tente de novo.";
const PLAN_NAMES = { starter: "Starter", pro: "Pro", scale: "Scale" };

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST." });
  const body = readBody(req);
  try {
    if (body.action === "status") return send(res, 200, { db: dbReady(), email: emailReady() });
    if (!dbReady()) throw new HttpError(503, "O banco de dados não está configurado.", "no_db");

    if (body.action === "login") {
      const email = String(body.email || "").trim().toLowerCase(), pass = String(body.password || "");
      if (!email || !pass) throw new HttpError(400, BAD_LOGIN);
      if (isAdminLogin(email, pass)) return send(res, 200, { token: signSession({ role: "admin", sub: adminEmail() }), role: "admin", admin: { name: ADMIN_NAME(), email: adminEmail() } });
      // o e-mail pode ser do responsável pela conta ou de um acesso extra do mesmo cliente
      const hit = await findLogin(email);
      const c = hit && hit.c, who = hit && (hit.u || hit.c);
      if (!c || !checkPassword(pass, who.passHash)) {
        if (who && !who.passHash) throw new HttpError(401, "Você ainda não criou sua senha. Use o link do convite que chegou no seu e-mail.");
        throw new HttpError(401, BAD_LOGIN);
      }
      if (c.status === "suspenso") throw new HttpError(403, "Seu acesso está suspenso. Fale com comercial@readyai.com para reativar.");
      const now = new Date().toISOString();
      who.lastAccess = now;
      if (hit.u) { hit.u.status = "ativo"; c.lastAccess = now; }
      else if (c.status === "convite") c.status = "ativo";
      await saveClient(c);
      return send(res, 200, { token: signSession({ role: "client", sub: c.id, uid: hit.u ? hit.u.id : undefined }), role: "client", client: publicClient(c) });
    }

    if (body.action === "me") {
      const s = readSession(req);
      if (!s) throw new HttpError(401, "Sessão expirada. Entre de novo.", "no_session");
      if (s.role === "admin") return send(res, 200, { role: "admin", admin: { name: ADMIN_NAME(), email: adminEmail() } });
      const c = await getClient(s.sub);
      if (!c) throw new HttpError(401, "Seu acesso foi removido. Fale com o seu gestor de conta.", "no_session");
      if (c.status === "suspenso") throw new HttpError(403, "Seu acesso está suspenso. Fale com comercial@readyai.com para reativar.", "no_session");
      if (s.uid && !(c.users || []).some(u => u.id === s.uid)) throw new HttpError(401, "Seu acesso foi removido. Fale com o responsável pela conta.", "no_session");
      return send(res, 200, { role: "client", client: publicClient(c) });
    }

    if (body.action === "invite_info") {
      const t = await inviteTarget(body.token);
      const c = t && t.c, who = t && (t.u || t.c);
      if (!c || (who.invite && who.invite.acceptedAt)) throw new HttpError(404, "Este convite expirou ou já foi usado. Peça um novo convite ao seu gestor de conta.", "invite_invalid");
      if (c.status === "suspenso") throw new HttpError(403, "Este acesso está suspenso. Fale com comercial@readyai.com.", "invite_invalid");
      return send(res, 200, { company: c.company, name: who.name, email: who.email, plan: PLAN_NAMES[c.plan] || c.plan });
    }

    if (body.action === "accept") {
      const pass = String(body.password || "");
      if (pass.length < 8) throw new HttpError(400, "A senha precisa ter pelo menos 8 caracteres.");
      const t = await inviteTarget(body.token);
      const c = t && t.c, who = t && (t.u || t.c);
      if (!c || (who.invite && who.invite.acceptedAt)) throw new HttpError(404, "Este convite expirou ou já foi usado. Peça um novo convite ao seu gestor de conta.", "invite_invalid");
      if (c.status === "suspenso") throw new HttpError(403, "Este acesso está suspenso. Fale com comercial@readyai.com.", "invite_invalid");
      const now = new Date().toISOString();
      await dropInvite(who);
      who.passHash = hashPassword(pass);
      who.status = "ativo";
      who.lastAccess = now;
      who.invite = { ...(who.invite || {}), tokenHash: null, acceptedAt: now };
      if (t.u) c.lastAccess = now; else c.status = "ativo";
      await saveClient(c);
      // aviso opcional para a gestora (variável NOTIFY_EMAIL)
      if (process.env.NOTIFY_EMAIL) {
        await sendEmail({
          to: process.env.NOTIFY_EMAIL, key: "accept-" + c.id + "-" + now,
          subject: `${c.company} aceitou o convite da ReadyAI`,
          text: `${who.name} (${who.email}) aceitou o convite e criou a senha em ${new Date(now).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}.`,
          html: `<p style="font-family:Arial,sans-serif;font-size:14px"><b>${who.name}</b> (${who.email}) aceitou o convite de <b>${c.company}</b> e já pode entrar na ReadyAI.</p>`,
        }).catch(() => null);
      }
      return send(res, 200, { token: signSession({ role: "client", sub: c.id, uid: t.u ? t.u.id : undefined }), role: "client", client: publicClient(c) });
    }

    throw new HttpError(400, "Ação desconhecida.");
  } catch (e) { return fail(res, e); }
}
