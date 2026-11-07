import {connectDatabase,migrate,one} from './db.js';
import {roleDefinitions,hashPassword} from './security.js';
import {pathToFileURL} from 'node:url';
export async function seed(db){
 for(const [code,label,permissions] of roleDefinitions)await db.query('INSERT INTO roles(code,label,permissions) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[code,label,JSON.stringify(permissions)]);
 for(const t of [['ANNUAL','سنوية',true,false],['SICK','مرضية',false,false],['UNPAID','بدون راتب',false,true]])await db.query('INSERT INTO leave_types VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',t);
 if(await one(db,'SELECT id FROM users LIMIT 1'))return;
 if(process.env.NODE_ENV==='production'||process.env.SEED_DEMO==='false')return;
 await db.transaction(async tx=>{
  const departments=[];for(const name of ['العمليات','الموارد البشرية','الإدارة','تقنية المعلومات'])departments.push((await one(tx,'INSERT INTO departments(name) VALUES($1) RETURNING id',[name])).id);
  const names=['علي أحمد حسن','سارة خالد محمد','نور حسين علي','عمر كريم عباس','ليلى سامي جاسم','أحمد فاضل سالم','مريم ناصر حامد','حسن مهدي صالح','زينب رائد فاضل','يوسف سعد كريم','هبة عادل حسين','مصطفى جاسم عمر'];
  const usernames=['employee','manager','hr','hrmanager','director','admin','auditor'];
  const ids=[];
  for(let i=0;i<names.length;i++){
   const dep=i<2?departments[0]:i<4?departments[1]:i<7?departments[2]:departments[i%4];
   const e=await one(tx,'INSERT INTO employees(employee_no,name,department_id,job_title,joined_on,salary,personal,education,employment_history) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',[
    `EMP-${String(i+1).padStart(3,'0')}`,names[i],dep,['منسق عمليات','مسؤول قسم العمليات','أخصائي موارد بشرية','مدير الموارد البشرية','مدير تنفيذي','مسؤول أنظمة','مدقق داخلي'][i]||'موظف إداري',`202${i%5}-03-15`,850000+i*75000,
    JSON.stringify({phone:`07700000${String(i+1).padStart(3,'0')}`,email:`person${i+1}@example.test`,address:'بغداد — حي المنصور',birth_date:'1992-06-12',birth_place:'بغداد',nationality:'عراقي',marital_status:'أعزب',family:[],emergency_primary_name:'جهة اتصال تجريبية',emergency_primary_phone:'07700000000'}),JSON.stringify([{degree:'بكالوريوس',institution:'جامعة بغداد',year:'2014'}]),JSON.stringify([{title:'مباشرة العمل',date:`202${i%5}-03-15`,notes:'تعيين'}])]);
   ids.push(e.id);await tx.query('INSERT INTO leave_balances(employee_id,year,entitlement,used) VALUES($1,$2,30,$3)',[e.id,new Date().getFullYear(),i%6]);
   if(i<7)await tx.query('INSERT INTO users(username,password_hash,employee_id,role) VALUES($1,$2,$3,$4)',[usernames[i],hashPassword(process.env.DEMO_PASSWORD||'DemoPass!2026'),e.id,roleDefinitions[i][0]]);
  }
  await tx.query('UPDATE departments SET manager_id=$1 WHERE id=$2',[ids[1],departments[0]]);
  await tx.query('UPDATE departments SET manager_id=$1 WHERE id=$2',[ids[3],departments[1]]);
  for(const [kind,title,issuer] of [['TRAINING','إدارة المشاريع وأولويات العمل','مركز التطوير الإداري'],['THANKS','كتاب شكر — إنجاز المهام الفصلية','الإدارة'],['AWARD','تكريم التميز الوظيفي','الموارد البشرية']])await tx.query('INSERT INTO records(employee_id,kind,title,issuer,date,notes) VALUES($1,$2,$3,$4,current_date,$5)',[ids[0],kind,title,issuer,'سجل تجريبي قابل للتعديل']);
  await tx.query("INSERT INTO leave_requests(employee_id,type,start_date,end_date,days,reason,status,director_required) VALUES($1,'ANNUAL',current_date+7,current_date+9,3,'ظروف عائلية','MANAGER',false)",[ids[0]]);
  await tx.query("INSERT INTO notifications(user_id,title,body) SELECT id,'مرحبًا بك','هذه بيئة تجريبية. استكشف ملفك وطلبات الإجازات.' FROM users");
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const db=await connectDatabase();await migrate(db);await seed(db);await db.close();console.log('Database seeded');}
