import {z} from 'zod';
import {one} from './db.js';
import {has,encrypt,decrypt} from './security.js';
export const canSeePhoto=(u,id)=>u.employee_id===id||has(u,'employees.edit')||has(u,'profile.review');
export async function photoSummary(db,u,id){
 if(!canSeePhoto(u,id))return {};
 const current=await one(db,"SELECT id FROM employee_photos WHERE employee_id=$1 AND status='APPROVED' ORDER BY id DESC LIMIT 1",[id]);
 const latest=await one(db,'SELECT id,status,comment FROM employee_photos WHERE employee_id=$1 ORDER BY id DESC LIMIT 1',[id]);
 return {photo_id:current?.id||null,photo_request:latest||null};
}
export async function photoQueue(db,u){return has(u,'profile.review')?(await db.query("SELECT p.id,p.employee_id,p.created_at,e.name employee FROM employee_photos p JOIN employees e ON e.id=p.employee_id WHERE p.status='PENDING' AND p.employee_id<>$1 ORDER BY p.id",[u.employee_id])).rows:[];}
export function registerPhotos(app,db,key,{employee,audit,notify,notifyPermission,required,fail,fileBytes,media,decisionSchema}){
 app.post('/api/employees/:id/photo',async(req,res)=>{
  const id=z.coerce.number().int().positive().parse(req.params.id);
  const e=await employee(db,req.user,id);if(id!==req.user.employee_id)required(req.user,'employees.edit');
  const b=z.object({image:media}).strict().parse(req.body);const bytes=fileBytes(b.image,true);
  const direct=id!==req.user.employee_id&&has(req.user,'employees.edit');
  await db.transaction(async tx=>{
   await tx.query('SELECT id FROM employees WHERE id=$1 FOR UPDATE',[id]);
   if(await one(tx,"SELECT id FROM employee_photos WHERE employee_id=$1 AND status='PENDING'",[id]))fail(409,'توجد صورة بانتظار مراجعة HR؛ راجع الطلب الحالي قبل رفع صورة أخرى');
   const p=await one(tx,'INSERT INTO employee_photos(employee_id,image_data,image_mime,status,submitted_by,reviewer_id,reviewed_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',[id,encrypt(bytes,key),b.image.mime,direct?'APPROVED':'PENDING',req.user.id,direct?req.user.id:null,direct?new Date():null]);
   await audit(tx,req.user,direct?'UPDATE':'SUBMIT','employee_photo',p.id,null,{employee_id:id,status:direct?'APPROVED':'PENDING'});
   if(direct)await notify(tx,id,'تحديث الصورة الشخصية','حدّثت الموارد البشرية صورتك الشخصية',`/employees/${id}`);
   else await notifyPermission(tx,'profile.review','صورة شخصية تحتاج مراجعة',e.name,'/approvals',id);
  });res.status(201).json({status:direct?'APPROVED':'PENDING'});
 });
 app.get('/api/photo-requests/:id/image',async(req,res)=>{
  const p=await one(db,'SELECT * FROM employee_photos WHERE id=$1',[req.params.id]);if(!p)fail(404,'الصورة غير موجودة');
  await employee(db,req.user,p.employee_id);if(!canSeePhoto(req.user,p.employee_id))fail(403,'الصورة الشخصية متاحة للموظف والموارد البشرية فقط');
  res.type(p.image_mime).set('Content-Disposition','inline').send(decrypt(p.image_data,key));
 });
 app.post('/api/photo-requests/:id/decision',async(req,res)=>{
  required(req.user,'profile.review');const b=decisionSchema.parse(req.body);
  await db.transaction(async tx=>{
   const p=await one(tx,'SELECT id,employee_id,status FROM employee_photos WHERE id=$1 FOR UPDATE',[req.params.id]);if(!p)fail(404,'طلب الصورة غير موجود');
   await employee(tx,req.user,p.employee_id);if(p.employee_id===req.user.employee_id)fail(403,'لا يمكنك اعتماد صورتك الشخصية بنفسك');if(p.status!=='PENDING')fail(409,'تمت معالجة الصورة مسبقًا');
   const status=b.decision==='APPROVE'?'APPROVED':'REJECTED';
   await tx.query('UPDATE employee_photos SET status=$2,reviewer_id=$3,comment=$4,reviewed_at=now() WHERE id=$1',[p.id,status,req.user.id,b.comment]);
   await audit(tx,req.user,b.decision,'employee_photo',p.id,{status:p.status},{status,comment:b.comment});
   await notify(tx,p.employee_id,'نتيجة مراجعة الصورة الشخصية',status==='APPROVED'?'تم اعتماد صورتك الشخصية':`تم رفض الصورة: ${b.comment}`,`/employees/${p.employee_id}`);
  });res.json({ok:true});
 });
}
