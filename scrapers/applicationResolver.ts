import dns from 'node:dns/promises';
import net from 'node:net';
import * as cheerio from 'cheerio';

export type ApplicationDestination = { applicationUrl?: string; applicationEmail?: string; applicationInstructions?: string; confidence: number };

const ATS = ['greenhouse.io','grnh.se','lever.co','myworkdayjobs.com','workdayjobs.com','workable.com','breezy.hr','smartrecruiters.com','jobvite.com','recruitee.com','bamboohr.com','successfactors.com','taleo.net','jugglehire.com','hiringplatform.ca','forms.gle','docs.google.com','airtable.com'];
const AGG = ['jobstoapply.com','opportunitydesk.org','fundsforngos.org','opportunitiesforafricans.com','globalsouthopportunities.com','unjobs.org'];
const APPLY = /\b(how to apply|application procedure|application process|apply now|apply here|application form|submit application|to apply|applications should|send your application|send your cv|send your resume)\b/i;

const clean = (v: unknown) => String(v || '').replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/\s+/g,' ').trim();
const host = (v: string) => { try { return new URL(v).hostname.replace(/^www\./,'').toLowerCase(); } catch { return ''; } };
const isPrivate = (ip: string) => {
  if (net.isIPv4(ip)) { const [a,b]=ip.split('.').map(Number); return a===10||a===127||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||a===0; }
  const x=ip.toLowerCase(); return x==='::1'||x==='::'||x.startsWith('fc')||x.startsWith('fd')||x.startsWith('fe80:');
};
async function safeUrl(raw: string) {
  const u=new URL(raw); if(!['http:','https:'].includes(u.protocol)) throw new Error('Unsupported URL');
  if(u.hostname==='localhost'||u.hostname.endsWith('.local')||u.hostname.endsWith('.internal')||(net.isIP(u.hostname)&&isPrivate(u.hostname))) throw new Error('Private URL blocked');
  if(!net.isIP(u.hostname)){const a=await dns.lookup(u.hostname,{all:true});if(!a.length||a.some(x=>isPrivate(x.address)))throw new Error('Private destination blocked');}
  return u;
}
async function fetchSafe(raw: string) {
  let current=(await safeUrl(raw)).toString();
  for(let i=0;i<5;i++){
    const r=await fetch(current,{redirect:'manual',headers:{'user-agent':'Radar/1.0 (+https://radar.tukutuku.org)',accept:'text/html,application/xhtml+xml'},signal:AbortSignal.timeout(15000)});
    if([301,302,303,307,308].includes(r.status)){const loc=r.headers.get('location');if(!loc)throw new Error('Bad redirect');current=(await safeUrl(new URL(loc,current).toString())).toString();continue;}
    if(!r.ok)throw new Error(`Resolver HTTP ${r.status}`);
    const len=Number(r.headers.get('content-length')||0);if(len>4_000_000)throw new Error('Page too large');
    const text=await r.text();if(text.length>4_000_000)throw new Error('Page too large');return {url:current,text};
  }
  throw new Error('Too many redirects');
}
function candidate(raw:string,base:string){try{if(/^mailto:/i.test(raw))return raw;const u=new URL(raw,base);if(!['http:','https:'].includes(u.protocol)||/\.(pdf|docx?|xlsx?|zip)$/i.test(u.pathname))return '';return u.toString();}catch{return '';}}
function score(url:string,label:string,context:string,source:string){
  const t=clean(`${label} ${context}`).toLowerCase(), h=host(url), sh=host(source);let s=0;
  if(ATS.some(x=>h===x||h.endsWith(`.${x}`)))s+=110;
  if(/apply now|apply here|application form|submit application|start application/.test(t))s+=90;else if(/\bapply\b|\bapplication\b/.test(t))s+=45;
  if(/apply|application|vacanc|career|recruit|job|form|submit|portal/i.test(url))s+=30;
  if(/forms\.gle|docs\.google\.com\/forms/i.test(url))s+=120;
  if(h&&sh&&h!==sh)s+=AGG.some(x=>sh===x||sh.endsWith(`.${x}`))?35:10;
  if(/download|privacy|terms|policy|facebook|instagram|twitter|youtube|subscribe|newsletter/i.test(`${t} ${url}`))s-=80;
  return s;
}
function directPortal(url:string){const h=host(url);return ATS.some(x=>h===x||h.endsWith(`.${x}`))||(/linkedin\.com$/.test(h)&&/\/jobs\//i.test(url))||/brightermonday\./i.test(h)||/impactpool\.org$/i.test(h)||/euraxess\.ec\.europa\.eu$/i.test(h)||/grants\.gov$/i.test(h)||/ec\.europa\.eu$/i.test(h);}
function emailOf(text:string){return (clean(text).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig)||[]).find(x=>!/noreply|no-reply|privacy|support|info@jobstoapply/i.test(x));}
function instructions(text:string){
  const t=clean(text), i=t.search(APPLY); if(i<0) return undefined;
  let out=t.slice(i,i+700);
  const boundary=out.slice(80).search(/(related jobs?|other opportunities|share this|newsletter|subscribe|about us|comments?|latest posts?|you may also like|recommended)/i);
  if(boundary>=0) out=out.slice(0,boundary+80);
  return out.replace(/\s+/g,' ').trim().slice(0,600) || undefined;
}

export async function resolveApplicationDestination(sourceUrl:string,seedText=''):Promise<ApplicationDestination>{
  if(directPortal(sourceUrl)) return {applicationUrl:sourceUrl,confidence:0.72};
  const page=await fetchSafe(sourceUrl), $=cheerio.load(page.text), body=clean(`${seedText} ${$('body').text()}`), links:{url:string,score:number}[]=[];
  $('a[href]').each((_i,el)=>{const raw=String($(el).attr('href')||'').trim();if(!raw)return;const url=candidate(raw,page.url);if(!url)return;const ctx=clean($(el).closest('p,li,div,section,article').text()).slice(0,900);const n=score(url,$(el).text(),ctx,page.url);if(n>0)links.push({url,score:n});});
  for(const match of body.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)){const raw=String(match[0]||'').replace(/[.,;:]+$/,'');const url=candidate(raw,page.url);if(!url)continue;const at=match.index||0,ctx=body.slice(Math.max(0,at-260),Math.min(body.length,at+420));const n=score(url,'',ctx,page.url);if(n>0)links.push({url,score:n});}
  links.sort((a,b)=>b.score-a.score);let best=links.find(x=>x.score>=55)?.url;let email:string|undefined;
  if(best?.startsWith('mailto:')){email=best.replace(/^mailto:/i,'').split('?')[0];best=undefined;} else if(!best && APPLY.test(body)) email=emailOf(body);
  if(!best&&directPortal(page.url))best=page.url;
  const how=instructions(body);
  return {applicationUrl:best,applicationEmail:email,applicationInstructions:how,confidence:best?.startsWith('http')?(host(best)===host(page.url)?0.72:0.9):email?0.7:how?0.5:0.2};
}
