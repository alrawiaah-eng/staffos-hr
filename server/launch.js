import {spawn} from 'node:child_process';
import {mkdirSync,openSync,closeSync,existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');process.chdir(root);
await import('dotenv/config');
const port=Number(process.env.PORT)||3000;
const url=process.env.APP_ORIGIN||`http://localhost:${port}`;
const windowsBrowser=process.platform==='win32'&&process.argv.includes('--windows-browser');
const dataDir=process.env.STAFFOS_DATA_DIR||'data';
let server;
async function healthy(){try{const r=await fetch(url+'/api/health',{signal:AbortSignal.timeout(1500)});const b=await r.json();return r.ok&&b.ok&&b.service==='hr-leave-v1';}catch{return false;}}
if(!await healthy()){
 if(!existsSync('dist/index.html'))throw Error('Build the application first: npm install && npm run build');
 mkdirSync(dataDir,{recursive:true});
 const out=openSync(path.join(dataDir,'server-output.log'),'a'),err=openSync(path.join(dataDir,'server-error.log'),'a');
 server=spawn(process.execPath,[path.join(root,'server/index.js')],{cwd:root,detached:!windowsBrowser,windowsHide:true,stdio:['ignore',out,err]});
 server.on('error',e=>{console.error(e.message);process.exitCode=1;});
 if(!windowsBrowser)server.unref();
 closeSync(out);closeSync(err);
 let ready=false;
 for(let i=0;i<40;i++){if(await healthy()){ready=true;break;}await new Promise(r=>setTimeout(r,500));}
 if(!ready){const errLog=path.join(dataDir,'server-error.log');console.error('Unable to start HR. Details: '+errLog);console.error(readFileSync(errLog,'utf8').slice(-3000));if(windowsBrowser)server.kill();process.exit(1);}
}
console.log('HR is running: '+url);
if(windowsBrowser){
 const browser=spawn('cmd.exe',['/d','/c','start','', 'http://localhost:3000'],{stdio:'ignore',windowsHide:true});
 browser.on('error',()=>console.error('Open http://localhost:3000 in your browser.'));
 if(server){
  console.log('Keep this window open while using StaffOS.');
  server.on('exit',code=>{process.exitCode=code??1;});
 }
}
