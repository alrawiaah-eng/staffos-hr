import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,chmod,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {connectDatabase} from '../server/db.js';
test('disk database survives restart with Windows read-only folder attribute',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'hr-restart-'));let db;
 try{
  db=await connectDatabase({url:'',directory});await db.query('CREATE TABLE restart_check (value text)');await db.query("INSERT INTO restart_check VALUES('preserved')");await db.close();db=null;
  if(process.platform==='win32')await chmod(directory,0o444);
  db=await connectDatabase({url:'',directory});assert.equal((await db.query('SELECT value FROM restart_check')).rows[0].value,'preserved');await db.close();db=null;
  db=await connectDatabase({url:'',directory});assert.equal((await db.query('SELECT count(*)::int n FROM restart_check')).rows[0].n,1);
 }finally{if(db)await db.close();await rm(directory,{recursive:true,force:true});}
});
