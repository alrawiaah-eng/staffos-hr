import {one} from './db.js';

// مهلة استهلاك الأيام المرحَّلة: 31 مارس من السنة الجديدة.
export const carryExpiry=year=>`${year}-03-31`;
const PENDING="('MANAGER','HR','DIRECTOR')";

// السنوات التي تُغلق: من سنة تطبيق الهجرة 6 حتى السنة السابقة للسنة الحالية. التنفيذ متأخر مضمون ولا يتكرر (year مفتاح أساسي).
export async function closeDueYears(db,now=new Date()){
 const current=now.getUTCFullYear();
 const base=await one(db,'SELECT EXTRACT(YEAR FROM applied_at)::integer y FROM schema_migrations WHERE version=6');
 const closed=[];
 for(let y=base?.y??current;y<current;y++)if(await closeYear(db,y))closed.push(y);
 return closed;
}

export async function closeYear(db,year){
 return db.transaction(async tx=>{
  if(await one(tx,'SELECT 1 x FROM leave_year_archives WHERE year=$1',[year]))return false;
  await tx.query("INSERT INTO leave_balances(employee_id,year) SELECT id,$1::integer FROM employees WHERE status='ACTIVE' AND joined_on<=make_date($1::integer,12,31) ON CONFLICT DO NOTHING",[year]);
  const balances=(await tx.query(`SELECT b.employee_id,e.employee_no,e.name,e.status,b.entitlement,b.used,b.carried,b.carried_used,b.carried_expires_on,
   COALESCE((SELECT sum(l.days) FROM leave_requests l JOIN leave_types t ON t.code=l.type WHERE l.employee_id=b.employee_id AND EXTRACT(YEAR FROM l.start_date)=b.year AND l.status IN ${PENDING} AND t.deducts=true),0)::integer reserved
   FROM leave_balances b JOIN employees e ON e.id=b.employee_id WHERE b.year=$1 ORDER BY b.employee_id`,[year])).rows;
  // المرحَّل = كل المتبقي من استحقاق السنة بعد الأيام المحجوزة للطلبات المعلّقة. المرحَّل القديم ينتهي 31 مارس فلا يُرحَّل ثانية.
  for(const b of balances)b.carry_out=b.status==='ACTIVE'?Math.max(0,b.entitlement-b.used-b.reserved):0;
  const leaves=(await tx.query("SELECT l.*,COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM leave_approvals a WHERE a.leave_id=l.id),'[]'::jsonb) approvals FROM leave_requests l WHERE EXTRACT(YEAR FROM l.start_date)=$1 ORDER BY l.id",[year])).rows;
  const snapshot={year,balances,leaves};
  const inserted=await one(tx,'INSERT INTO leave_year_archives(year,snapshot) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING year',[year,JSON.stringify(snapshot)]);
  if(!inserted)return false;
  let total=0,people=0;
  for(const b of balances){
   if(b.carry_out<=0)continue;total+=b.carry_out;people++;
   await tx.query('INSERT INTO leave_balances(employee_id,year,carried,carried_expires_on) VALUES($1,$2,$3,$4) ON CONFLICT(employee_id,year) DO UPDATE SET carried=leave_balances.carried+EXCLUDED.carried,carried_expires_on=EXCLUDED.carried_expires_on',[b.employee_id,year+1,b.carry_out,carryExpiry(year+1)]);
   await tx.query('INSERT INTO notifications(user_id,title,body,link) SELECT id,$2,$3,$4 FROM users WHERE employee_id=$1 AND active=true',[b.employee_id,'ترحيل رصيد الإجازات',`رُحّل إليك ${b.carry_out} يومًا من سنة ${year}. تُستهلك قبل نهاية ${carryExpiry(year+1)} وإلا تسقط.`,`/employees/${b.employee_id}`]);
  }
  await tx.query("INSERT INTO audit_logs(actor_id,action,entity,entity_id,before_data,after_data) VALUES(NULL,'YEAR_CLOSE','leave_year',$1,NULL,$2)",[String(year),JSON.stringify({year,employees:balances.length,carried_people:people,carried_days:total,expires_on:carryExpiry(year+1)})]);
  await tx.query("INSERT INTO notifications(user_id,title,body,link) SELECT u.id,$1,$2,'/leave-archives' FROM users u JOIN roles r ON r.code=u.role WHERE u.active=true AND r.permissions ? 'leave.balance'",[`إغلاق سنة ${year}`,`رُحّل ${total} يومًا لـ ${people} موظفًا، وحُفظت نسخة كاملة للسنة.`]);
  return true;
 });
}

// طلب معلّق من سنة مغلقة رُفض أو أُلغي: تعود أيامه إلى مرحَّل السنة الجديدة (لأنها لم تُرحَّل عند الإغلاق).
export async function releaseClosedYearDays(tx,l){
 const t=await one(tx,'SELECT deducts FROM leave_types WHERE code=$1',[l.type]);if(!t?.deducts)return;
 const year=new Date(l.start_date).getUTCFullYear();
 if(!await one(tx,'SELECT 1 x FROM leave_year_archives WHERE year=$1',[year]))return;
 await tx.query('INSERT INTO leave_balances(employee_id,year,carried,carried_expires_on) VALUES($1,$2,$3,$4) ON CONFLICT(employee_id,year) DO UPDATE SET carried=leave_balances.carried+EXCLUDED.carried,carried_expires_on=COALESCE(leave_balances.carried_expires_on,EXCLUDED.carried_expires_on)',[l.employee_id,year+1,l.days,carryExpiry(year+1)]);
}
