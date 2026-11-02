// Login, sessão e aceite de convite.
//
// POST /api/auth { action: "status" }                      -> { db, email }  (o app usa para saber se há banco)
// POST /api/auth { action: "login", email, password }      -> { token, role, client? }
// POST /api/auth { action: "me" }            (Bearer)      -> { role, client?, admin? }
// POST /api/auth { action: "invite_info", token }          -> { company, name, email, plan }
// POST /api/auth { action: "accept", token, password }     -> { token, role, client }
// POST /api/auth { action: "forgot", email }                -> { ok }  (sempre igual, exista ou não a conta)
// POST /api/auth { action: "reset_info", token }            -> { email, company }
// POST /api/auth { action: "reset", token, password }       -> { token, role, client }

import {
  dbReady, emailReady, HttpError, send, readBody, fail,
  getClient, findLogin, saveClient, inviteTarget, dropInvite,
  hashPassword, checkPassword, isAdminLogin, adminEmail, ADMIN_NAME,
  signSession, readSession, publicClient, sendEmail,
  newReset, resetTarget, dropReset, overLimit, resetEmail, appUrl, sha256,
} from "./_store.js";
import { trialEnded, trialEndedMsg, SALES_EMAIL } from "./_plans.js";

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
      if (c.status === "suspenso") throw new HttpError(403, "Seu acesso está suspenso. Fale com comercial@metrikabr.com para reativar.");
      if (trialEnded(c)) throw new HttpError(403, trialEndedMsg(), "trial_ended");
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
      if (c.status === "suspenso") throw new HttpError(403, "Seu acesso está suspenso. Fale com comercial@metrikabr.com para reativar.", "no_session");
      if (trialEnded(c)) throw new HttpError(403, trialEndedMsg(), "no_session");
      if (s.uid && !(c.users || []).some(u => u.id === s.uid)) throw new HttpError(401, "Seu acesso foi removido. Fale com o responsável pela conta.", "no_session");
      return send(res, 200, { role: "client", client: publicClient(c) });
    }

    if (body.action === "invite_info") {
      const t = await inviteTarget(body.token);
      const c = t && t.c, who = t && (t.u || t.c);
      if (!c || (who.invite && who.invite.acceptedAt)) throw new HttpError(404, "Este convite expirou ou já foi usado. Peça um novo convite ao seu gestor de conta.", "invite_invalid");
      if (c.status === "suspenso") throw new HttpError(403, "Este acesso está suspenso. Fale com comercial@metrikabr.com.", "invite_invalid");
      return send(res, 200, { company: c.company, name: who.name, email: who.email, plan: PLAN_NAMES[c.plan] || c.plan });
    }

    if (body.action === "accept") {
      const pass = String(body.password || "");
      if (pass.length < 8) throw new HttpError(400, "A senha precisa ter pelo menos 8 caracteres.");
      const t = await inviteTarget(body.token);
      const c = t && t.c, who = t && (t.u || t.c);
      if (!c || (who.invite && who.invite.acceptedAt)) throw new HttpError(404, "Este convite expirou ou já foi usado. Peça um novo convite ao seu gestor de conta.", "invite_invalid");
      if (c.status === "suspenso") throw new HttpError(403, "Este acesso está suspenso. Fale com comercial@metrikabr.com.", "invite_invalid");
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
          subject: `${c.company} aceitou o convite da metrikabr`,
          text: `${who.name} (${who.email}) aceitou o convite e criou a senha em ${new Date(now).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}.`,
          html: `<p style="font-family:Arial,sans-serif;font-size:14px"><b>${who.name}</b> (${who.email}) aceitou o convite de <b>${c.company}</b> e já pode entrar na metrikabr.</p>`,
        }).catch(() => null);
      }
      return send(res, 200, { token: signSession({ role: "client", sub: c.id, uid: t.u ? t.u.id : undefined }), role: "client", client: publicClient(c) });
    }

    if (body.action === "forgot") {
      const email = String(body.email || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Digite um e-mail válido.");
      if (!emailReady()) throw new HttpError(503, `A recuperação de senha está indisponível no momento. Fale com ${SALES_EMAIL()}.`);
      const ip = String(req.headers["x-forwarded-for"] || "?").split(",")[0].trim();
      if (await overLimit("forgot-ip:" + sha256(ip).slice(0, 24), 10, 3600)) throw new HttpError(429, "Muitos pedidos a partir desta rede. Tente de novo em uma hora.");
      // até 3 e-mails por conta por hora; acima disso responde igual, sem enviar
      const quiet = await overLimit("forgot-mail:" + sha256(email).slice(0, 24), 3, 3600);
      const hit = !quiet && email !== adminEmail() ? await findLogin(email) : null;
      if (hit && hit.c.status !== "suspenso") {
        const who = hit.u || hit.c;
        const token = await newReset(hit.c, hit.u);
        const mail = resetEmail(who, appUrl(req) + "/app/?redefinir=" + token);
        const r = await sendEmail({ to: who.email, ...mail, key: "reset-" + sha256(token).slice(0, 32) });
        if (!r.sent) console.error("forgot: e-mail não enviado para", who.email, r.error);
      }
      return send(res, 200, { ok: true });
    }

    if (body.action === "reset_info") {
      const t = await resetTarget(body.token);
      if (!t) throw new HttpError(404, "Este link expirou ou já foi usado. Peça um novo na tela de login.", "reset_invalid");
      const who = t.u || t.c;
      return send(res, 200, { email: who.email, company: t.c.company });
    }

    if (body.action === "reset") {
      const pass = String(body.password || "");
      if (pass.length < 8) throw new HttpError(400, "A senha precisa ter pelo menos 8 caracteres.");
      const t = await resetTarget(body.token);
      if (!t) throw new HttpError(404, "Este link expirou ou já foi usado. Peça um novo na tela de login.", "reset_invalid");
      const c = t.c, who = t.u || t.c, now = new Date().toISOString();
      await dropReset(body.token);
      who.passHash = hashPassword(pass);
      who.status = "ativo";
      who.lastAccess = now;
      // quem ainda não tinha aceitado o convite passa a ter acesso com a senha nova
      if (who.invite && !who.invite.acceptedAt) { await dropInvite(who); who.invite = { ...who.invite, tokenHash: null, acceptedAt: now }; }
      if (t.u) c.lastAccess = now; else if (c.status === "convite") c.status = "ativo";
      await saveClient(c);
      if (c.status === "suspenso") throw new HttpError(403, `Senha alterada. Mas seu acesso está suspenso: fale com ${SALES_EMAIL()} para reativar.`);
      if (trialEnded(c)) throw new HttpError(403, "Senha alterada. " + trialEndedMsg());
      return send(res, 200, { token: signSession({ role: "client", sub: c.id, uid: t.u ? t.u.id : undefined }), role: "client", client: publicClient(c) });
    }

    throw new HttpError(400, "Ação desconhecida.");
  } catch (e) { return fail(res, e); }
}
