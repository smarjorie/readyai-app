// Cliente MCP mínimo (Streamable HTTP) usado pelas rotas do servidor.
// Arquivos que começam com "_" dentro de api/ não viram rota na Vercel.

export class McpError extends Error {
  constructor(message, status = 502, code) { super(message); this.status = status; this.code = code; }
}

export async function openMcp(url, extraHeaders = {}, label = "MCP") {
  const state = { seq: 0, session: null, protocol: null };
  async function rpc(method, params, isNotification) {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", ...extraHeaders };
    if (state.session) headers["mcp-session-id"] = state.session;
    if (state.protocol) headers["mcp-protocol-version"] = state.protocol;
    const id = isNotification ? undefined : ++state.seq;
    const msg = { jsonrpc: "2.0", method, ...(params ? { params } : {}), ...(isNotification ? {} : { id }) };
    let r;
    try {
      r = await fetch(url, { method: "POST", headers, body: JSON.stringify(msg) });
    } catch (e) {
      throw new McpError(`Não consegui acessar o ${label}. Tente de novo em instantes.`);
    }
    const sid = r.headers.get("mcp-session-id");
    if (sid) state.session = sid;
    if (isNotification) return null;
    const raw = await r.text();
    if (r.status === 401 || r.status === 403) throw new McpError(`O ${label} recusou o acesso.`, 401, "unauthorized");
    if (r.status === 429) throw new McpError(`O ${label} limitou as consultas por alguns minutos. Tente de novo daqui a pouco.`, 429, "rate_limit");
    if (!r.ok) throw new McpError(`O ${label} respondeu com erro (${r.status}).`, 502);
    let reply = null;
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("text/event-stream") || /^\s*(event|data):/.test(raw)) {
      for (const line of raw.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        try { const j = JSON.parse(line.slice(5).trim()); if (j && j.id === id) reply = j; } catch (e) {}
      }
    } else {
      try { const j = JSON.parse(raw); reply = Array.isArray(j) ? j.find(x => x.id === id) : j; } catch (e) {}
    }
    if (!reply) throw new McpError(`Resposta inesperada do ${label}.`);
    if (reply.error) throw new McpError(`O ${label} recusou o pedido: ${reply.error.message || "erro"}`, 502, "rpc_error");
    return reply.result;
  }
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "readyai-app", version: "1.0.0" } });
  state.protocol = (init && init.protocolVersion) || "2025-06-18";
  await rpc("notifications/initialized", null, true);
  return {
    // devolve { text, data }: data é o JSON da resposta quando a ferramenta devolve JSON
    async call(name, args) {
      const result = await rpc("tools/call", { name, arguments: args });
      const text = ((result && result.content) || []).filter(c => c.type === "text").map(c => c.text).join("\n");
      if (result && result.isError) throw new McpError(text.slice(0, 300) || `O ${label} recusou a consulta.`, 400, "tool_error");
      let data = result && result.structuredContent;
      if (!data) { try { data = JSON.parse(text); } catch (e) { data = null; } }
      return { text, data };
    },
  };
}
