import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {connectDatabase,migrate,one} from '../server/db.js';
import {seed} from '../server/seed.js';
import {createApp} from '../server/app.js';
import {closeDueYears} from '../server/yearclose.js';
process.env.NODE_ENV='test';process.env.SEED_DEMO='true';

async function fresh(){
 const db=await connectDatabase({url:'',directory:'memory://'});await migrate(db);await seed(db);
 // طلب الإجازة التجريبي في بيانات البذرة يحجز أيامًا ويُربك الأرقام المتوقعة
 await db.query('DELETE FROM leave_approvals');await db.query('DELETE FROM leave_requests');
 const server=createApp(db,randomBytes(32)).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base='http://127.0.0.1:'+server.address().port;const clients={};
 for(const username of ['employee','manager','hr']){
  const r=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password:'DemoPass!2026'})});
  const cookie=r.headers.get('set-cookie').split(';')[0];const me=await fetch(base+'/api/me',{headers:{cookie}}).then(r=>r.json());clients[username]={cookie,csrf:me.csrf,me};
 }
 const request=async(client,path,method='GET',body)=>{const r=await fetch(base+'/api'+path,{method,headers:{'content-type':'application/json',cookie:client.cookie,'x-csrf-token':client.csrf},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 return {db,clients,request,close:async()=>{await new Promise(r=>server.close(r));await db.close();}};
}

test('الإغلاق التلقائي: ترحيل كل المتبقي حتى 31 مارس، مرة واحدة، مع نسخة لا تُعدَّل',async()=>{
 const {db,clients,close}=await fresh();
 try{
  const emp=clients.employee.me.employee_id,mgr=clients.manager.me.employee_id;
  await db.query('INSERT INTO leave_balances(employee_id,year,entitlement,used) VALUES($1,2026,30,10) ON CONFLICT(employee_id,year) DO UPDATE SET entitlement=30,used=10',[emp]);
  await db.query('INSERT INTO leave_balances(employee_id,year,entitlement,used) VALUES($1,2026,25,25) ON CONFLICT(employee_id,year) DO UPDATE SET entitlement=25,used=25',[mgr]);

  assert.deepEqual(await closeDueYears(db,new Date('2026-12-31T23:00:00Z')),[],'لا إغلاق قبل 1 يناير');
  assert.deepEqual(await closeDueYears(db,new Date('2027-01-01T00:30:00Z')),[2026]);
  assert.deepEqual(await closeDueYears(db,new Date('2027-01-02T00:00:00Z')),[],'لا تكرار');

  const e=await one(db,"SELECT carried,carried_used,to_char(carried_expires_on,'YYYY-MM-DD') x FROM leave_balances WHERE employee_id=$1 AND year=2027",[emp]);
  assert.deepEqual({...e},{carried:20,carried_used:0,x:'2027-03-31'});
  assert.equal(await one(db,'SELECT count(*)::integer n FROM leave_balances WHERE employee_id=$1 AND year=2027 AND carried>0',[mgr]).then(r=>r.n),0,'من استنفد رصيده لا يُرحَّل له شيء');

  const archive=await one(db,'SELECT snapshot FROM leave_year_archives WHERE year=2026');
  const row=archive.snapshot.balances.find(b=>b.employee_id===emp);
  assert.equal(row.used,10);assert.equal(row.carry_out,20);
  await assert.rejects(db.query("UPDATE leave_year_archives SET snapshot='{}'::jsonb WHERE year=2026"),/immutable/);
  await assert.rejects(db.query('DELETE FROM leave_year_archives WHERE year=2026'),/immutable/);
  assert.equal((await one(db,"SELECT count(*)::integer n FROM audit_logs WHERE action='YEAR_CLOSE' AND entity_id='2026'")).n,1);

  // تشغيل متأخر: التطبيق مغلق طوال يناير 2028، فتُغلق 2027 عند أول تشغيل، والمرحَّل القديم (المنتهي) لا يُرحَّل ثانية
  assert.deepEqual(await closeDueYears(db,new Date('2028-02-10T00:00:00Z')),[2027]);
  const e2=await one(db,'SELECT carried FROM leave_balances WHERE employee_id=$1 AND year=2028',[emp]);
  assert.equal(e2.carried,30);
 }finally{await close();}
});

test('الخصم من المرحَّل أولًا ثم من الاستحقاق، ويسقط المرحَّل بعد المهلة',async()=>{
 const {db,clients,request,close}=await fresh();
 try{
  const emp=clients.employee.me.employee_id;
  const year=new Date().getUTCFullYear()+1;const span=(m,d,n)=>({start_date:`${year}-${m}-${d}`,end_date:`${year}-${m}-${String(Number(d)+n-1).padStart(2,'0')}`});const w1=span('03','02',3);
  await db.query("INSERT INTO leave_balances(employee_id,year,entitlement,used,carried,carried_expires_on) VALUES($1,$2,6,6,5,make_date($2,12,31)) ON CONFLICT(employee_id,year) DO UPDATE SET entitlement=6,used=6,carried=5,carried_used=0,carried_expires_on=make_date($2,12,31)",[emp,year]);
  const approve=async id=>{assert.equal((await request(clients.manager,`/leave/${id}/decision`,'POST',{decision:'APPROVE'})).status,200);assert.equal((await request(clients.hr,`/leave/${id}/decision`,'POST',{decision:'APPROVE'})).status,200);};

  const a=await request(clients.employee,'/leave','POST',{type:'ANNUAL',...w1,reason:'من المرحَّل'});assert.equal(a.status,201,JSON.stringify(a.body));await approve(a.body.id);
  let b=await one(db,'SELECT used,carried_used FROM leave_balances WHERE employee_id=$1 AND year=$2',[emp,year]);
  assert.deepEqual({...b},{used:6,carried_used:3});

  const tooMany=await request(clients.employee,'/leave','POST',{type:'ANNUAL',...span('03','10',3),reason:'أكثر من المتاح'});
  assert.equal(tooMany.status,400,'المتاح 2 فقط من المرحَّل');
  const rest=await request(clients.employee,'/leave','POST',{type:'ANNUAL',...span('03','10',2),reason:'المتبقي من المرحَّل'});assert.equal(rest.status,201,JSON.stringify(rest.body));await approve(rest.body.id);
  b=await one(db,'SELECT used,carried_used FROM leave_balances WHERE employee_id=$1 AND year=$2',[emp,year]);
  assert.deepEqual({...b},{used:6,carried_used:5});

  // انتهت المهلة: المرحَّل غير المستهلك لا يُحسب
  await db.query("UPDATE leave_balances SET carried=9,carried_expires_on=make_date($2,1,1)-1 WHERE employee_id=$1 AND year=$2",[emp,year]);
  const expired=await request(clients.employee,'/leave','POST',{type:'ANNUAL',...span('03','20',1),reason:'بعد المهلة'});
  assert.equal(expired.status,400);
 }finally{await close();}
});

test('طلب معلّق من سنة مغلقة: لا يُرحَّل عند الإغلاق، وتعود أيامه إذا أُلغي',async()=>{
 const {db,clients,request,close}=await fresh();
 try{
  const emp=clients.employee.me.employee_id;
  await db.query("INSERT INTO leave_balances(employee_id,year,entitlement,used) VALUES($1,2026,30,0) ON CONFLICT(employee_id,year) DO UPDATE SET entitlement=30,used=0",[emp]);
  const l=await one(db,"INSERT INTO leave_requests(employee_id,type,start_date,end_date,days,reason,status,director_required) VALUES($1,'ANNUAL','2026-12-28','2026-12-31',4,'معلّق عند الإغلاق','HR',false) RETURNING id",[emp]);
  await closeDueYears(db,new Date('2027-01-01T00:10:00Z'));
  assert.equal((await one(db,'SELECT carried FROM leave_balances WHERE employee_id=$1 AND year=2027',[emp])).carried,26);
  const c=await request(clients.employee,`/leave/${l.id}/cancel`,'POST');assert.equal(c.status,200,JSON.stringify(c.body));
  assert.equal((await one(db,'SELECT carried FROM leave_balances WHERE employee_id=$1 AND year=2027',[emp])).carried,30);
 }finally{await close();}
});
