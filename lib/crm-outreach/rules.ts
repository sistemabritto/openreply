export const FIRST_MESSAGE = 'Fala! Vi que você comentou pedindo a aula sobre o CRM que eu mostrei.\n\nComo bastante gente pediu, resolvi fazer um material bem mais completo.\n\nAntes de terminar, queria ouvir quem demonstrou interesse pra entender o que realmente precisa entrar.\n\nPosso te mandar uma pesquisa rapidinha? Quem participar vai receber o material gratuitamente quando eu liberar.';
export const TERMINAL = ['survey_sent','survey_completed','not_interested','do_not_contact'];
const positive = new Set(['sim','pode','manda','quero','claro','beleza','bora','envia','manda ai','pode mandar']);
const negative = new Set(['nao','nao quero','pare','sai','nao tenho interesse']);
export function classifyReply(text:string): 'interested'|'not_interested'|'manual_review' {
  const normalized=text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim().replace(/[.!]+$/g,'').replace(/\s+/g,' ');
  return negative.has(normalized)?'not_interested':positive.has(normalized)?'interested':'manual_review';
}
export function eligibleComment(at:Date,now=new Date()) { const age=now.getTime()-at.getTime();return Number.isFinite(age)&&age>=0&&age<7*86400000; }
export function openReplyWindow(at:Date|null,now=new Date()) { return !!at&&Number.isFinite(at.getTime())&&now.getTime()>=at.getTime()&&now.getTime()-at.getTime()<86400000; }
export function interestComment(text:string) { return /\b(crm|aula|quero|manda)\b/i.test(text); }
function configInt(name:string,fallback:number,max:number) {const n=Number(process.env[name]??fallback);if(!Number.isInteger(n)||n<1||n>max)throw new Error(`Invalid ${name}`);return n;}
export function outreachConfig() {
  const raw=process.env.CRM_SURVEY_URL;if(!raw)throw new Error('CRM_SURVEY_URL is required');const url=new URL(raw);if(url.protocol!=='https:')throw new Error('CRM_SURVEY_URL must use HTTPS');
  if(process.env.CRM_FOLLOWUP_ENABLED==='true')throw new Error('Follow-up is not implemented and cannot be enabled');
  return {url:url.toString(),batch:configInt('CRM_OUTREACH_BATCH_SIZE',5,50),interval:configInt('CRM_OUTREACH_BATCH_INTERVAL_MINUTES',30,1440)*60000,daily:configInt('CRM_OUTREACH_DAILY_LIMIT',50,500)};
}
export function surveyMessage() { const url=new URL(outreachConfig().url);url.searchParams.set('utm_source','instagram');url.searchParams.set('utm_medium','dm');url.searchParams.set('utm_campaign','pesquisa_semente_crm');return `Boa! É bem rápida 👇\n\n${url}\n\nA principal coisa que estou tentando entender é se você quer usar o CRM no seu próprio negócio ou aprender a oferecer isso para clientes.\n\nQuando eu finalizar o material, quem respondeu vai receber o acesso gratuitamente.`; }
