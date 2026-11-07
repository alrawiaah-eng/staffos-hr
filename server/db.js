import 'dotenv/config';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import {readFile,mkdir,readdir,lstat,chmod} from 'node:fs/promises';
import path from 'node:path';
const safeWindowsDirectory=path.join(process.env.APPDATA||process.env.LOCALAPPDATA||process.cwd(),'StaffOS','data','postgres-v2');
export async function connectDatabase({url=process.env.DATABASE_URL, directory=process.env.PGLITE_DIR || (process.platform==='win32'?safeWindowsDirectory:'./data/postgres')}={}) {
 if(url){
  const pool=new pg.Pool({connectionString:url, max:10});
  return {query:(sql,args)=>pool.query(sql,args), exec:sql=>pool.query(sql), close:()=>pool.end(), transaction:async fn=>{
   const c=await pool.connect(); try {await c.query('BEGIN'); const result=await fn(c); await c.query('COMMIT'); return result;} catch(e){await c.query('ROLLBACK');throw e;} finally{c.release();}
  }};
 }
 if(directory!=='memory://'){
  const root=path.resolve(directory);await mkdir(root,{recursive:true});
  // Windows/OneDrive may mark folders read-only although native writes succeed.
  // NodeFS exposes that bit to PostgreSQL's virtual POSIX permission checks.
  // Normalize only directories inside this database; never follow symlinks.
  if(process.platform==='win32')await normalizeWindowsDirectories(root);
 }
 const wasmPath=process.env.PGLITE_WASM_PATH;
 const options=wasmPath?{wasmModule:await WebAssembly.compile(await readFile(wasmPath))}:{};
 const db=new PGlite(directory,options); await db.waitReady; return db;
}
export async function normalizeWindowsDirectories(root){
 const info=await lstat(root);if(info.isSymbolicLink()||!info.isDirectory())return;
 if(!(info.mode&0o200))await chmod(root,0o700);
 for(const entry of await readdir(root,{withFileTypes:true}))if(entry.isDirectory()&&!entry.isSymbolicLink())await normalizeWindowsDirectories(path.join(root,entry.name));
}
export async function migrate(db){await db.exec(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));}
export async function one(db,sql,args=[]){return (await db.query(sql,args)).rows[0];}
