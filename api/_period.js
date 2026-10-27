// Período das consultas: { since, until } em AAAA-MM-DD, vindo do navegador.
// Sem período válido, usa os últimos 30 dias completos (até ontem).
// Também calcula o período anterior de mesmo tamanho e as duas últimas semanas do período,
// usadas na variação semanal.
const DAY = 86400e3;
const ymd = d => d.toISOString().slice(0, 10);
const parse = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) ? new Date(s + "T00:00:00Z") : null;
const add = (d, n) => new Date(d.getTime() + n * DAY);
const max = (a, b) => (a > b ? a : b);

export function periodOf(p) {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  let since = parse(p && p.since), until = parse(p && p.until);
  if (!since || !until || since > until) { until = add(today, -1); since = add(today, -30); }
  if (until > today) until = today;
  if (since < add(today, -760)) since = add(today, -760); // a Meta guarda cerca de 37 meses; limitamos a ~2 anos
  if (since > until) since = until;
  const days = Math.round((until - since) / DAY) + 1;
  const w1s = max(since, add(until, -6));
  const r = (a, b) => ({ since: ymd(a), until: ymd(b) });
  return {
    since: ymd(since), until: ymd(until), days,
    prev: r(add(since, -days), add(since, -1)),
    w1: r(w1s, until),
    w0: r(add(w1s, -7), add(w1s, -1)),
    last14: r(max(since, add(until, -13)), until),
    year: r(add(today, -365), today),
    // lista de datas das últimas 14 (ou menos) do período, para os minigráficos
    days14: Array.from({ length: Math.round((until - max(since, add(until, -13))) / DAY) + 1 }, (_, i) => ymd(add(max(since, add(until, -13)), i))),
  };
}
export const tr = r => JSON.stringify({ since: r.since, until: r.until });
