import 'dotenv/config';
import {connectDatabase,migrate,one} from './db.js';
import {seed} from './seed.js';
import {hashPassword} from './security.js';
if(!process.env.DATABASE_URL)throw Error('DATABASE_URL is required');
if(!process.env.ADMIN_PASSWORD||process.env.ADMIN_PASSWORD.length<16)throw Error('Set ADMIN_PASSWORD to at least 16 characters');
const db=await connectDatabase();
try{await migrate(db);process.env.SEED_DEMO='false';await seed(db);
 await db.transaction(async tx=>{
  if(await one(tx,'SELECT id FROM users LIMIT 1'))throw Error('Bootstrap requires an empty users table; existing accounts are unchanged');
  const dep=await one(tx,"INSERT INTO departments(name) VALUES('الإدارة') ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name RETURNING id");
  const e=await one(tx,"INSERT INTO employees(employee_no,name,department_id,job_title) VALUES('ADMIN-001',$1,$2,'مدير النظام') RETURNING id",[process.env.ADMIN_NAME||'مدير النظام',dep.id]);
  const u=await one(tx,"INSERT INTO users(username,password_hash,employee_id,role) VALUES($1,$2,$3,'SYSTEM_ADMIN') RETURNING id",[process.env.ADMIN_USERNAME||'admin',hashPassword(process.env.ADMIN_PASSWORD),e.id]);
  await tx.query("INSERT INTO audit_logs(actor_id,action,entity,entity_id) VALUES($1,'BOOTSTRAP','user',$2)",[u.id,String(u.id)]);
 });console.log('Initial administrator created. Remove ADMIN_PASSWORD from your environment now.');
}finally{await db.close();}
