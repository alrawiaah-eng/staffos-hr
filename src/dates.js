const pad=n=>String(n).padStart(2,'0');
export function todayLocal(){const d=new Date();return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;}
export function formatDate(value){
 if(!value)return '—';
 const iso=value instanceof Date?`${value.getFullYear()}-${pad(value.getMonth()+1)}-${pad(value.getDate())}`:String(value).slice(0,10);
 const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);return m?`${m[3]}/${m[2]}/${m[1]}`:'—';
}
export function parseDate(value){
 const normalized=String(value).replace(/[٠-٩۰-۹]/g,c=>String(c.charCodeAt(0)-(c<='٩'?0x660:0x6f0))).trim();
 const m=/^(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})$/.exec(normalized);
 if(!m)return null;
 const [,dd,mm,yyyy]=m;const iso=`${yyyy}-${pad(mm)}-${pad(dd)}`;const parsed=new Date(iso+'T12:00:00Z');
 if(Number(yyyy)<1900||Number(yyyy)>2100||Number.isNaN(parsed.getTime())||parsed.toISOString().slice(0,10)!==iso)return null;
 return iso;
}
export function formatDateTime(value){if(!value)return '—';const d=new Date(value);if(Number.isNaN(d.getTime()))return '—';return `${formatDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;}
