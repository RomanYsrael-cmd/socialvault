const MAX_ENTRIES=100_000,MAX_ENTRY_SIZE=2*1024*1024*1024;
export function isSuspiciousPath(path:string){const normalized=path.replaceAll('\\','/');return normalized.startsWith('/')||/^[a-zA-Z]:\//.test(normalized)||/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalized)||normalized.split('/').some(p=>p==='..'||p.includes('\0'))}
export function validateEntries(entries:{filename:string;uncompressedSize?:number}[]){const warnings:string[]=[];if(entries.length>MAX_ENTRIES) throw new Error('Archive contains too many entries.');for(const e of entries){if(isSuspiciousPath(e.filename)) throw new Error(`Unsafe archive path: ${e.filename}`);if((e.uncompressedSize??0)>MAX_ENTRY_SIZE) warnings.push(`Very large entry was not opened: ${e.filename}`)}return warnings}
export function safeExternalUrl(value:string){try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)?u.toString():undefined}catch{return undefined}}
const FACEBOOK_HOSTS=new Set(['facebook.com','www.facebook.com','m.facebook.com','web.facebook.com','fb.com','www.fb.com']);
export function safeFacebookUrl(value?:string){
  if(!value)return undefined;
  const safe=safeExternalUrl(value);if(!safe)return undefined;
  try{const url=new URL(safe);return url.protocol==='https:'&&!url.username&&!url.password&&FACEBOOK_HOSTS.has(url.hostname.toLowerCase())?url.toString():undefined}catch{return undefined}
}
export function facebookProfileTarget(input:{profileUrl?:string;facebookId?:string;username?:string;displayName?:string}){
  const exact=safeFacebookUrl(input.profileUrl);if(exact)return {url:exact,kind:'exact' as const};
  if(input.facebookId&&/^\d+$/.test(input.facebookId))return {url:`https://www.facebook.com/${encodeURIComponent(input.facebookId)}`,kind:'exact' as const};
  if(input.username&&/^[a-zA-Z0-9.]+$/.test(input.username))return {url:`https://www.facebook.com/${encodeURIComponent(input.username)}`,kind:'exact' as const};
  if(input.displayName?.trim())return {url:`https://www.facebook.com/public/${encodeURIComponent(input.displayName.trim())}`,kind:'search' as const};
  return undefined;
}
