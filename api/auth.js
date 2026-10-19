// Login, sessão e aceite de convite.
//
// POST /api/auth { action: "status" }                      -> { db, email }  (o app usa para saber se há banco)
// POST /api/auth { action: "login", email, password }      -> { token, role, client? }
// POST /api/auth { action: "me" }            (Bearer)      -> { role, client?, admin? }
// POST /api/auth { action: "invite_info", token }          -> { company, name, email, plan }
// POST /api/auth { action: "accept", token, password }     -> { token, role, client }

import {
  dbReady, emailReady, HttpError, send, readBody, fail,
  getClient, getClientByEmail, saveClient, clientByInvite, dropInvite,
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
      const c = await getClientByEmail(email);
      if (!c || !checkPassword(pass, c.passHash)) {
        if (c && !c.passHash && c.status === "convite") throw new HttpError(401, "Você ainda não criou sua senha. Use o link do convite que chegou no seu e-mail.");
        throw new HttpError(401, BAD_LOGIN);
      }
      if (c.status === "suspenso") throw new HttpError(403, "Seu acesso está suspenso. Fale com comercial@readyai.com para reativar.");
      c.lastAccess = new Date().toISOString();
      if (c.status === "convite") c.status = "ativo";
      await saveClient(c);
      return send(res, 200, { token: signSession({ role: "client", sub: c.id }), role: "client", client: publicClient(c) });
    }

    if (body.action === "me") {
      const s = readSession(req);
      if (!s) throw new HttpError(401, "Sessão expirada. Entre de novo.", "no_session");
      if (s.role === "admin") return send(res, 200, { role: "admin", admin: { name: ADMIN_NAME(), email: adminEmail() } });
      const c = await getClient(s.sub);
      if (!c) throw new HttpError(401, "Seu acesso foi removido. Fale com o seu gestor de conta.", "no_session");
      if (c.status === "suspenso") throw new HttpError(403, "Seu acesso está suspenso. Fale com comercial@readyai.com para reativar.", "no_session");
      return send(res, 200, { role: "client", client: publicClient(c) });
    }

    if (body.action === "invite_info") {
      const c = await clientByInvite(body.token);
      if (!c || (c.invite && c.invite.acceptedAt)) throw new HttpError(404, "Este convite expirou ou já foi usado. Peça um novo convite ao seu gestor de conta.", "invite_invalid");
      if (c.status === "suspenso") throw new HttpError(403, "Este acesso está suspenso. Fale com comercial@readyai.com.", "invite_invalid");
      return send(res, 200, { company: c.company, name: c.name, email: c.email, plan: PLAN_NAMES[c.plan] || c.plan });
    }

    if (body.action === "accept") {
      const pass = String(body.password || "");
      if (pass.length < 8) throw new HttpError(400, "A senha precisa ter pelo menos 8 caracteres.");
      const c = await clientByInvite(body.token);
      if (!c || (c.invite && c.invite.acceptedAt)) throw new HttpError(404, "Este convite expirou ou já foi usado. Peça um novo convite ao seu gestor de conta.", "invite_invalid");
      if (c.status === "suspenso") throw new HttpError(403, "Este acesso está suspenso. Fale com comercial@readyai.com.", "invite_invalid");
      const now = new Date().toISOString();
      await dropInvite(c);
      c.passHash = hashPassword(pass);
      c.status = "ativo";
      c.lastAccess = now;
      c.invite = { ...(c.invite || {}), tokenHash: null, acceptedAt: now };
      await saveClient(c);
      // aviso opcional para a gestora (variável NOTIFY_EMAIL)
      if (process.env.NOTIFY_EMAIL) {
        await sendEmail({
          to: process.env.NOTIFY_EMAIL, key: "accept-" + c.id + "-" + now,
          subject: `${c.company} aceitou o convite da ReadyAI`,
          text: `${c.name} (${c.email}) aceitou o convite e criou a senha em ${new Date(now).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}.`,
          html: `<p style="font-family:Arial,sans-serif;font-size:14px"><b>${c.name}</b> (${c.email}) aceitou o convite de <b>${c.company}</b> e já pode entrar na ReadyAI.</p>`,
        }).catch(() => null);
      }
      return send(res, 200, { token: signSession({ role: "client", sub: c.id }), role: "client", client: publicClient(c) });
    }

    throw new HttpError(400, "Ação desconhecida.");
  } catch (e) { return fail(res, e); }
}
