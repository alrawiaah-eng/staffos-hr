import {scryptSync,randomBytes,timingSafeEqual,createHash,createCipheriv,createDecipheriv} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
export const permissionLabels={
 'employees.all':'عرض جميع الموظفين','employees.team':'عرض موظفي القسم','employees.edit':'إدارة السجل الوظيفي','salary.view':'عرض الراتب','salary.edit':'تعديل الراتب',
 'documents.view':'عرض المستمسكات','documents.review':'تدقيق المستمسكات','records.edit':'إدارة الدورات والتكريم','profile.review':'اعتماد البيانات الشخصية',
 'leave.manager':'موافقة مسؤول القسم','leave.hr':'موافقة الموارد البشرية','leave.director':'موافقة المدير','leave.balance':'إدارة استحقاق الإجازة السنوية','users.manage':'إدارة المستخدمين والصلاحيات','reports.view':'عرض التقارير','audit.view':'عرض سجل التدقيق'
};
export const roleDefinitions=[
 ['EMPLOYEE','الموظف',[]],
 ['DEPARTMENT_MANAGER','مسؤول القسم',['employees.team','leave.manager','reports.view']],
 ['HR_OFFICER','موظف الموارد البشرية',['employees.all','employees.edit','documents.view','documents.review','records.edit','profile.review','leave.hr','reports.view']],
 ['HR_MANAGER','مدير الموارد البشرية',['employees.all','employees.edit','salary.view','salary.edit','documents.view','documents.review','records.edit','profile.review','leave.hr','leave.balance','reports.view','audit.view']],
 ['DIRECTOR','المدير / المخوّل',['employees.all','leave.director','reports.view']],
 ['SYSTEM_ADMIN','مدير النظام',['employees.all','users.manage','audit.view','reports.view']],
 ['AUDITOR','المدقق',['employees.all','documents.view','reports.view','audit.view']]
];
export function hashPassword(password){const salt=randomBytes(16).toString('hex');return salt+':'+scryptSync(password,salt,64).toString('hex');}
export function verifyPassword(password,stored){try{const [salt,hash]=stored.split(':');return timingSafeEqual(Buffer.from(hash,'hex'),scryptSync(password,salt,64));}catch{return false;}}
export const token=()=>randomBytes(32).toString('hex');
export const digest=value=>createHash('sha256').update(value).digest('hex');
export async function encryptionKey(){
 if(process.env.DOCUMENT_KEY){const key=Buffer.from(process.env.DOCUMENT_KEY,'hex');if(key.length!==32)throw Error('DOCUMENT_KEY must contain 64 hexadecimal characters');return key;}
 if(process.env.NODE_ENV==='production')throw Error('DOCUMENT_KEY is required in production');
 await mkdir('./data',{recursive:true});try{return await readFile('./data/document.key');}catch(e){if(e.code!=='ENOENT')throw e;const key=randomBytes(32);await writeFile('./data/document.key',key,{mode:0o600,flag:'wx'});return key;}
}
export function encrypt(data,key){const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',key,iv);const bytes=Buffer.concat([cipher.update(data),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),bytes]);}
export function decrypt(data,key){const b=Buffer.from(data);const c=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAuthTag(b.subarray(12,28));return Buffer.concat([c.update(b.subarray(28)),c.final()]);}
export const has=(u,p)=>u.permissions.includes(p);
export function scope(u,alias='e'){if(has(u,'employees.all'))return {sql:'TRUE',args:[]};if(has(u,'employees.team'))return {sql:`${alias}.department_id=$1`,args:[u.department_id]};return {sql:`${alias}.id=$1`,args:[u.employee_id]};}
export function canView(u,e){return e.id===u.employee_id||has(u,'employees.all')||(has(u,'employees.team')&&e.department_id===u.department_id);}
export function canApproveLeave(u,l){if(l.employee_id===u.employee_id)return false;return (l.status==='MANAGER'&&has(u,'leave.manager')&&l.manager_id===u.employee_id)||(l.status==='HR'&&has(u,'leave.hr'))||(l.status==='DIRECTOR'&&has(u,'leave.director'));}
