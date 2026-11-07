import express from 'express';
import {photoSummary,photoQueue,registerPhotos} from './photos.js';
import helmet from 'helmet';
import {rateLimit} from 'express-rate-limit';
import {z} from 'zod';
import {one} from './db.js';
import {hashPassword,verifyPassword,token,digest,has,scope,canView,canApproveLeave,permissionLabels,encrypt,decrypt} from './security.js';

const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
const required=(u,p)=>{if(!has(u,p))fail(403,'لا تملك صلاحية هذا الإجراء');};
const str=(max=200)=>z.string().trim().min(1).max(max);
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>!Number.isNaN(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v,'التاريخ غير صحيح');
const personalSchema=z.object({
 first_name:z.string().max(100),middle_name:z.string().max(100),last_name:z.string().max(100),organization_name:z.string().max(180),
 phone:z.string().max(30),mobile:z.string().max(30),email:z.union([z.email(),z.literal('')]),address:z.string().max(500),current_address:z.string().max(500),
 birth_date:z.union([date,z.literal('')]),birth_place:z.string().max(100),gender:z.string().max(30),nationality:z.string().max(80),other_nationality:z.string().max(80),
 marital_status:z.enum(['أعزب','متزوج','مطلق','أرمل','منفصل']),caza:z.string().max(100),mohafaza:z.string().max(100),country:z.string().max(100),area:z.string().max(100),city:z.string().max(100),region:z.string().max(100),street:z.string().max(150),building:z.string().max(50),floor:z.string().max(30),
 social_security_no:z.string().max(80),financial_no:z.string().max(80),blood_type:z.string().max(10),driving_license:z.string().max(30),
 passport_no:z.string().max(80),passport_expiry:z.union([date,z.literal('')]),residency:z.string().max(120),authorized_to_work_in:z.string().max(180),work_permit_no:z.string().max(80),work_permit_expiry:z.union([date,z.literal('')]),
 family:z.array(z.object({name:str(120),relation:str(60),birth_date:z.union([date,z.literal('')]),birth_place:z.string().max(100),profession:z.string().max(150)})).max(20),
 spouse_employment_company:z.string().max(180),spouse_social_security_no:z.string().max(80),
 emergency_primary_name:z.string().max(120),emergency_primary_relationship:z.string().max(80),emergency_primary_address:z.string().max(500),emergency_primary_phone:z.string().max(30),
 emergency_secondary_name:z.string().max(120),emergency_secondary_relationship:z.string().max(80),emergency_secondary_address:z.string().max(500),emergency_secondary_phone:z.string().max(30),
 benefit_housing:z.string().max(10),benefit_housing_specify:z.string().max(150),benefit_transportation:z.string().max(10),benefit_transportation_specify:z.string().max(150),benefit_mobile:z.string().max(10),benefit_mobile_specify:z.string().max(150),benefit_company_car:z.string().max(10),benefit_company_car_specify:z.string().max(150),benefit_commission:z.string().max(10),benefit_commission_specify:z.string().max(150),benefit_bonus:z.string().max(10),benefit_bonus_specify:z.string().max(150),benefit_air_ticket:z.string().max(10),benefit_air_ticket_specify:z.string().max(150),benefit_medical_insurance:z.string().max(10),benefit_medical_insurance_specify:z.string().max(150),benefit_life_insurance:z.string().max(10),benefit_life_insurance_specify:z.string().max(150)
}).partial().strict();
const decisionSchema=z.object({decision:z.enum(['APPROVE','REJECT']),comment:z.string().trim().max(1000).default('')}).refine(d=>d.decision!=='REJECT'||d.comment.length>0,'سبب الرفض مطلوب');
const media=z.object({data:z.string().max(7_000_000),mime:z.enum(['image/png','image/jpeg','application/pdf'])});
function fileBytes(file,imagesOnly=false){
 if(!file)return null;const bytes=Buffer.from(file.data,'base64');if(bytes.length===0||bytes.length>5*1024*1024)fail(400,'الملف يجب أن يكون أقل من 5 ميغابايت');
 const jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
 const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 const pdf=bytes.subarray(0,5).toString()==='%PDF-';
 if(!(file.mime==='image/jpeg'&&jpeg||file.mime==='image/png'&&png||!imagesOnly&&file.mime==='application/pdf'&&pdf))fail(400,'نوع الملف أو محتواه غير مدعوم');
 return bytes;
}
async function audit(db,u,action,entity,id,before=null,after=null){await db.query('INSERT INTO audit_logs(actor_id,action,entity,entity_id,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6)',[u?.id||null,action,entity,String(id),before==null?null:JSON.stringify(before),after==null?null:JSON.stringify(after)]);}
async function notify(db,employeeId,title,body,link='/leave'){await db.query('INSERT INTO notifications(user_id,title,body,link) SELECT id,$2,$3,$4 FROM users WHERE employee_id=$1 AND active=true',[employeeId,title,body,link]);}
async function notifyPermission(db,p,title,body,link,exclude){await db.query('INSERT INTO notifications(user_id,title,body,link) SELECT u.id,$2,$3,$4 FROM users u JOIN roles r ON r.code=u.role WHERE u.active=true AND r.permissions ? $1 AND u.employee_id<>$5',[p,title,body,link,exclude]);}
async function routeNotice(db,l){
 if(l.status==='MANAGER'){const e=await one(db,'SELECT d.manager_id FROM employees e JOIN departments d ON d.id=e.department_id WHERE e.id=$1',[l.employee_id]);await notify(db,e.manager_id,'طلب إجازة بانتظارك',`الطلب #${l.id} يحتاج موافقتك`,'/approvals');}
 else if(['HR','DIRECTOR'].includes(l.status))await notifyPermission(db,l.status==='HR'?'leave.hr':'leave.director','طلب إجازة بانتظارك',`الطلب #${l.id} يحتاج موافقتك`,'/approvals',l.employee_id);
}
async function employee(db,u,id){const e=await one(db,'SELECT e.*,d.name department,d.manager_id FROM employees e JOIN departments d ON d.id=e.department_id WHERE e.id=$1',[id]);if(!e)fail(404,'الموظف غير موجود');if(!canView(u,e))fail(403,'لا يمكنك الوصول إلى هذا السجل');return e;}
function safeEmployee(u,e){const result={...e};if(!has(u,'salary.view'))delete result.salary;if(e.id!==u.employee_id&&!has(u,'documents.view')&&!has(u,'employees.edit')){delete result.personal;}return result;}
export async function expiryScan(db){
 await db.query(`INSERT INTO notifications(user_id,title,body,link,dedupe_key)
 SELECT u.id,'تنبيه انتهاء مستمسك',e.name || ' — ' || d.kind || ' — ' || to_char(d.expires_on,'DD/MM/YYYY'),'/employees/'||e.id,'expiry:'||d.id||':'||d.expires_on||':'||u.id
 FROM documents d JOIN employees e ON e.id=d.employee_id CROSS JOIN users u JOIN roles r ON r.code=u.role
 WHERE d.status<>'REJECTED' AND d.expires_on<=current_date+30 AND u.active=true AND (u.employee_id=e.id OR r.permissions ? 'documents.review') ON CONFLICT(dedupe_key) DO NOTHING`);
}
export function createApp(db,key,{production=false}={}){
 const app=express();app.disable('x-powered-by');
 app.use(helmet({contentSecurityPolicy:production?undefined:false}));
 app.use(express.json({limit:'15mb'}));
 app.use('/api',(req,res,next)=>{res.setHeader('Cache-Control','no-store');if(!['GET','HEAD','OPTIONS'].includes(req.method)){
  const origin=req.get('origin');const allowed=process.env.APP_ORIGIN||'http://localhost:3000';
  if((origin&&origin!==allowed)||req.get('sec-fetch-site')==='cross-site')return res.status(403).json({error:'مصدر الطلب غير مسموح'});
 }next();});
 app.get('/api/health',async(req,res)=>{await db.query('SELECT 1');res.json({ok:true,service:'hr-leave-v1'});});
 app.get('/api/config',(req,res)=>res.json({demo:!production&&process.env.SEED_DEMO!=='false'}));
 const dummy=hashPassword('invalid-login-dummy');
 app.post('/api/login',rateLimit({windowMs:15*60*1000,limit:30,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'محاولات كثيرة. أعد المحاولة بعد 15 دقيقة'}}),async(req,res)=>{
  const b=z.object({username:str(80),password:str(200)}).parse(req.body);
  const u=await one(db,'SELECT * FROM users WHERE username=$1',[b.username.toLowerCase()]);
  const valid=verifyPassword(b.password,u?.password_hash||dummy);
  if(!u||!valid||!u.active)fail(401,'اسم المستخدم أو كلمة المرور غير صحيحة');
  const session=token(),csrf=token();await db.transaction(async tx=>{await tx.query("DELETE FROM sessions WHERE expires_at<now()");await tx.query("INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '8 hours')",[digest(session),u.id,csrf]);await audit(tx,u,'LOGIN','user',u.id);});
  res.cookie('hr_session',session,{httpOnly:true,sameSite:'strict',secure:production,maxAge:8*60*60*1000,path:'/'});res.json({ok:true});
 });
 app.use('/api',async(req,res,next)=>{
  const raw=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('hr_session='))?.slice(11);
  if(!raw)return res.status(401).json({error:'يرجى تسجيل الدخول'});
  req.user=await one(db,`SELECT u.id,u.username,u.employee_id,u.role,e.name,e.department_id,r.label role_label,r.permissions,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id JOIN employees e ON e.id=u.employee_id JOIN roles r ON r.code=u.role WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true`,[digest(raw)]);
  if(!req.user)return res.status(401).json({error:'انتهت الجلسة، سجل الدخول مجددًا'});
  req.sessionHash=digest(raw);
  if(!['GET','HEAD','OPTIONS'].includes(req.method)&&req.get('x-csrf-token')!==req.user.csrf)return res.status(403).json({error:'رمز حماية الطلب غير صحيح'});
  next();
 });
 app.get('/api/me',(req,res)=>res.json(req.user));
 app.post('/api/logout',async(req,res)=>{await db.query('DELETE FROM sessions WHERE token_hash=$1',[req.sessionHash]);res.clearCookie('hr_session',{path:'/'});res.json({ok:true});});
 app.get('/api/meta',async(req,res)=>res.json({departments:(await db.query('SELECT * FROM departments ORDER BY id')).rows,leaveTypes:(await db.query('SELECT * FROM leave_types ORDER BY code')).rows,permissionLabels}));
 app.get('/api/employees',async(req,res)=>{const s=scope(req.user);const rows=(await db.query(`SELECT e.*,d.name department FROM employees e JOIN departments d ON d.id=e.department_id WHERE ${s.sql} ORDER BY e.id`,s.args)).rows;res.json(rows.map(e=>{const v=safeEmployee(req.user,e);delete v.education;delete v.employment_history;delete v.personal;return v;}));});
 app.get('/api/employees/:id',async(req,res)=>{
  const e=await employee(db,req.user,req.params.id);
  const balance=await one(db,'SELECT * FROM leave_balances WHERE employee_id=$1 AND year=$2',[e.id,new Date().getFullYear()]);
  const changes=e.id===req.user.employee_id||has(req.user,'profile.review')?(await db.query('SELECT c.*,u.username reviewer FROM profile_changes c LEFT JOIN users u ON u.id=c.reviewer_id WHERE c.employee_id=$1 ORDER BY c.id DESC',[e.id])).rows:[];
  res.json({...safeEmployee(req.user,e),balance,changes,...await photoSummary(db,req.user,e.id)});
 });
 const employmentSchema=z.object({employee_no:str(30),name:str(180),department_id:z.coerce.number().int().positive(),job_title:str(120),location:str(120),joined_on:date,status:z.enum(['ACTIVE','INACTIVE']),contract_type:str(80),contract_end:date.nullable(),salary:z.coerce.number().min(0).max(1e12).optional(),job_grade:z.string().max(80).optional().default(''),employment_status:z.string().max(50).optional().default(''),supervisor_name:z.string().max(180).optional().default(''),supervisor_title:z.string().max(120).optional().default(''),variable_monthly:z.coerce.number().min(0).max(1e12).optional().default(0),nssf_status:z.string().max(30).optional().default(''),nssf_no:z.string().max(80).optional().default(''),education:z.array(z.object({from:z.string().max(7).optional().default(''),to:z.string().max(7).optional().default(''),degree:str(100),institution:str(150),year:z.string().max(4).optional().default('')})).max(30).default([]),employment_history:z.array(z.object({from:z.string().max(7).optional().default(''),to:z.string().max(7).optional().default(''),title:str(150),organization:z.string().max(180).optional().default(''),responsibilities:z.string().max(1000).optional().default(''),date:z.union([date,z.literal('')]).optional().default(''),notes:z.string().max(500).optional().default('')})).max(100).default([])}).strict();
 app.post('/api/employees',async(req,res)=>{
  required(req.user,'employees.edit');const b=employmentSchema.parse(req.body);if(b.salary!==undefined)required(req.user,'salary.edit');
  const id=await db.transaction(async tx=>{const details={job_grade:b.job_grade,employment_status:b.employment_status,supervisor_name:b.supervisor_name,supervisor_title:b.supervisor_title,variable_monthly:b.variable_monthly,nssf_status:b.nssf_status,nssf_no:b.nssf_no};const e=await one(tx,'INSERT INTO employees(employee_no,name,department_id,job_title,location,joined_on,status,contract_type,contract_end,salary,employment_details,education,employment_history) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id',[b.employee_no,b.name,b.department_id,b.job_title,b.location,b.joined_on,b.status,b.contract_type,b.contract_end,b.salary||0,JSON.stringify(details),JSON.stringify(b.education),JSON.stringify(b.employment_history)]);await tx.query('INSERT INTO leave_balances(employee_id,year) VALUES($1,$2)',[e.id,new Date().getFullYear()]);await audit(tx,req.user,'CREATE','employee',e.id,null,b);return e.id;});res.status(201).json({id});
 });
 app.put('/api/employees/:id',async(req,res)=>{
  required(req.user,'employees.edit');const b=employmentSchema.parse(req.body);if(b.salary!==undefined)required(req.user,'salary.edit');
  await db.transaction(async tx=>{const e=await employee(tx,req.user,req.params.id);const details={job_grade:b.job_grade,employment_status:b.employment_status,supervisor_name:b.supervisor_name,supervisor_title:b.supervisor_title,variable_monthly:b.variable_monthly,nssf_status:b.nssf_status,nssf_no:b.nssf_no};await tx.query('UPDATE employees SET employee_no=$2,name=$3,department_id=$4,job_title=$5,location=$6,joined_on=$7,status=$8,contract_type=$9,contract_end=$10,salary=COALESCE($11,salary),employment_details=$12,education=$13,employment_history=$14 WHERE id=$1',[e.id,b.employee_no,b.name,b.department_id,b.job_title,b.location,b.joined_on,b.status,b.contract_type,b.contract_end,b.salary??null,JSON.stringify(details),JSON.stringify(b.education),JSON.stringify(b.employment_history)]);await audit(tx,req.user,'UPDATE','employee',e.id,e,b);});res.json({ok:true});
 });
 app.post('/api/profile-changes',async(req,res)=>{
  const b=personalSchema.parse(req.body);await db.transaction(async tx=>{const e=await one(tx,'SELECT * FROM employees WHERE id=$1 FOR UPDATE',[req.user.employee_id]);const row=await one(tx,'INSERT INTO profile_changes(employee_id,proposed,previous) VALUES($1,$2,$3) RETURNING id',[e.id,JSON.stringify(b),JSON.stringify(e.personal)]);await audit(tx,req.user,'SUBMIT','profile_change',row.id,e.personal,b);await notifyPermission(tx,'profile.review','طلب تعديل بيانات',e.name,'/approvals',e.id);});res.status(201).json({ok:true});
 });
 app.get('/api/employees/:id/balances',async(req,res)=>{
  const e=await employee(db,req.user,req.params.id);
  res.json((await db.query(`SELECT b.*,COALESCE((SELECT sum(l.days) FROM leave_requests l JOIN leave_types t ON t.code=l.type WHERE l.employee_id=b.employee_id AND EXTRACT(YEAR FROM l.start_date)=b.year AND l.status IN ('MANAGER','HR','DIRECTOR') AND t.deducts=true),0)::integer reserved FROM leave_balances b WHERE b.employee_id=$1 ORDER BY b.year DESC`,[e.id])).rows);
 });
 app.put('/api/employees/:id/balances/:year',async(req,res)=>{
  required(req.user,'leave.balance');const b=z.object({entitlement:z.number().int().min(0).max(366),reason:str(1000)}).strict().parse(req.body);
  const year=z.coerce.number().int().min(1900).max(2100).parse(req.params.year);
  await db.transaction(async tx=>{
   const e=await employee(tx,req.user,req.params.id);await tx.query('SELECT id FROM employees WHERE id=$1 FOR UPDATE',[e.id]);
   const old=await one(tx,'SELECT * FROM leave_balances WHERE employee_id=$1 AND year=$2',[e.id,year]);
   const reserved=await one(tx,"SELECT COALESCE(sum(l.days),0)::integer n FROM leave_requests l JOIN leave_types t ON t.code=l.type WHERE l.employee_id=$1 AND EXTRACT(YEAR FROM l.start_date)=$2 AND l.status IN ('MANAGER','HR','DIRECTOR') AND t.deducts=true",[e.id,year]);
   if(b.entitlement<(old?.used||0)+reserved.n)fail(409,'الاستحقاق لا يمكن أن يقل عن المستخدم والأيام المحجوزة للطلبات المعلقة');
   await tx.query('INSERT INTO leave_balances(employee_id,year,entitlement) VALUES($1,$2,$3) ON CONFLICT(employee_id,year) DO UPDATE SET entitlement=EXCLUDED.entitlement',[e.id,year,b.entitlement]);
   await audit(tx,req.user,'UPDATE','leave_balance',`${e.id}:${year}`,old,{employee_id:e.id,year,entitlement:b.entitlement,used:old?.used||0,reason:b.reason});
   await notify(tx,e.id,'تحديث استحقاق الإجازة',`سنة ${year}: ${b.entitlement} يوم. ${b.reason}`,`/employees/${e.id}`);
  });res.json({ok:true});
 });
 app.post('/api/profile-changes/:id/decision',async(req,res)=>{
  required(req.user,'profile.review');const b=decisionSchema.parse(req.body);
  await db.transaction(async tx=>{const c=await one(tx,'SELECT * FROM profile_changes WHERE id=$1 FOR UPDATE',[req.params.id]);if(!c)fail(404,'الطلب غير موجود');if(c.employee_id===req.user.employee_id)fail(403,'لا يمكنك اعتماد تعديلك الشخصي');if(c.status!=='PENDING')fail(409,'تمت معالجة الطلب مسبقًا');
   if(b.decision==='APPROVE')await tx.query('UPDATE employees SET personal=$2 WHERE id=$1',[c.employee_id,JSON.stringify(c.proposed)]);
   await tx.query('UPDATE profile_changes SET status=$2,reviewer_id=$3,comment=$4 WHERE id=$1',[c.id,b.decision==='APPROVE'?'APPROVED':'REJECTED',req.user.id,b.comment]);await audit(tx,req.user,b.decision,'profile_change',c.id,c.previous,c.proposed);await notify(tx,c.employee_id,'تحديث طلب البيانات',b.decision==='APPROVE'?'تم اعتماد بياناتك الشخصية':`تم رفض التعديل: ${b.comment}`,`/employees/${c.employee_id}`);
  });res.json({ok:true});
 });
 app.get('/api/documents',async(req,res)=>{
  const s=scope(req.user);const docs=(await db.query(`SELECT d.id,d.employee_id,e.name employee,d.kind,d.number,d.expires_on,d.status,d.comment,d.created_at,(d.back_data IS NOT NULL) has_back FROM documents d JOIN employees e ON e.id=d.employee_id WHERE ${s.sql} ORDER BY d.id DESC`,s.args)).rows;
  res.json(docs.filter(d=>d.employee_id===req.user.employee_id||has(req.user,'documents.view')));
 });
 app.post('/api/documents',async(req,res)=>{
  const b=z.object({employee_id:z.coerce.number().int().positive(),kind:z.enum(['IDENTITY','RESIDENCE','CLEARANCE','PASSPORT','DRIVING']),number:z.string().max(100),expires_on:date.nullable(),front:media,back:media.nullable().optional()}).parse(req.body);
  await employee(db,req.user,b.employee_id);if(b.employee_id!==req.user.employee_id)required(req.user,'documents.review');
  if(['IDENTITY','RESIDENCE','CLEARANCE'].includes(b.kind)&&!b.back)fail(400,'صورة الوجه الخلفي مطلوبة لهذا المستمسك');
  const front=encrypt(fileBytes(b.front,true),key),back=b.back?encrypt(fileBytes(b.back,true),key):null;
  await db.transaction(async tx=>{const d=await one(tx,'INSERT INTO documents(employee_id,kind,number,expires_on,front_data,front_mime,back_data,back_mime) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',[b.employee_id,b.kind,b.number,b.expires_on,front,b.front.mime,back,b.back?.mime||null]);await audit(tx,req.user,'UPLOAD','document',d.id,null,{kind:b.kind,employee_id:b.employee_id});await notifyPermission(tx,'documents.review','مستمسك يحتاج تدقيقًا',`المستمسك #${d.id}`,'/approvals',b.employee_id);});await expiryScan(db);res.status(201).json({ok:true});
 });
 app.get('/api/documents/:id/:side',async(req,res)=>{
  if(!['front','back'].includes(req.params.side))fail(404,'الملف غير موجود');const d=await one(db,'SELECT * FROM documents WHERE id=$1',[req.params.id]);if(!d)fail(404,'الملف غير موجود');await employee(db,req.user,d.employee_id);if(d.employee_id!==req.user.employee_id)required(req.user,'documents.view');
  const bytes=d[`${req.params.side}_data`];if(!bytes)fail(404,'الوجه الخلفي غير مرفق');await audit(db,req.user,'VIEW_FILE','document',d.id);res.type(d[`${req.params.side}_mime`]).set('Content-Disposition','inline').send(decrypt(bytes,key));
 });
 app.post('/api/documents/:id/decision',async(req,res)=>{
  required(req.user,'documents.review');const b=decisionSchema.parse(req.body);
  await db.transaction(async tx=>{const d=await one(tx,'SELECT id,employee_id,status FROM documents WHERE id=$1 FOR UPDATE',[req.params.id]);if(!d)fail(404,'المستمسك غير موجود');if(d.employee_id===req.user.employee_id)fail(403,'لا يمكنك تدقيق مستمسكك بنفسك');if(d.status!=='PENDING')fail(409,'تمت معالجة المستمسك مسبقًا');await tx.query('UPDATE documents SET status=$2,reviewer_id=$3,comment=$4 WHERE id=$1',[d.id,b.decision==='APPROVE'?'APPROVED':'REJECTED',req.user.id,b.comment]);await audit(tx,req.user,b.decision,'document',d.id,d,{decision:b.decision,comment:b.comment});await notify(tx,d.employee_id,'نتيجة تدقيق المستمسك',b.decision==='APPROVE'?'تم اعتماد المستمسك':`تم رفض المستمسك: ${b.comment}`,'/documents');});res.json({ok:true});
 });
 app.get('/api/records',async(req,res)=>{const s=scope(req.user);res.json((await db.query(`SELECT r.id,r.employee_id,e.name employee,r.kind,r.title,r.issuer,r.date,r.notes,(r.attachment IS NOT NULL) has_attachment FROM records r JOIN employees e ON e.id=r.employee_id WHERE ${s.sql} ORDER BY r.date DESC,r.id DESC`,s.args)).rows);});
 app.post('/api/records',async(req,res)=>{
  required(req.user,'records.edit');const b=z.object({employee_id:z.coerce.number().int().positive(),kind:z.enum(['TRAINING','THANKS','AWARD']),title:str(200),issuer:str(200),date,notes:z.string().max(2000),attachment:media.nullable().optional()}).parse(req.body);await employee(db,req.user,b.employee_id);
  await db.transaction(async tx=>{const r=await one(tx,'INSERT INTO records(employee_id,kind,title,issuer,date,notes,attachment,attachment_mime) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',[b.employee_id,b.kind,b.title,b.issuer,b.date,b.notes,b.attachment?encrypt(fileBytes(b.attachment),key):null,b.attachment?.mime||null]);await audit(tx,req.user,'CREATE','record',r.id,null,{title:b.title,kind:b.kind});await notify(tx,b.employee_id,'إضافة إلى سجلك الوظيفي',b.title,'/records');});res.status(201).json({ok:true});
 });
 app.get('/api/records/:id/attachment',async(req,res)=>{const r=await one(db,'SELECT * FROM records WHERE id=$1',[req.params.id]);if(!r?.attachment)fail(404,'المرفق غير موجود');await employee(db,req.user,r.employee_id);await audit(db,req.user,'VIEW_FILE','record',r.id);res.type(r.attachment_mime).set('Content-Disposition','attachment; filename="attachment"').send(decrypt(r.attachment,key));});
 app.put('/api/records/:id',async(req,res)=>{
  required(req.user,'records.edit');
  const b=z.object({kind:z.enum(['TRAINING','THANKS','AWARD']),title:str(200),issuer:str(200),date,notes:z.string().max(2000),attachment:media.nullable().optional(),remove_attachment:z.boolean().default(false)}).strict().parse(req.body);
  if(b.attachment&&b.remove_attachment)fail(400,'اختر استبدال المرفق أو إزالته');
  const attachment=b.attachment?encrypt(fileBytes(b.attachment),key):null;
  await db.transaction(async tx=>{
   const old=await one(tx,'SELECT id,employee_id,kind,title,issuer,date,notes,(attachment IS NOT NULL) has_attachment FROM records WHERE id=$1 FOR UPDATE',[req.params.id]);if(!old)fail(404,'السجل غير موجود');await employee(tx,req.user,old.employee_id);
   await tx.query('UPDATE records SET kind=$2,title=$3,issuer=$4,date=$5,notes=$6,attachment=CASE WHEN $7 THEN NULL WHEN $8::bytea IS NOT NULL THEN $8 ELSE attachment END,attachment_mime=CASE WHEN $7 THEN NULL WHEN $8::bytea IS NOT NULL THEN $9 ELSE attachment_mime END WHERE id=$1',[old.id,b.kind,b.title,b.issuer,b.date,b.notes,b.remove_attachment,attachment,b.attachment?.mime||null]);
   await audit(tx,req.user,'UPDATE','record',old.id,old,{kind:b.kind,title:b.title,issuer:b.issuer,date:b.date,notes:b.notes,attachment_changed:!!b.attachment||b.remove_attachment});await notify(tx,old.employee_id,'تحديث السجل الوظيفي',b.title,'/records');
  });res.json({ok:true});
 });
 app.get('/api/leave',async(req,res)=>{
  const s=scope(req.user);res.json((await db.query(`SELECT l.*,e.name employee,d.name department,d.manager_id,t.label type_label FROM leave_requests l JOIN employees e ON e.id=l.employee_id JOIN departments d ON d.id=e.department_id JOIN leave_types t ON t.code=l.type WHERE ${s.sql} ORDER BY l.id DESC`,s.args)).rows);
 });
 app.get('/api/leave/:id/history',async(req,res)=>{const l=await one(db,'SELECT * FROM leave_requests WHERE id=$1',[req.params.id]);if(!l)fail(404,'الطلب غير موجود');await employee(db,req.user,l.employee_id);res.json((await db.query('SELECT a.*,u.username actor FROM leave_approvals a JOIN users u ON u.id=a.actor_id WHERE leave_id=$1 ORDER BY a.id',[l.id])).rows);});
 app.post('/api/leave',async(req,res)=>{
  const b=z.object({type:str(30),start_date:date,end_date:date,reason:str(1000)}).parse(req.body);
  const days=Math.round((Date.parse(b.end_date)-Date.parse(b.start_date))/86400000)+1;
  if(days<1||days>366)fail(400,'نطاق الإجازة غير صحيح');if(b.start_date<new Date().toISOString().slice(0,10))fail(400,'لا يمكن تقديم إجازة بتاريخ سابق');if(b.start_date.slice(0,4)!==b.end_date.slice(0,4))fail(400,'قدّم طلبًا منفصلًا لكل سنة');
  const result=await db.transaction(async tx=>{
   const e=await one(tx,'SELECT * FROM employees WHERE id=$1 FOR UPDATE',[req.user.employee_id]);if(e.status!=='ACTIVE')fail(403,'الحساب الوظيفي غير نشط');const t=await one(tx,'SELECT * FROM leave_types WHERE code=$1',[b.type]);if(!t)fail(400,'نوع الإجازة غير صحيح');
   const overlap=await one(tx,"SELECT id FROM leave_requests WHERE employee_id=$1 AND status NOT IN ('REJECTED','CANCELLED') AND start_date<=$3 AND end_date>=$2",[e.id,b.start_date,b.end_date]);if(overlap)fail(409,'تتداخل التواريخ مع طلب إجازة قائم');
   const year=Number(b.start_date.slice(0,4));await tx.query('INSERT INTO leave_balances(employee_id,year) VALUES($1,$2) ON CONFLICT DO NOTHING',[e.id,year]);
   if(t.deducts){const bal=await one(tx,'SELECT * FROM leave_balances WHERE employee_id=$1 AND year=$2',[e.id,year]);const pending=await one(tx,"SELECT COALESCE(sum(l.days),0)::integer total FROM leave_requests l JOIN leave_types t ON t.code=l.type WHERE employee_id=$1 AND EXTRACT(YEAR FROM start_date)=$2 AND status IN ('MANAGER','HR','DIRECTOR') AND t.deducts=true",[e.id,year]);if(bal.entitlement-bal.used-pending.total<days)fail(400,'رصيد الإجازة المتاح لا يكفي بعد احتساب الطلبات المعلّقة');}
   const d=await one(tx,'SELECT * FROM departments WHERE id=$1',[e.department_id]);
   const manager=d.manager_id&&d.manager_id!==e.id?await one(tx,"SELECT u.id FROM users u JOIN roles r ON r.code=u.role WHERE u.employee_id=$1 AND u.active=true AND r.permissions ? 'leave.manager'",[d.manager_id]):null;
   const stage=manager?'MANAGER':'HR';
   const l=await one(tx,'INSERT INTO leave_requests(employee_id,type,start_date,end_date,days,reason,status,director_required) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[e.id,b.type,b.start_date,b.end_date,days,b.reason,stage,t.director_required||days>7]);
   await audit(tx,req.user,'SUBMIT','leave',l.id,null,l);await routeNotice(tx,l);return l;
  });res.status(201).json(result);
 });
 app.post('/api/leave/:id/decision',async(req,res)=>{
  const b=decisionSchema.parse(req.body);await db.transaction(async tx=>{
   const l=await one(tx,'SELECT * FROM leave_requests WHERE id=$1 FOR UPDATE',[req.params.id]);if(!l)fail(404,'الطلب غير موجود');const d=await one(tx,'SELECT d.manager_id FROM employees e JOIN departments d ON d.id=e.department_id WHERE e.id=$1',[l.employee_id]);
   if(!canApproveLeave(req.user,{...l,...d}))fail(403,'لا يمكنك اعتماد هذا الطلب في مرحلته الحالية');
   const status=b.decision==='REJECT'?'REJECTED':l.status==='MANAGER'?'HR':l.status==='HR'&&l.director_required?'DIRECTOR':'APPROVED';
   if(status==='APPROVED'){
    await tx.query('SELECT id FROM employees WHERE id=$1 FOR UPDATE',[l.employee_id]);const t=await one(tx,'SELECT * FROM leave_types WHERE code=$1',[l.type]);
    if(t.deducts){const year=new Date(l.start_date).getUTCFullYear();const bal=await one(tx,'UPDATE leave_balances SET used=used+$3 WHERE employee_id=$1 AND year=$2 AND entitlement-used>=$3 RETURNING employee_id',[l.employee_id,year,l.days]);if(!bal)fail(409,'رصيد الموظف غير كافٍ للاعتماد');}
   }
   await tx.query('UPDATE leave_requests SET status=$2 WHERE id=$1',[l.id,status]);await tx.query('INSERT INTO leave_approvals(leave_id,actor_id,stage,decision,comment) VALUES($1,$2,$3,$4,$5)',[l.id,req.user.id,l.status,b.decision,b.comment]);await audit(tx,req.user,b.decision,'leave',l.id,{status:l.status},{status,comment:b.comment});await notify(tx,l.employee_id,'تحديث طلب الإجازة',`الطلب #${l.id}: ${status==='APPROVED'?'موافق عليه':status==='REJECTED'?'مرفوض — '+b.comment:'انتقل إلى المرحلة التالية'}`);await routeNotice(tx,{...l,status});
  });res.json({ok:true});
 });
 app.post('/api/leave/:id/cancel',async(req,res)=>{await db.transaction(async tx=>{const l=await one(tx,'SELECT * FROM leave_requests WHERE id=$1 FOR UPDATE',[req.params.id]);if(!l)fail(404,'الطلب غير موجود');if(l.employee_id!==req.user.employee_id)fail(403,'يمكنك إلغاء طلباتك فقط');if(!['MANAGER','HR','DIRECTOR'].includes(l.status))fail(409,'يمكن إلغاء الطلب قبل الاعتماد النهائي فقط');await tx.query("UPDATE leave_requests SET status='CANCELLED' WHERE id=$1",[l.id]);await audit(tx,req.user,'CANCEL','leave',l.id,{status:l.status},{status:'CANCELLED'});});res.json({ok:true});});
 app.get('/api/approvals',async(req,res)=>{
  const leaves=(await db.query("SELECT l.*,e.name employee,d.manager_id,t.label type_label FROM leave_requests l JOIN employees e ON e.id=l.employee_id JOIN departments d ON d.id=e.department_id JOIN leave_types t ON t.code=l.type WHERE l.status IN ('MANAGER','HR','DIRECTOR') ORDER BY l.id",[])).rows.filter(l=>canApproveLeave(req.user,l));
  const changes=has(req.user,'profile.review')?(await db.query("SELECT c.*,e.name employee FROM profile_changes c JOIN employees e ON e.id=c.employee_id WHERE c.status='PENDING' AND c.employee_id<>$1 ORDER BY c.id",[req.user.employee_id])).rows:[];
  const documents=has(req.user,'documents.review')?(await db.query("SELECT d.id,d.employee_id,e.name employee,d.kind,d.number,d.expires_on,(d.back_data IS NOT NULL) has_back FROM documents d JOIN employees e ON e.id=d.employee_id WHERE d.status='PENDING' AND d.employee_id<>$1 ORDER BY d.id",[req.user.employee_id])).rows:[];
  res.json({leaves,changes,documents,photos:await photoQueue(db,req.user)});
 });
 app.get('/api/notifications',async(req,res)=>{await expiryScan(db);res.json((await db.query('SELECT * FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 200',[req.user.id])).rows);});
 app.post('/api/notifications/read',async(req,res)=>{const b=z.object({id:z.number().int().positive().optional()}).parse(req.body);await db.query('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND ($2::integer IS NULL OR id=$2)',[req.user.id,b.id||null]);res.json({ok:true});});
 app.get('/api/users',async(req,res)=>{required(req.user,'users.manage');res.json({users:(await db.query('SELECT u.id,u.username,u.employee_id,u.role,u.active,e.name FROM users u JOIN employees e ON e.id=u.employee_id ORDER BY u.id')).rows,roles:(await db.query('SELECT * FROM roles ORDER BY code')).rows,permissionLabels});});
 app.post('/api/departments',async(req,res)=>{
  required(req.user,'users.manage');const b=z.object({name:str(120)}).parse(req.body);
  await db.transaction(async tx=>{const d=await one(tx,'INSERT INTO departments(name) VALUES($1) RETURNING id',[b.name]);await audit(tx,req.user,'CREATE','department',d.id,null,b);});res.status(201).json({ok:true});
 });
 app.put('/api/departments/:id',async(req,res)=>{
  required(req.user,'users.manage');const b=z.object({name:str(120),manager_id:z.number().int().positive().nullable()}).parse(req.body);
  await db.transaction(async tx=>{const d=await one(tx,'SELECT * FROM departments WHERE id=$1 FOR UPDATE',[req.params.id]);if(!d)fail(404,'القسم غير موجود');
   if(b.manager_id){const manager=await one(tx,"SELECT u.id FROM users u JOIN employees e ON e.id=u.employee_id JOIN roles r ON r.code=u.role WHERE e.id=$1 AND e.department_id=$2 AND u.active=true AND r.permissions ? 'leave.manager'",[b.manager_id,d.id]);if(!manager)fail(400,'اختر موظفًا نشطًا من القسم يمتلك صلاحية موافقة مسؤول القسم');}
   await tx.query('UPDATE departments SET name=$2,manager_id=$3 WHERE id=$1',[d.id,b.name,b.manager_id]);
   if(!b.manager_id){const moved=(await tx.query("UPDATE leave_requests l SET status='HR' FROM employees e WHERE l.employee_id=e.id AND e.department_id=$1 AND l.status='MANAGER' RETURNING l.*",[d.id])).rows;for(const l of moved){await audit(tx,req.user,'REROUTE','leave',l.id,{status:'MANAGER'},{status:'HR'});await routeNotice(tx,l);}}
   await audit(tx,req.user,'UPDATE','department',d.id,d,b);
  });res.json({ok:true});
 });
 app.post('/api/users',async(req,res)=>{
  required(req.user,'users.manage');const b=z.object({username:z.string().regex(/^[a-z0-9._-]{3,50}$/),password:z.string().min(12).max(128),employee_id:z.coerce.number().int().positive(),role:str(40)}).parse(req.body);
  await db.transaction(async tx=>{const u=await one(tx,'INSERT INTO users(username,password_hash,employee_id,role) VALUES($1,$2,$3,$4) RETURNING id',[b.username,hashPassword(b.password),b.employee_id,b.role]);await audit(tx,req.user,'CREATE','user',u.id,null,{username:b.username,role:b.role,employee_id:b.employee_id});});res.status(201).json({ok:true});
 });
 app.put('/api/users/:id',async(req,res)=>{
  required(req.user,'users.manage');const b=z.object({role:str(40),active:z.boolean(),password:z.string().min(12).max(128).optional()}).parse(req.body);
  await db.transaction(async tx=>{await tx.query("SELECT id FROM users WHERE role='SYSTEM_ADMIN' FOR UPDATE");const u=await one(tx,'SELECT * FROM users WHERE id=$1 FOR UPDATE',[req.params.id]);if(!u)fail(404,'المستخدم غير موجود');if(u.id===req.user.id&&(!b.active||b.role!=='SYSTEM_ADMIN'))fail(400,'لا يمكنك تعطيل حساب الإدارة الحالي أو تخفيض دوره');const admins=await one(tx,"SELECT count(*)::integer n FROM users WHERE role='SYSTEM_ADMIN' AND active=true");if(u.role==='SYSTEM_ADMIN'&&u.active&&admins.n===1&&(!b.active||b.role!=='SYSTEM_ADMIN'))fail(400,'يجب إبقاء مدير نظام نشط');await tx.query('UPDATE users SET role=$2,active=$3,password_hash=COALESCE($4,password_hash) WHERE id=$1',[u.id,b.role,b.active,b.password?hashPassword(b.password):null]);await tx.query('DELETE FROM sessions WHERE user_id=$1',[u.id]);await audit(tx,req.user,'UPDATE','user',u.id,{role:u.role,active:u.active},{role:b.role,active:b.active,password_reset:!!b.password});});res.json({ok:true});
 });
 app.put('/api/roles/:code',async(req,res)=>{
  required(req.user,'users.manage');const b=z.object({permissions:z.array(z.enum(Object.keys(permissionLabels)))}).parse(req.body);
  if(req.params.code==='SYSTEM_ADMIN'&&!b.permissions.includes('users.manage'))fail(400,'يجب إبقاء صلاحية إدارة المستخدمين لمدير النظام');
  await db.transaction(async tx=>{const old=await one(tx,'SELECT * FROM roles WHERE code=$1 FOR UPDATE',[req.params.code]);if(!old)fail(404,'الدور غير موجود');await tx.query('UPDATE roles SET permissions=$2 WHERE code=$1',[old.code,JSON.stringify([...new Set(b.permissions)])]);await audit(tx,req.user,'UPDATE','role',old.code,old.permissions,b.permissions);});res.json({ok:true});
 });
 app.get('/api/reports',async(req,res)=>{
  required(req.user,'reports.view');const s=scope(req.user);
  const people=(await db.query(`SELECT e.id,e.employee_no,e.name,e.department_id,d.name department,e.status,b.year,COALESCE(b.entitlement,30) entitlement,COALESCE(b.used,0) used FROM employees e JOIN departments d ON d.id=e.department_id LEFT JOIN leave_balances b ON b.employee_id=e.id AND b.year=EXTRACT(YEAR FROM current_date) WHERE ${s.sql} ORDER BY e.id`,s.args)).rows;
  const leaves=(await db.query(`SELECT l.*,e.name employee,t.label type_label FROM leave_requests l JOIN employees e ON e.id=l.employee_id JOIN leave_types t ON t.code=l.type WHERE ${s.sql} ORDER BY l.start_date DESC`,s.args)).rows;
  const docs=has(req.user,'documents.view')?(await db.query(`SELECT d.id,d.employee_id,e.name employee,d.kind,d.expires_on,d.status FROM documents d JOIN employees e ON e.id=d.employee_id WHERE ${s.sql}`,s.args)).rows:[];
  const records=(await db.query(`SELECT r.id,r.employee_id,r.kind,r.title,r.issuer,r.date,e.name employee FROM records r JOIN employees e ON e.id=r.employee_id WHERE ${s.sql} ORDER BY r.date DESC`,s.args)).rows;
  res.json({people,leaves,documents:docs,records,canSeeDocuments:has(req.user,'documents.view')});
 });
 app.get('/api/audit',async(req,res)=>{required(req.user,'audit.view');const rows=(await db.query('SELECT a.*,u.username actor FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 300')).rows;res.json(rows.map(r=>{if(!has(req.user,'profile.review')){delete r.before_data;delete r.after_data;}else if(!has(req.user,'salary.view')){if(r.before_data)delete r.before_data.salary;if(r.after_data)delete r.after_data.salary;}return r;}));});
 registerPhotos(app,db,key,{employee,audit,notify,notifyPermission,required,fail,fileBytes,media,decisionSchema});
 app.use('/api',(req,res)=>res.status(404).json({error:'المسار غير موجود'}));
 app.use((err,req,res,next)=>{
  if(err instanceof z.ZodError)return res.status(400).json({error:'تحقق من الحقول: '+err.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('، ')});
  if(err.code==='23505')return res.status(409).json({error:'السجل موجود مسبقًا أو يوجد طلب تعديل معلّق'});
  if(err.code==='23503')return res.status(400).json({error:'الموظف أو القسم أو الدور المحدد غير موجود'});
  if(err.code==='22P02'||err.type==='entity.parse.failed')return res.status(400).json({error:'صيغة الطلب غير صحيحة'});
  if(err.type==='entity.too.large')return res.status(413).json({error:'حجم المرفقات يتجاوز الحد المسموح'});
  if(!err.status)console.error(err);
  res.status(err.status||500).json({error:err.status?err.message:'تعذر إكمال الطلب. حاول مجددًا'});
 });return app;
}


