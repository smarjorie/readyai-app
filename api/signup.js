// Cadastro pela landing page: cria a conta com teste grátis e já devolve a sessão.
//
// POST /api/signup { plan, company, name, email, password, phone?, source?, website? }
//   -> { token, role: "client", client }
// "website" é um campo escondido na LP (armadilha para robôs): se vier preenchido, o cadastro é ignorado.

import crypto from "node:crypto";
import {
  dbReady, HttpError, send, readBody, fail, cmd,
  getClientByEmail, saveClient, hashPassword, signSession, publicClient, sendEmail,
} from "./_store.js";
import { PLANS, PLAN_MODULES, TRIAL_DAYS } from "./_plans.js";

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
    if (txt(f.website)) return send(res, 200, { ok: true }); // robô: finge sucesso e não cria nada
    await rateLimit(req);
    if (await getClientByEmail(email)) throw new HttpError(409, "Já existe uma conta com esse e-mail. Entre pelo login ou use outro e-mail.", "email_taken");

    const plan = PLANS[f.plan] ? f.plan : "pro";
    const now = new Date();
    const c = {
      id: "cl" + crypto.randomBytes(6).toString("hex"), company, name, email, phone: txt(f.phone, 30) || null,
      plan, modules: [...PLAN_MODULES[plan]], status: "ativo", source: ["lp", "lp-agencias"].includes(f.source) ? f.source : "lp",
      since: now.toISOString().slice(0, 10), createdAt: now.toISOString(), lastAccess: now.toISOString(),
      trialEndsAt: new Date(now.getTime() + TRIAL_DAYS * 86400e3).toISOString(),
      targetRoas: null, conn: {}, invite: null, passHash: hashPassword(pass),
    };
    await saveClient(c);

    // aviso opcional para a gestora (variável NOTIFY_EMAIL)
    if (process.env.NOTIFY_EMAIL) {
      await sendEmail({
        to: process.env.NOTIFY_EMAIL, key: "signup-" + c.id,
        subject: `Novo teste grátis: ${company} (${PLANS[plan]})`,
        text: `${name} (${email}${c.phone ? ", " + c.phone : ""}) criou uma conta de teste de ${company} no plano ${PLANS[plan]}. O teste vai até ${new Date(c.trialEndsAt).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}.`,
      }).catch(() => null);
    }
    return send(res, 200, { token: signSession({ role: "client", sub: c.id }), role: "client", client: publicClient(c) });
  } catch (e) { return fail(res, e); }
}
