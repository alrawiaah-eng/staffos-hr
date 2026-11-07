import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {connectDatabase,migrate} from './db.js';
import {seed} from './seed.js';
import {encryptionKey} from './security.js';
import {createApp,expiryScan} from './app.js';
const appRoot=process.env.STAFFOS_APP_ROOT||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const distRoot=path.join(appRoot,'dist');
const production=process.env.NODE_ENV==='production';
if(production&&(!process.env.DATABASE_URL||!process.env.APP_ORIGIN?.startsWith('https://')||process.env.SEED_DEMO!=='false'))throw Error('Production requires DATABASE_URL, HTTPS APP_ORIGIN and SEED_DEMO=false');
const db=await connectDatabase();await migrate(db);await seed(db);
const app=createApp(db,await encryptionKey(),{production});
if(existsSync(path.join(distRoot,'index.html'))&&!process.argv.includes('--dev')){app.use(express.static(distRoot));app.get('/{*path}',(req,res)=>res.sendFile(path.join(distRoot,'index.html')));}
else if(!production){const {createServer}=await import('vite');const vite=await createServer({root:appRoot,server:{middlewareMode:true},appType:'spa'});app.use(vite.middlewares);}
else throw Error('Run npm run build before production start');
await expiryScan(db);const timer=setInterval(()=>expiryScan(db).catch(console.error),60*60*1000);timer.unref();
export const server=app.listen(Number(process.env.PORT)||3000,process.env.HOST||'127.0.0.1',()=>console.log('HR & Leave running at '+(process.env.APP_ORIGIN||'http://localhost:3000')));
async function stop(){clearInterval(timer);server.close();await db.close();process.exit(0);}process.on('SIGTERM',stop);process.on('SIGINT',stop);
