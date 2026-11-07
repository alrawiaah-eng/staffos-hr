import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {connectDatabase,migrate,one} from '../server/db.js';
import {seed} from '../server/seed.js';
import {createApp} from '../server/app.js';
process.env.NODE_ENV='test';process.env.SEED_DEMO='true';
let db,server,base;const clients={};
const iso=d=>d.toISOString().slice(0,10);
function dates(offset,length=1){const a=new Date();a.setUTCDate(a.getUTCDate()+offset);const b=new Date(a);b.setUTCDate(b.getUTCDate()+length-1);if(a.getUTCFullYear()!==b.getUTCFullYear()){a.setUTCMonth(0,10);a.setUTCFullYear(a.getUTCFullYear()+1);b.setTime(a.getTime()+(length-1)*86400000);}return {start_date:iso(a),end_date:iso(b)};}
async function request(client,path,method='GET',body,override={}){const r=await fetch(base+'/api'+path,{method,headers:{'content-type':'application/json',...(client?{cookie:client.cookie,'x-csrf-token':client.csrf}:{}),...override},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
before(async()=>{db=await connectDatabase({url:'',directory:'memory://'});await migrate(db);await seed(db);server=createApp(db,randomBytes(32)).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;for(const username of ['employee','manager','hr','hrmanager','director','admin','auditor']){const r=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password:'DemoPass!2026'})});assert.equal(r.status,200);const cookie=r.headers.get('set-cookie').split(';')[0];const me=await fetch(base+'/api/me',{headers:{cookie}}).then(r=>r.json());clients[username]={cookie,csrf:me.csrf,me};}});
after(async()=>{await new Promise(r=>server.close(r));await db.close();});
test('authentication, password rejection and CSRF enforcement',async()=>{assert.equal((await request(null,'/employees')).status,401);assert.equal((await request(null,'/login','POST',{username:'employee',password:'incorrect'})).status,401);assert.equal((await request(clients.employee,'/notifications/read','POST',{}, {'x-csrf-token':''})).status,403);assert.equal((await request(clients.employee,'/notifications/read','POST',{}, {origin:'https://evil.example'})).status,403);});
test('row-level scope and salary protection',async()=>{const employee=await request(clients.employee,'/employees');assert.equal(employee.body.length,1);assert.equal(employee.body[0].salary,undefined);assert.equal((await request(clients.employee,'/employees/2')).status,403);const hr=await request(clients.hr,'/employees/1');assert.equal(hr.body.salary,undefined);assert.ok((await request(clients.hrmanager,'/employees/1')).body.salary);assert.equal((await request(clients.admin,'/employees/1')).body.salary,undefined);const manager=await request(clients.manager,'/employees');assert.ok(manager.body.every(e=>e.department_id===clients.manager.me.department_id));assert.equal((await request(clients.manager,'/employees/1')).body.personal,undefined);});
test('employees cannot create employees or administer users',async()=>{assert.equal((await request(clients.employee,'/employees','POST',{})).status,403);assert.equal((await request(clients.employee,'/users')).status,403);assert.equal((await request(clients.auditor,'/records','POST',{})).status,403);});
test('profile changes stay pending until HR approval; strict field allowlist',async()=>{const e=(await request(clients.employee,'/employees/1')).body;const proposed={...e.personal,phone:'07712345678'};assert.equal((await request(clients.employee,'/profile-changes','POST',{...proposed,salary:1})).status,400);assert.equal((await request(clients.employee,'/profile-changes','POST',proposed)).status,201);assert.equal((await request(clients.employee,'/employees/1')).body.personal.phone,e.personal.phone);assert.equal((await request(clients.employee,'/profile-changes','POST',proposed)).status,409);const c=(await request(clients.hr,'/approvals')).body.changes[0];assert.equal((await request(clients.employee,`/profile-changes/${c.id}/decision`,'POST',{decision:'APPROVE'})).status,403);assert.equal((await request(clients.hr,`/profile-changes/${c.id}/decision`,'POST',{decision:'APPROVE'})).status,200);assert.equal((await request(clients.employee,'/employees/1')).body.personal.phone,proposed.phone);assert.equal((await request(clients.hr,`/profile-changes/${c.id}/decision`,'POST',{decision:'APPROVE'})).status,409);});
test('leave moves manager -> HR -> approved; final debit exactly once under racing approvals',async()=>{const l=(await request(clients.employee,'/leave')).body[0];const year=new Date(l.start_date).getUTCFullYear();const initial=await one(db,'SELECT used FROM leave_balances WHERE employee_id=1 AND year=$1',[year]);assert.equal((await request(clients.hr,`/leave/${l.id}/decision`,'POST',{decision:'APPROVE'})).status,403);assert.equal((await request(clients.manager,`/leave/${l.id}/decision`,'POST',{decision:'APPROVE'})).status,200);const outcomes=await Promise.all([request(clients.hr,`/leave/${l.id}/decision`,'POST',{decision:'APPROVE'}),request(clients.hrmanager,`/leave/${l.id}/decision`,'POST',{decision:'APPROVE'})]);assert.equal(outcomes.filter(x=>x.status===200).length,1);const final=await one(db,'SELECT used FROM leave_balances WHERE employee_id=1 AND year=$1',[year]);assert.equal(final.used,initial.used+l.days);assert.equal((await request(clients.employee,`/leave/${l.id}/history`)).body.length,2);});
test('director approval for unpaid leave; no annual debit',async()=>{const l=await request(clients.employee,'/leave','POST',{type:'UNPAID',...dates(35,2),reason:'طلب تجريبي'});assert.equal(l.status,201,JSON.stringify(l.body));await request(clients.manager,`/leave/${l.body.id}/decision`,'POST',{decision:'APPROVE'});await request(clients.hr,`/leave/${l.body.id}/decision`,'POST',{decision:'APPROVE'});assert.equal((await one(db,'SELECT status FROM leave_requests WHERE id=$1',[l.body.id])).status,'DIRECTOR');assert.equal((await request(clients.director,`/leave/${l.body.id}/decision`,'POST',{decision:'APPROVE'})).status,200);});
test('overlap, invalid ranges and insufficient balance rejected',async()=>{const b={type:'ANNUAL',...dates(50,2),reason:'اختبار'};assert.equal((await request(clients.employee,'/leave','POST',b)).status,201);assert.equal((await request(clients.employee,'/leave','POST',b)).status,409);assert.equal((await request(clients.employee,'/leave','POST',{type:'ANNUAL',...dates(65,40),reason:'اختبار'})).status,400);assert.equal((await request(clients.employee,'/leave','POST',{type:'ANNUAL',start_date:'2026-02-30',end_date:'2026-03-02',reason:'اختبار'})).status,400);});
test('owner can cancel pending leave, rejection requires reason',async()=>{const l=await request(clients.employee,'/leave','POST',{type:'SICK',...dates(120,1),reason:'اختبار إلغاء'});assert.equal(l.status,201);assert.equal((await request(clients.manager,`/leave/${l.body.id}/decision`,'POST',{decision:'REJECT',comment:''})).status,400);assert.equal((await request(clients.manager,`/leave/${l.body.id}/cancel`,'POST',{})).status,403);assert.equal((await request(clients.employee,`/leave/${l.body.id}/cancel`,'POST',{})).status,200);assert.equal((await request(clients.manager,`/leave/${l.body.id}/decision`,'POST',{decision:'APPROVE'})).status,403);});
test('document fronts/backs, encrypted storage, scope, review and deduplicated expiry alerts',async()=>{const media={mime:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jw1kAAAAASUVORK5CYII='};const body={employee_id:1,kind:'IDENTITY',number:'DEMO-ONLY',expires_on:iso(new Date()),front:media};assert.equal((await request(clients.employee,'/documents','POST',body)).status,400);assert.equal((await request(clients.employee,'/documents','POST',{...body,back:media})).status,201);const d=(await request(clients.employee,'/documents')).body[0];const stored=await one(db,'SELECT front_data FROM documents WHERE id=$1',[d.id]);assert.notDeepEqual(Buffer.from(stored.front_data),Buffer.from(media.data,'base64'));const file=await fetch(base+`/api/documents/${d.id}/front`,{headers:{cookie:clients.employee.cookie}});assert.equal(file.status,200);assert.deepEqual(Buffer.from(await file.arrayBuffer()),Buffer.from(media.data,'base64'));assert.equal((await fetch(base+`/api/documents/${d.id}/front`,{headers:{cookie:clients.manager.cookie}})).status,403);assert.equal((await request(clients.hr,`/documents/${d.id}/decision`,'POST',{decision:'APPROVE'})).status,200);const n1=(await request(clients.employee,'/notifications')).body.filter(n=>n.dedupe_key).length;const n2=(await request(clients.employee,'/notifications')).body.filter(n=>n.dedupe_key).length;assert.equal(n1,1);assert.equal(n1,n2);});
test('HR cannot approve their own personal changes',async()=>{const me=(await request(clients.hr,'/employees/'+clients.hr.me.employee_id)).body;await request(clients.hr,'/profile-changes','POST',{...me.personal,phone:'07711111111'});const c=await one(db,"SELECT id FROM profile_changes WHERE employee_id=$1 AND status='PENDING'",[me.id]);assert.equal((await request(clients.hr,`/profile-changes/${c.id}/decision`,'POST',{decision:'APPROVE'})).status,403);assert.equal((await request(clients.hrmanager,`/profile-changes/${c.id}/decision`,'POST',{decision:'APPROVE'})).status,200);});
test('records and reports are persisted and scoped; auditor cannot mutate',async()=>{assert.equal((await request(clients.hr,'/records','POST',{employee_id:1,kind:'TRAINING',title:'اختبار دورة',issuer:'مركز التدريب',date:iso(new Date()),notes:'اختبار'})).status,201);assert.ok((await request(clients.employee,'/records')).body.some(r=>r.title==='اختبار دورة'));assert.equal((await request(clients.employee,'/reports')).status,403);const report=(await request(clients.manager,'/reports')).body;assert.ok(report.people.every(p=>p.department_id===clients.manager.me.department_id));assert.equal(report.documents.length,0);const audit=(await request(clients.auditor,'/audit')).body;assert.ok(audit.length>5);assert.ok(audit.every(a=>a.before_data===undefined&&a.after_data===undefined));});
test('role changes apply on next request and last admin remains protected',async()=>{assert.equal((await request(clients.admin,'/roles/EMPLOYEE','PUT',{permissions:['audit.view']})).status,200);assert.equal((await request(clients.employee,'/audit')).status,200);await request(clients.admin,'/roles/EMPLOYEE','PUT',{permissions:[]});assert.equal((await request(clients.employee,'/audit')).status,403);assert.equal((await request(clients.admin,'/roles/SYSTEM_ADMIN','PUT',{permissions:[]})).status,400);assert.equal((await request(clients.admin,'/users/'+clients.admin.me.id,'PUT',{role:'EMPLOYEE',active:false})).status,400);});
test('department routing rejects ineligible reviewers and reroutes pending requests when manager removed',async()=>{
 const department=clients.employee.me.department_id;
 assert.equal((await request(clients.employee,'/departments','POST',{name:'غير مسموح'})).status,403);
 assert.equal((await request(clients.admin,'/departments/'+department,'PUT',{name:'العمليات',manager_id:clients.employee.me.employee_id})).status,400);
 const l=await request(clients.employee,'/leave','POST',{type:'SICK',...dates(170,1),reason:'اختبار تحويل القسم'});assert.equal(l.status,201);assert.equal(l.body.status,'MANAGER');
 assert.equal((await request(clients.admin,'/departments/'+department,'PUT',{name:'العمليات',manager_id:null})).status,200);
 assert.equal((await one(db,'SELECT status FROM leave_requests WHERE id=$1',[l.body.id])).status,'HR');
 await request(clients.admin,'/departments/'+department,'PUT',{name:'العمليات',manager_id:clients.manager.me.employee_id});
});
test('audit records cannot be modified or deleted through SQL',async()=>{
 await assert.rejects(db.query("UPDATE audit_logs SET action='TAMPERED' WHERE id=(SELECT min(id) FROM audit_logs)"),/append-only/);
 await assert.rejects(db.query('DELETE FROM audit_logs WHERE id=(SELECT min(id) FROM audit_logs)'),/append-only/);
});
test('production configuration hides demo accounts',async()=>{
 const prod=createApp(db,randomBytes(32),{production:true}).listen(0,'127.0.0.1');await new Promise(r=>prod.once('listening',r));
 try{const result=await fetch('http://127.0.0.1:'+prod.address().port+'/api/config').then(r=>r.json());assert.equal(result.demo,false);}finally{await new Promise(r=>prod.close(r));}
});
test('HR can edit training records; employee cannot change their own official record',async()=>{
 const record=(await request(clients.employee,'/records')).body[0];
 const update={kind:'THANKS',title:'كتاب شكر محدّث',issuer:'الإدارة',date:'2026-09-14',notes:'تعديل موثق',remove_attachment:false};
 assert.equal((await request(clients.employee,'/records/'+record.id,'PUT',update)).status,403);
 assert.equal((await request(clients.hr,'/records/'+record.id,'PUT',update)).status,200);
 assert.equal((await request(clients.employee,'/records')).body.find(r=>r.id===record.id).title,update.title);
 assert.ok((await request(clients.hrmanager,'/audit')).body.some(a=>a.entity==='record'&&a.action==='UPDATE'&&a.before_data));
});
test('annual entitlement changes require permission and cannot consume approved or reserved days',async()=>{
 const year=new Date().getFullYear();const rows=(await request(clients.hrmanager,'/employees/1/balances')).body;
 const current=rows.find(b=>b.year===year);assert.ok(current);const path='/employees/1/balances/'+year;
 assert.equal((await request(clients.hr,path,'PUT',{entitlement:40,reason:'سياسة تجريبية'})).status,403);
 assert.equal((await request(clients.hrmanager,path,'PUT',{entitlement:0,reason:'اختبار الحد الأدنى'})).status,409);
 assert.equal((await request(clients.hrmanager,path,'PUT',{entitlement:40,reason:''})).status,400);
 assert.equal((await request(clients.hrmanager,path,'PUT',{entitlement:40,reason:'تعديل الاستحقاق'})).status,200);
 const after=(await request(clients.employee,'/employees/1/balances')).body.find(b=>b.year===year);assert.equal(after.entitlement,40);assert.equal(after.used,current.used);assert.equal(after.reserved,current.reserved);
 assert.equal((await request(clients.employee,'/employees/2/balances')).status,403);
});
test('employee portrait upload is encrypted, reviewed, scoped and preserves approved photo on rejection',async()=>{
 const image={mime:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jw1kAAAAASUVORK5CYII='};
 assert.equal((await request(clients.employee,'/employees/1/photo','POST',{image:{mime:'application/pdf',data:Buffer.from('%PDF-test').toString('base64')}})).status,400);
 assert.equal((await request(clients.manager,'/employees/1/photo','POST',{image})).status,403);
 const uploaded=await request(clients.employee,'/employees/1/photo','POST',{image});assert.equal(uploaded.status,201);assert.equal(uploaded.body.status,'PENDING');
 const pending=(await request(clients.employee,'/employees/1')).body;assert.equal(pending.photo_id,null);assert.equal(pending.photo_request.status,'PENDING');
 const id=pending.photo_request.id;
 assert.equal((await request(clients.employee,'/employees/1/photo','POST',{image})).status,409);
 const stored=await one(db,'SELECT image_data FROM employee_photos WHERE id=$1',[id]);assert.notDeepEqual(Buffer.from(stored.image_data),Buffer.from(image.data,'base64'));
 assert.equal((await fetch(base+'/api/photo-requests/'+id+'/image',{headers:{cookie:clients.manager.cookie}})).status,403);
 assert.equal((await fetch(base+'/api/photo-requests/'+id+'/image',{headers:{cookie:clients.employee.cookie}})).status,200);
 assert.equal((await request(clients.employee,'/photo-requests/'+id+'/decision','POST',{decision:'APPROVE'})).status,403);
 assert.ok((await request(clients.hr,'/approvals')).body.photos.some(p=>p.id===id));
 assert.equal((await request(clients.hr,'/photo-requests/'+id+'/decision','POST',{decision:'APPROVE'})).status,200);
 assert.equal((await request(clients.employee,'/employees/1')).body.photo_id,id);
 await request(clients.employee,'/employees/1/photo','POST',{image});
 const replacement=(await request(clients.employee,'/employees/1')).body.photo_request.id;
 assert.equal((await request(clients.hr,'/photo-requests/'+replacement+'/decision','POST',{decision:'REJECT',comment:'صورة غير واضحة'})).status,200);
 assert.equal((await request(clients.employee,'/employees/1')).body.photo_id,id);
 const direct=await request(clients.hr,'/employees/1/photo','POST',{image});assert.equal(direct.body.status,'APPROVED');
 assert.notEqual((await request(clients.employee,'/employees/1')).body.photo_id,id);
 assert.equal((await request(clients.admin,'/employees/1')).body.photo_id,undefined);
 const self=await request(clients.hr,'/employees/'+clients.hr.me.employee_id+'/photo','POST',{image});assert.equal(self.body.status,'PENDING');
 const own=(await request(clients.hr,'/employees/'+clients.hr.me.employee_id)).body.photo_request.id;
 assert.equal((await request(clients.hr,'/photo-requests/'+own+'/decision','POST',{decision:'APPROVE'})).status,403);
});
