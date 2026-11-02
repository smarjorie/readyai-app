// metrikabr · comportamento das landing pages (gestores e agências)
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const brl = n => "R$ " + Math.round(n).toLocaleString("pt-BR");
  const PLANS = {
    starter: { name: "Starter", price: 297 },
    pro: { name: "Pro", price: 697 },
    scale: { name: "Scale", price: 1497 },
  };

  /* ---------- visual: escuro ou claro ----------
     O visual final é o data-theme do <html>. Enquanto a escolha não é feita, o seletor aparece no
     preview (localhost, *.vercel.app ou ?tema=) e lembra a escolha neste navegador. */
  const root = document.documentElement;
  const preview = /localhost|127\.0\.0\.1|vercel\.app$/.test(location.hostname) || /[?&]tema=/.test(location.search);
  if (preview) {
    root.classList.add("is-preview");
    const pick = document.createElement("div");
    pick.className = "theme-pick";
    pick.setAttribute("role", "group");
    pick.setAttribute("aria-label", "Opção de visual");
    pick.innerHTML = '<span>Visual</span><button type="button" data-t="dark">Escuro</button><button type="button" data-t="light">Claro</button>';
    const sync = () => $$("button", pick).forEach(b => b.setAttribute("aria-pressed", String(b.dataset.t === root.dataset.theme)));
    pick.addEventListener("click", e => {
      const b = e.target.closest("button"); if (!b) return;
      root.dataset.theme = b.dataset.t;
      try { localStorage.setItem("mk_lp_theme", b.dataset.t); } catch (x) {}
      sync(); placeGoals();
    });
    document.body.appendChild(pick); sync();
  }

  /* ---------- topo ---------- */
  const top = $(".top"), hero = $(".hero");
  const onScroll = () => {
    const past = !hero || scrollY > hero.offsetHeight - 80;
    top.classList.toggle("scrolled", scrollY > 8);
    top.classList.toggle("on-hero", !past && scrollY <= 8);
  };
  addEventListener("scroll", onScroll, { passive: true }); onScroll();

  /* ---------- régua de ROAS x meta (mock) ---------- */
  function placeGoals() {
    $$(".ruler").forEach(r => {
      const g = $(".goal", r), t = $(".trk", r); if (!g || !t) return;
      const rb = r.getBoundingClientRect(), tb = t.getBoundingClientRect();
      g.style.left = (tb.left - rb.left + tb.width * Number(r.dataset.goal) / Number(r.dataset.max)) + "px";
    });
  }
  placeGoals(); addEventListener("resize", placeGoals);
  if (document.fonts) document.fonts.ready.then(placeGoals);
  requestAnimationFrame(() => $$(".hero .win").forEach(w => w.classList.add("play")));

  /* ---------- abas do produto ---------- */
  $$("[role=tablist]").forEach(list => {
    const tabs = $$("[role=tab]", list);
    const show = t => {
      tabs.forEach(x => { const on = x === t; x.setAttribute("aria-selected", String(on)); x.tabIndex = on ? 0 : -1; $("#" + x.getAttribute("aria-controls")).hidden = !on; });
      placeGoals();
    };
    list.addEventListener("click", e => { const t = e.target.closest("[role=tab]"); if (t) show(t); });
    list.addEventListener("keydown", e => {
      const i = tabs.indexOf(document.activeElement); if (i < 0) return;
      const n = e.key === "ArrowRight" ? (i + 1) % tabs.length : e.key === "ArrowLeft" ? (i - 1 + tabs.length) % tabs.length : -1;
      if (n >= 0) { e.preventDefault(); tabs[n].focus(); show(tabs[n]); }
    });
  });

  /* ---------- calculadoras (contas feitas só com o que a pessoa informa) ---------- */
  const CALCS = {
    // gestor: receita que deixa de entrar quando uma campanha roda abaixo da meta de ROAS
    gap: v => {
      const gap = Math.max(0, v.meta - v.roas) * v.spend * 30;
      return { big: brl(gap), text: v.roas >= v.meta
        ? "Essa campanha já está na meta. A metrikabr avisa quando ela sair dela."
        : `Com ${brl(v.spend)}/dia e ROAS de ${v.roas.toFixed(1).replace(".", ",")}x, a campanha devolve ${brl(v.roas * v.spend * 30)} por mês. Na sua meta de ${v.meta.toFixed(1).replace(".", ",")}x, seriam ${brl(v.meta * v.spend * 30)}.` };
    },
    // agência: custo mensal da equipe montando relatório na mão
    reports: v => {
      const hours = v.clients * v.hours * v.freq;
      return { big: brl(hours * v.cost), text: `São ${Math.round(hours).toLocaleString("pt-BR")} horas por mês da sua equipe copiando número de gerenciador para planilha e slide, em vez de otimizar campanha.` };
    },
    // agência: preço do Scale pelo tamanho da carteira
    scale: v => {
      const extra = Math.max(0, v.clients - 10);
      const total = 1497 + extra * 79;
      return { big: brl(total) + "/mês", text: extra ? `10 clientes incluídos no plano, mais ${extra} × R$ 79. Dá ${brl(total / v.clients)} por cliente.` : `Até 10 clientes já estão incluídos. Dá ${brl(total / Math.max(1, v.clients))} por cliente.` };
    },
  };
  $$("[data-calc]").forEach(box => {
    const fn = CALCS[box.dataset.calc]; if (!fn) return;
    const run = () => {
      const v = {};
      $$("input[type=range]", box).forEach(i => {
        v[i.name] = Number(i.value);
        const o = $(`output[for=${i.id}]`, box);
        if (o) o.textContent = (i.dataset.pre || "") + Number(i.value).toLocaleString("pt-BR", { minimumFractionDigits: Number(i.dataset.dec || 0), maximumFractionDigits: Number(i.dataset.dec || 0) }) + (i.dataset.suf || "");
      });
      const r = fn(v);
      $("[data-out=big]", box).textContent = r.big;
      $("[data-out=text]", box).textContent = r.text;
    };
    box.addEventListener("input", run); run();
  });

  /* ---------- cadastro ---------- */
  const dlg = $("#signup"), form = $("#su-form");
  if (!dlg) return;
  const err = $("#su-err"), btn = $("#su-btn"), sub = $("#su-sub");
  const setPlan = k => { form.plan.value = k; sub.textContent = `7 dias grátis do plano ${PLANS[k].name}. Sem cartão de crédito.`; };
  form.addEventListener("change", e => { if (e.target.name === "plan") setPlan(e.target.value); });
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-signup]"); if (!b) return;
    setPlan(PLANS[b.dataset.signup] ? b.dataset.signup : (dlg.dataset.default || "pro"));
    err.hidden = true;
    dlg.showModal();
    form.name.focus();
  });
  $("#su-close").addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close(); });

  const showErr = msg => { err.innerHTML = msg; err.hidden = false; };
  form.addEventListener("submit", async e => {
    e.preventDefault();
    err.hidden = true;
    const d = Object.fromEntries(new FormData(form));
    d.source = document.body.dataset.lp || "lp";
    if (!d.name.trim() || !d.company.trim()) return showErr("Preencha seu nome e o nome da empresa.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email.trim())) return showErr("Digite um e-mail válido, como voce@empresa.com.br.");
    if (d.password.length < 8) return showErr("A senha precisa ter pelo menos 8 caracteres.");
    btn.disabled = true; btn.textContent = "Criando sua conta…";
    let done = false;
    try {
      const r = await fetch("/api/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(d) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (j.code === "email_taken") return showErr('Já existe uma conta com esse e-mail. <a href="/app/">Entre por aqui</a> ou use outro e-mail.');
        return showErr(j.error || "Não foi possível criar a conta agora. Tente de novo em instantes.");
      }
      if (!j.token) return showErr("Não foi possível criar a conta agora. Tente de novo em instantes.");
      // mesma sessão que o app usa no login
      try { localStorage.setItem("readyai_session_v1", JSON.stringify({ token: j.token, role: "client", clientId: j.client.id })); } catch (x) {}
      done = true;
      btn.textContent = "Conta criada. Abrindo o painel…";
      location.href = "/app/";
    } catch (x) {
      showErr("Sem conexão com o servidor. Confira sua internet e tente de novo.");
    } finally {
      if (!done) { btn.disabled = false; btn.textContent = "Criar conta e começar o teste"; }
    }
  });
})();
