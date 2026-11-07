import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdirSync,openSync,closeSync,existsSync,readFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');process.chdir(root);
await import('dotenv/config');
const port=Number(process.env.PORT)||3000;
const url=process.env.APP_ORIGIN||`http://localhost:${port}`;
const windowsBrowser=process.platform==='win32'&&process.argv.includes('--windows-browser');
const dataDir=process.env.STAFFOS_DATA_DIR||'data';
async function healthy(){try{const r=await fetch(url+'/api/health',{signal:AbortSignal.timeout(1500)});const b=await r.json();return r.ok&&b.ok&&b.service==='hr-leave-v1';}catch{return false;}}
function openBrowser(){
 const browser=spawn('explorer.exe',[url],{stdio:'ignore',windowsHide:true});
 browser.on('error',()=>console.error(`Open ${url} in your browser.`));
 browser.unref();
}
if(windowsBrowser){
 if(await healthy()){
  openBrowser();
 }else{
  if(!existsSync('dist/index.html'))throw Error('Build the application first: npm install && npm run build');
  const instance=createServer(socket=>socket.end());
  instance.listen(port+1,'127.0.0.1');
  try{await once(instance,'listening');}catch(error){
   if(error.code!=='EADDRINUSE')throw error;
   throw Error(`The StaffOS startup port ${port+1} is busy. If StaffOS is starting, wait and open ${url}.`);
  }
  const {server}=await import('./index.js');
  if(!server.listening)await once(server,'listening');
  instance.unref();
  console.log('Keep this window open while using StaffOS.');
  openBrowser();
 }
}else{
 if(!await healthy()){
  if(!existsSync('dist/index.html'))throw Error('Build the application first: npm install && npm run build');
  mkdirSync(dataDir,{recursive:true});
  const out=openSync(path.join(dataDir,'server-output.log'),'a'),err=openSync(path.join(dataDir,'server-error.log'),'a');
  const server=spawn(process.execPath,[path.join(root,'server/index.js')],{cwd:root,detached:true,windowsHide:true,stdio:['ignore',out,err]});
  server.on('error',e=>{console.error(e.message);process.exitCode=1;});
  server.unref();
  closeSync(out);closeSync(err);
  let ready=false;
  for(let i=0;i<40;i++){if(await healthy()){ready=true;break;}await new Promise(r=>setTimeout(r,500));}
  if(!ready){const errLog=path.join(dataDir,'server-error.log');console.error('Unable to start HR. Details: '+errLog);console.error(readFileSync(errLog,'utf8').slice(-3000));process.exit(1);}
 }
 console.log('HR is running: '+url);
}
