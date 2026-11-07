const {app,BrowserWindow,dialog}=require('electron');
const path=require('node:path');
const fs=require('node:fs');
const {pathToFileURL}=require('node:url');

const port=3010;
let windowRef;

async function waitForHealth(){
 for(let attempt=0;attempt<60;attempt++){
  try{const response=await fetch(`http://127.0.0.1:${port}/api/health`);if(response.ok)return;}
  catch{}
  await new Promise(resolve=>setTimeout(resolve,250));
 }
 throw new Error('StaffOS server did not become ready');
}

async function start(){
 app.setName('StaffOS');
 const appRoot=app.getAppPath();
 // Keep the legacy database untouched while the corrected desktop runtime
 // starts on a clean store. It can be migrated separately after validation.
 const dataRoot=path.join(app.getPath('userData'),'data','postgres-v2');
 fs.mkdirSync(dataRoot,{recursive:true});
 const wasmCandidates=[path.join(process.resourcesPath,'app.asar.unpacked','node_modules','@electric-sql','pglite','dist','pglite.wasm'),path.join(appRoot,'node_modules','@electric-sql','pglite','dist','pglite.wasm')];
 const wasmPath=wasmCandidates.find(candidate=>fs.existsSync(candidate));
 if(wasmPath)process.env.PGLITE_WASM_PATH=wasmPath;
 process.env.STAFFOS_APP_ROOT=appRoot;
 process.env.PGLITE_DIR=dataRoot;
 process.env.PORT=String(port);
 process.env.HOST='127.0.0.1';
 process.env.APP_ORIGIN=`http://127.0.0.1:${port}`;
 process.env.NODE_ENV='development';
 process.env.SEED_DEMO='true';
 process.env.DEMO_PASSWORD=process.env.DEMO_PASSWORD||'DemoPass!2026';
 await import(pathToFileURL(path.join(appRoot,'server','index.js')).href);
 await waitForHealth();
 windowRef=new BrowserWindow({width:1440,height:900,minWidth:1100,minHeight:700,show:false,webPreferences:{contextIsolation:true,sandbox:true}});
 windowRef.on('closed',()=>{windowRef=null;});
 await windowRef.loadURL(`http://127.0.0.1:${port}`);
 windowRef.show();
}

app.whenReady().then(start).catch(error=>{
 console.error(error);
 dialog.showErrorBox('تعذر تشغيل StaffOS',error.message);
 app.quit();
});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
