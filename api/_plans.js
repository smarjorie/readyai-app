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
