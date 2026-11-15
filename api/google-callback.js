// Retorno do login do Google (GET /api/google-callback?code&state).
// Guarda a autorização no cadastro do cliente e mostra uma página que avisa a janela da metrikabr e se fecha.
import { finishAuth } from "./_gads.js";

const esc = s => String(s || "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
function page(res, status, ok, title, text) {
  res.status(status).setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} · metrikabr</title><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111827}
.box{max-width:420px;margin:24px;padding:32px;background:#fff;border:1px solid #e6e8ec;border-radius:16px;text-align:center}
.ic{width:48px;height:48px;border-radius:50%;display:grid;place-items:center;margin:0 auto 14px;font-size:24px;background:${ok ? "#e7f6ec;color:#15803d" : "#fdecec;color:#b91c1c"}}
h1{font-size:20px;margin:0 0 8px}p{margin:0 0 18px;color:#4b5563;line-height:1.5}a{display:inline-block;background:#111827;color:#fff;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:10px}</style></head>
<body><div class="box"><div class="ic">${ok ? "✓" : "!"}</div><h1>${esc(title)}</h1><p>${esc(text)}</p><a href="/app/">Voltar para a metrikabr</a></div>
<script>try{if(window.opener){window.opener.postMessage({type:"metrikabr-google",ok:${ok ? "true" : "false"}},location.origin);${ok ? "setTimeout(function(){window.close()},1200);" : ""}}}catch(e){}</script></body></html>`);
}

export default async function handler(req, res) {
  const q = req.query || Object.fromEntries(new URL(req.url, "http://x").searchParams);
  if (q.error) return page(res, 200, false, "Autorização cancelada", q.error === "access_denied" ? "Você não liberou o acesso ao Google Ads. Volte para a metrikabr e tente de novo quando quiser." : "O Google não concluiu a autorização (" + q.error + "). Tente de novo.");
  try {
    const r = await finishAuth(req, String(q.code || ""), String(q.state || ""));
    return page(res, 200, true, "Google Ads autorizado", (r.email ? "A conta " + r.email + " foi conectada. " : "") + "Esta janela fecha sozinha. Se não fechar, volte para a metrikabr e escolha a conta do Google Ads.");
  } catch (e) {
    return page(res, e.status && e.status < 500 ? e.status : 500, false, "Não deu certo", e.message || "Erro inesperado. Volte para a metrikabr e tente de novo.");
  }
}
