// Planos e módulos, compartilhados entre o cadastro da gestora (clients.js) e o cadastro pela LP (signup.js).
export const PLANS = { starter: "Starter", pro: "Pro", scale: "Scale" };
// pacote padrão de cada plano (o mesmo do app); vale quando o cadastro chega sem a lista de módulos
export const PLAN_MODULES = {
  starter: ["copilot", "overview", "campaigns"],
  pro: ["copilot", "overview", "analytics", "campaigns", "creatives", "report", "insights"],
  scale: ["portfolio", "copilot", "overview", "analytics", "campaigns", "creatives", "report", "insights", "skills"],
};
export const MODULES = ["copilot", "overview", "analytics", "campaigns", "creatives", "report", "skills", "insights", "portfolio", "whatsapp"];

// teste grátis de quem se cadastra pela LP
export const TRIAL_DAYS = Number(process.env.TRIAL_DAYS) > 0 ? Number(process.env.TRIAL_DAYS) : 7;
export const SALES_EMAIL = () => process.env.SALES_EMAIL || "comercial@metrikabr.com";
export const trialEnded = c => !!(c && c.trialEndsAt && Date.parse(c.trialEndsAt) <= Date.now());
export const trialEndedMsg = () => `Seu teste grátis de ${TRIAL_DAYS} dias terminou. Fale com ${SALES_EMAIL()} para continuar usando a metrikabr.`;

// cadastro pela LP fica aguardando a gestora aprovar no console (status "pendente")
export const pendingMsg = () => "Seu cadastro está em análise. Você recebe um e-mail assim que o acesso for liberado, normalmente no mesmo dia útil.";
export const rejectedMsg = () => `Não foi possível liberar este cadastro. Fale com ${SALES_EMAIL()} se precisar de ajuda.`;
// bloqueio de entrada por status; devolve a mensagem ou null quando pode entrar
export function blockedMsg(c) {
  if (!c) return null;
  if (c.status === "pendente") return pendingMsg();
  if (c.status === "recusado") return rejectedMsg();
  if (c.status === "suspenso") return `Seu acesso está suspenso. Fale com ${SALES_EMAIL()} para reativar.`;
  return null;
}

// domínios de e-mail descartável mais comuns: o cadastro entra, mas o alerta chega marcado
export const DISPOSABLE = new Set(["mailinator.com", "guerrillamail.com", "guerrillamail.net", "sharklasers.com", "10minutemail.com", "10minutemail.net", "tempmail.com", "temp-mail.org", "temp-mail.io", "tempmail.net", "tempmailo.com", "throwawaymail.com", "yopmail.com", "yopmail.net", "getnada.com", "nada.email", "trashmail.com", "trashmail.de", "dispostable.com", "maildrop.cc", "mailnesia.com", "mintemail.com", "mohmal.com", "emailondeck.com", "fakeinbox.com", "spamgourmet.com", "mytemp.email", "tempr.email", "discard.email", "inboxkitten.com", "burnermail.io", "1secmail.com", "1secmail.net", "1secmail.org", "moakt.com", "tmpmail.org", "tmpmail.net", "emailfake.com", "mail.tm", "cuvox.de", "armyspy.com", "dayrep.com", "einrot.com", "fleckens.hu", "gustr.com", "jourrapide.com", "rhyta.com", "superrito.com", "teleworm.us", "dpptd.com"]);
export const FREE_MAIL = new Set(["gmail.com", "hotmail.com", "outlook.com", "live.com", "yahoo.com", "yahoo.com.br", "icloud.com", "uol.com.br", "bol.com.br", "terra.com.br", "ig.com.br", "proton.me", "protonmail.com"]);
