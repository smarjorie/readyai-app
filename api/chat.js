// Proxy do copilot: recebe a conversa do navegador e repassa para Claude (Anthropic) ou ChatGPT (OpenAI).
// A chave de API vem do navegador do usuário no header "x-ai-key" e só é usada nesta chamada:
// não é gravada, logada nem enviada para nenhum outro lugar.

const ANTHROPIC_URL = "https://api.anthropic.com/v1";
const OPENAI_URL = "https://api.openai.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";

const MAX_MESSAGES = 24;
const MAX_CHARS = 60000;

function send(res, status, body) {
  res.status(status).setHeader("Cache-Control", "no-store");
  res.json(body);
}

// Traduz erros comuns das APIs para algo que o usuário entende
function friendlyError(provider, status, raw) {
  const who = provider === "anthropic" ? "Anthropic" : "OpenAI";
  if (status === 401 || status === 403) return `A ${who} recusou a chave. Confira se ela está correta e ativa.`;
  if (status === 404) return `O modelo escolhido não está disponível para essa chave na ${who}. Troque o modelo nas Integrações.`;
  if (status === 429) return `Limite de uso atingido na ${who} (ou conta sem créditos). Tente de novo em instantes ou confira o faturamento da conta.`;
  if (status === 400 && /credit|billing|balance|quota/i.test(raw)) return `A conta da ${who} está sem créditos. Adicione saldo no painel de faturamento.`;
  if (status >= 500) return `A ${who} está instável agora. Tente de novo em instantes.`;
  return `Erro da ${who} (${status}).`;
}

async function readError(r) {
  try {
    const j = await r.json();
    return (j && j.error && (j.error.message || j.error.type)) || JSON.stringify(j).slice(0, 300);
  } catch (e) {
    return "";
  }
}

// ---------- listar modelos (usado para validar a chave ao conectar) ----------
async function listModels(provider, key) {
  if (provider === "anthropic") {
    const r = await fetch(`${ANTHROPIC_URL}/models?limit=100`, {
      headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
    });
    if (!r.ok) return { status: r.status, raw: await readError(r) };
    const j = await r.json();
    return { models: (j.data || []).map(m => ({ id: m.id, name: m.display_name || m.id })) };
  }
  const r = await fetch(`${OPENAI_URL}/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) return { status: r.status, raw: await readError(r) };
  const j = await r.json();
  const skip = /(audio|realtime|live|tts|transcribe|whisper|embedding|image|dall-e|moderation|search|instruct|babbage|davinci|codex|computer-use)/i;
  const models = (j.data || [])
    .map(m => m.id)
    .filter(id => /^(gpt-|chatgpt-|o\d)/.test(id) && !skip.test(id))
    .sort((a, b) => b.localeCompare(a, "en", { numeric: true }))
    .map(id => ({ id, name: id }));
  return { models };
}

// ---------- conversa ----------
async function chatAnthropic(key, model, system, messages) {
  const r = await fetch(`${ANTHROPIC_URL}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
    body: JSON.stringify({ model, max_tokens: 1800, system, messages }),
  });
  if (!r.ok) return { status: r.status, raw: await readError(r) };
  const j = await r.json();
  const text = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
  return { text };
}

async function chatOpenAI(key, model, system, messages) {
  const call = async jsonMode => {
    const body = { model, messages: [{ role: "system", content: system }, ...messages] };
    if (jsonMode) body.response_format = { type: "json_object" };
    return fetch(`${OPENAI_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
  };
  let r = await call(true);
  // alguns modelos não aceitam response_format: tenta de novo sem ele
  if (r.status === 400) {
    const raw = await readError(r);
    if (/response_format|json/i.test(raw)) r = await call(false);
    else return { status: 400, raw };
  }
  if (!r.ok) return { status: r.status, raw: await readError(r) };
  const j = await r.json();
  const text = ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "").trim();
  return { text };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST." });

  const key = String(req.headers["x-ai-key"] || "").trim();
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const { action = "chat", provider, model, system, messages } = body;

  if (provider !== "anthropic" && provider !== "openai") return send(res, 400, { error: "Escolha Claude ou ChatGPT." });
  if (!key || key.length < 20) return send(res, 400, { error: "Cole uma chave de API válida." });

  try {
    if (action === "verify") {
      const out = await listModels(provider, key);
      if (out.status) return send(res, out.status, { error: friendlyError(provider, out.status, out.raw) });
      return send(res, 200, { ok: true, models: out.models });
    }

    if (!model || typeof model !== "string") return send(res, 400, { error: "Escolha um modelo." });
    if (!Array.isArray(messages) || !messages.length) return send(res, 400, { error: "Mensagem vazia." });

    // só papéis válidos, conversa curta e tamanho limitado
    let msgs = messages
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
      .slice(-MAX_MESSAGES)
      .map(m => ({ role: m.role, content: m.content.slice(0, 8000) }));
    while (msgs.length && msgs[0].role !== "user") msgs.shift();
    // junta mensagens seguidas do mesmo papel (ex.: duas perguntas depois de um erro)
    msgs = msgs.reduce((acc, m) => {
      const last = acc[acc.length - 1];
      if (last && last.role === m.role) last.content += "\n\n" + m.content;
      else acc.push({ ...m });
      return acc;
    }, []);
    if (!msgs.length) return send(res, 400, { error: "Mensagem vazia." });
    const sys = String(system || "").slice(0, MAX_CHARS);

    const out = provider === "anthropic"
      ? await chatAnthropic(key, model, sys, msgs)
      : await chatOpenAI(key, model, sys, msgs);
    if (out.status) return send(res, out.status, { error: friendlyError(provider, out.status, out.raw) });
    return send(res, 200, { text: out.text });
  } catch (e) {
    return send(res, 502, { error: "Não consegui falar com o provedor de IA agora. Tente de novo." });
  }
}
