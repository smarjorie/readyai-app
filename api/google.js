// Google Ads pela API oficial, com o OAuth do próprio app (sem MCP no meio).
// Precisa de sessão: o cliente age por si; a gestora (admin) informa client_id.
//
// POST /api/google { action: "status" }                          -> { ready, authorized, email }
// POST /api/google { action: "connect" }                         -> { url }  (abre o login do Google)
// POST /api/google { action: "accounts" }                        -> { accounts: [{ id, label, name, manager, via? }] }
// POST /api/google { action: "data", customer_id, login_id?, period } -> campanhas no formato do painel
// POST /api/google { action: "disconnect" }                      -> { ok }  (revoga no Google e apaga do banco)
// Em todas, a gestora manda também client_id.

import { HttpError, send, readBody, fail, readSession, getClient, dbReady } from "./_store.js";
import { periodOf } from "./_period.js";
import { googleReady, authUrl, tokenInfo, listAccounts, campaignData, revoke } from "./_gads.js";

const id10 = v => { const s = String(v || "").replace(/\D/g, ""); return s.length === 10 ? s : null; };

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST." });
  try {
    const body = readBody(req);
    if (!dbReady()) throw new HttpError(503, "A conexão com o Google Ads precisa do banco de dados configurado.", "no_db");
    const s = readSession(req);
    if (!s) throw new HttpError(401, "Sessão expirada. Entre de novo.", "no_session");
    const cid = s.role === "admin" ? String(body.client_id || "") : s.sub;
    const c = cid && await getClient(cid);
    if (!c) throw new HttpError(404, "Cliente não encontrado.");

    if (body.action === "status") {
      const t = googleReady() ? await tokenInfo(c.id) : null;
      return send(res, 200, { ready: googleReady(), authorized: !!t, email: t ? t.email : null });
    }
    if (body.action === "connect") return send(res, 200, { url: await authUrl(req, c.id) });
    if (body.action === "accounts") return send(res, 200, { accounts: await listAccounts(c.id) });
    if (body.action === "data") {
      const customer = id10(body.customer_id);
      if (!customer) throw new HttpError(400, "Escolha uma conta do Google Ads (10 dígitos).");
      return send(res, 200, await campaignData(c.id, customer, id10(body.login_id) || customer, periodOf(body.period)));
    }
    if (body.action === "disconnect") { await revoke(c.id); return send(res, 200, { ok: true }); }
    throw new HttpError(400, "Ação desconhecida.");
  } catch (e) { return fail(res, e); }
}
