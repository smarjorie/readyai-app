// Cadastro pela landing page ou pela tela de login do app.
// A conta nasce "pendente": a pessoa só entra depois que a gestora aprova no console.
// O teste grátis (trialEndsAt) começa a contar na aprovação, não no cadastro.
//
// POST /api/signup { plan, company, name, email, password, phone?, source?, website? }
//   -> { pending: true, email }
// "website" é um campo escondido na LP (armadilha para robôs): se vier preenchido, o cadastro é ignorado.

import crypto from "node:crypto";
import {
  dbReady, HttpError, send, readBody, fail, cmd,
  getClientByEmail, saveClient, hashPassword, sendEmail,
  notifyTargets, signupAlertEmail, signupReceivedEmail, appUrl,
} from "./_store.js";
import { PLANS, PLAN_MODULES, DISPOSABLE, FREE_MAIL } from "./_plans.js";

const isEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const txt = (v, max = 120) => String(v == null ? "" : v).trim().slice(0, max);
const P = process.env.KV_PREFIX || "readyai-app:";
const MAX_PER_HOUR = 5; // cadastros por IP por hora

async function rateLimit(req) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "?").split(",")[0].trim();
  const key = P + "rl:signup:" + crypto.createHash("sha256").update(ip).digest("hex").slice(0, 24);
  const n = await cmd("INCR", key);
  if (n === 1) await cmd("EXPIRE", key, 3600);
  if (n > MAX_PER_HOUR) throw new HttpError(429, "Muitos cadastros a partir desta rede. Tente de novo em uma hora.");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST." });
  try {
    const f = readBody(req);
    if (!dbReady()) throw new HttpError(503, "O cadastro está indisponível no momento. Tente de novo mais tarde.", "no_db");

    const email = txt(f.email).toLowerCase(), company = txt(f.company), name = txt(f.name), pass = String(f.password || "");
    if (!company || !name || !isEmail(email)) throw new HttpError(400, "Preencha empresa, nome e um e-mail válido.");
    if (pass.length < 8) throw new HttpError(400, "A senha precisa ter pelo menos 8 caracteres.");
    if (txt(f.website)) return send(res, 200, { pending: true, email }); // robô: finge sucesso e não cria nada
    await rateLimit(req);
    const taken = await getClientByEmail(email);
    if (taken && taken.status === "pendente") throw new HttpError(409, "Já recebemos um cadastro com esse e-mail e ele está em análise. Você recebe um e-mail assim que o acesso for liberado.", "pending");
    if (taken) throw new HttpError(409, "Já existe uma conta com esse e-mail. Entre pelo login ou use outro e-mail.", "email_taken");

    // sinais para a gestora decidir (nada aqui bloqueia o cadastro)
    const domain = email.split("@")[1];
    const flags = [];
    if (DISPOSABLE.has(domain)) flags.push("e-mail descartável (" + domain + ")");
    else if (FREE_MAIL.has(domain)) flags.push("e-mail pessoal, não corporativo");
    const h = k => { try { return decodeURIComponent(String(req.headers[k] || "")).slice(0, 60); } catch (e) { return ""; } };
    const country = h("x-vercel-ip-country");
    if (country && country !== "BR") flags.push("cadastro de fora do Brasil (" + country + ")");

    const plan = PLANS[f.plan] ? f.plan : "pro";
    const now = new Date();
    const c = {
      id: "cl" + crypto.randomBytes(6).toString("hex"), company, name, email, phone: txt(f.phone, 30) || null,
      plan, modules: [...PLAN_MODULES[plan]], status: "pendente", source: ["lp", "lp-agencias", "app"].includes(f.source) ? f.source : "lp",
      since: now.toISOString().slice(0, 10), createdAt: now.toISOString(), lastAccess: null,
      trialEndsAt: null, // começa a contar quando a gestora aprovar
      approval: { requestedAt: now.toISOString(), flags, country: country || null, region: h("x-vercel-ip-country-region") || null, city: h("x-vercel-ip-city") || null, alert: null },
      targetRoas: null, conn: {}, invite: null, passHash: hashPassword(pass),
    };
    await saveClient(c);

    // alerta para a gestora (NOTIFY_EMAIL, ou ADMIN_EMAIL) e confirmação para a pessoa
    const to = notifyTargets();
    const link = appUrl(req) + "/app/?cliente=" + c.id;
    const results = await Promise.all(to.map(addr => sendEmail({ to: addr, key: "signup-" + c.id + "-" + addr, ...signupAlertEmail(c, PLANS[plan], link) }).catch(e => ({ sent: false, error: String(e && e.message || e) }))));
    const failed = results.filter(r => !r.sent);
    c.approval.alert = !to.length ? { sent: false, error: "Nenhum e-mail de alerta configurado. Crie NOTIFY_EMAIL na Vercel com o seu e-mail." }
      : failed.length ? { sent: false, error: failed[0].error, to } : { sent: true, to, at: new Date().toISOString() };
    if (!c.approval.alert.sent) console.error("signup: alerta não enviado", c.id, c.approval.alert.error);
    await sendEmail({ to: email, key: "signup-received-" + c.id, ...signupReceivedEmail(c) }).catch(() => null);
    await saveClient(c);

    return send(res, 200, { pending: true, email });
  } catch (e) { return fail(res, e); }
}
