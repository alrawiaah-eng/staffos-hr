import React,{useEffect,useRef,useState,useId} from 'react';
import {CalendarDays} from 'lucide-react';
import {formatDate,parseDate} from './dates';
export default function DateField({label,name,value,defaultValue='',onChange,required=false,min,max,disabled=false}){
 const initial=value??defaultValue??'';const [iso,setIso]=useState(initial.slice(0,10)),[text,setText]=useState(initial?formatDate(initial):'');const input=useRef(),picker=useRef();const id=useId();
 useEffect(()=>{if(value!==undefined){setIso(value||'');setText(value?formatDate(value):'');}},[value]);
 function update(raw){
  setText(raw);const parsed=raw.trim()?parseDate(raw):'';
  let error=raw.trim()&&!parsed?'أدخل تاريخًا صحيحًا بصيغة يوم/شهر/سنة':'';
  if(parsed&&min&&parsed<min)error=`التاريخ يجب ألا يسبق ${formatDate(min)}`;
  if(parsed&&max&&parsed>max)error=`التاريخ يجب ألا يتجاوز ${formatDate(max)}`;
  input.current?.setCustomValidity(error);
  if(!error){setIso(parsed||'');onChange?.({target:{value:parsed||'',name}});}else setIso('');
 }
 useEffect(()=>{if(input.current){const parsed=text?parseDate(text):'';input.current.setCustomValidity(text&&!parsed?'أدخل تاريخًا صحيحًا بصيغة يوم/شهر/سنة':parsed&&min&&parsed<min?`التاريخ يجب ألا يسبق ${formatDate(min)}`:parsed&&max&&parsed>max?`التاريخ يجب ألا يتجاوز ${formatDate(max)}`:'');}},[min,max,text]);
 return <div className="field"><label htmlFor={id}>{label}</label><div className="date-control"><input id={id} ref={input} type="text" dir="ltr" inputMode="numeric" placeholder="DD/MM/YYYY" value={text} required={required} disabled={disabled} aria-describedby={id+'-hint'} onChange={e=>update(e.target.value)} onBlur={()=>{const parsed=parseDate(text);if(parsed)setText(formatDate(parsed));}}/><input type="hidden" name={name} value={iso} disabled={disabled}/><span className="date-calendar"><CalendarDays size={19}/><input ref={picker} type="date" lang="ar-IQ" aria-label={`اختيار ${label} من التقويم`} value={iso} min={min} max={max} disabled={disabled} onChange={e=>update(e.target.value?formatDate(e.target.value):'')}/></span></div><small id={id+'-hint'} className="date-hint">يوم / شهر / سنة</small></div>;
}
