import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');process.chdir(root);
if(process.platform!=='win32')throw Error('Use your service manager to restart the app on this platform');
const result=spawnSync('powershell.exe',['-NoProfile','-Command',"Get-CimInstance Win32_Process -Filter \"name = 'node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"],{encoding:'utf8',windowsHide:true});
if(result.status!==0)throw Error('Could not inspect the running application. '+result.stderr);
const processes=JSON.parse(result.stdout.trim()||'[]');
const entry=path.join(root,'server/index.js').replaceAll('\\','/').toLowerCase();
for(const p of (Array.isArray(processes)?processes:[processes])){
 const command=String(p.CommandLine||'').replaceAll('\\','/').toLowerCase();
 if(command.includes('"'+entry+'"')||command.endsWith(' '+entry)){
  try{process.kill(p.ProcessId);}catch(e){if(e.code!=='ESRCH')throw e;}
 }
}
await new Promise(r=>setTimeout(r,1000));
const launched=spawnSync(process.execPath,[path.join(root,'server/launch.js')],{cwd:root,stdio:'inherit',windowsHide:true});
process.exitCode=launched.status??1;
