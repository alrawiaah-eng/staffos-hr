let csrf='';
export function setCsrf(value){csrf=value;}
export async function api(path,options={}){
 const response=await fetch('/api'+path,{credentials:'same-origin',...options,headers:{'Content-Type':'application/json','x-csrf-token':csrf,...options.headers},body:options.body===undefined?undefined:JSON.stringify(options.body)});
 const data=await response.json();if(!response.ok){if(response.status===401&&path!=='/login'&&path!=='/me')window.dispatchEvent(new Event('session-expired'));throw Error(data.error||'تعذر الاتصال بالخادم');}return data;
}
export async function uploadFile(file){if(!file)return null;if(file.size>5*1024*1024)throw Error('الحد الأقصى للملف 5 ميغابايت');return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve({data:r.result.split(',')[1],mime:file.type});r.onerror=()=>reject(Error('تعذرت قراءة الملف'));r.readAsDataURL(file);});}
export function downloadCsv(name,columns,rows){
 const quote=v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"';
 const csv='\uFEFF'+[columns.map(c=>quote(c[1])).join(','),...rows.map(r=>columns.map(([k])=>quote(r[k])).join(','))].join('\r\n');
 const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8;'}));const a=document.createElement('a');a.href=url;a.download=name+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
