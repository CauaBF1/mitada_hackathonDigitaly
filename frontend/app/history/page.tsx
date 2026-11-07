'use client';

import { useEffect, useRef, useState, FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import RequestActions from '../RequestActions';
import { ArrowRight, ChevronLeft, ChevronRight, History, RefreshCw, Search, SlidersHorizontal } from 'lucide-react';
import { requestJson } from '../contracts';
import HistoryShell from './HistoryShell';
import { dateTime, moneyCents, stageLabels, stageStyles, type HistoryList } from './contracts';

const defaults = { q:'', status:'', from:'', to:'', sort:'newest', page:1, size:20 };
type Filters=typeof defaults;
const field='w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs text-slate-700 outline-none focus:border-blue-500';
function fromUrl():Filters {
  const p=new URLSearchParams(window.location.search);
  const date=(k:string)=>{const value=p.get(k)||'';const parsed=new Date(`${value}T00:00:00Z`);return /^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value?value:'';};
  return { q:(p.get('q')||'').slice(0,200), status:Object.hasOwn(stageLabels,p.get('status')||'') ? p.get('status')! : '', from:date('from'),to:date('to'),
    sort:p.get('sort')==='oldest'?'oldest':'newest',page:Number.isSafeInteger(Number(p.get('page')))?Math.min(1000000,Math.max(1,Number(p.get('page')))):1,size:[10,20,50].includes(Number(p.get('size')))?Number(p.get('size')):20 };
}
function urlParams(f:Filters) {
  const p=new URLSearchParams();
  for(const k of ['q','status','from','to'] as const)if(f[k])p.set(k,f[k]);
  p.set('sort',f.sort);p.set('page',String(f.page));p.set('size',String(f.size));return p;
}
export default function HistoryPage() {
  const router=useRouter();
  const [notice,setNotice]=useState('');
  const [filters,setFilters]=useState(defaults),[draft,setDraft]=useState(defaults),[ready,setReady]=useState(false);
  const [data,setData]=useState<HistoryList|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
  const latest=useRef(0);
  useEffect(()=>{const restore=()=>{const next=fromUrl();setFilters(next);setDraft(next);setReady(true);};restore();window.addEventListener('popstate',restore);return()=>window.removeEventListener('popstate',restore);},[]);
  useEffect(()=>{
    if(!ready)return;
    const controller=new AbortController(),version=++latest.current;
    setLoading(true);setError('');setData(null);
    const params=new URLSearchParams({page:String(filters.page),page_size:String(filters.size),sort:filters.sort});
    if(filters.q.trim())params.set('q',filters.q.trim());if(filters.status)params.set('status',filters.status);
    if(filters.from)params.set('created_from',new Date(`${filters.from}T00:00:00`).toISOString());
    if(filters.to){const end=new Date(`${filters.to}T00:00:00`);end.setDate(end.getDate()+1);params.set('created_before',end.toISOString());}
    window.history.replaceState(null,'',`/history?${urlParams(filters)}`);
    void requestJson(`/history?${params}`,{signal:controller.signal}).then(result=>{
      const next=result as HistoryList;
      if(!next||!Array.isArray(next.items)||typeof next.total!=='number'||typeof next.filtered_total!=='number')throw new Error('Histórico incompatível com a API.');
      if(version===latest.current&&!controller.signal.aborted){setData(next);if(next.page!==filters.page){setFilters(f=>({...f,page:next.page}));setDraft(f=>({...f,page:next.page}));}}
    }).catch(cause=>{if(!controller.signal.aborted&&version===latest.current)setError(cause instanceof Error?cause.message:'Não foi possível carregar o histórico.');})
      .finally(()=>{if(!controller.signal.aborted&&version===latest.current)setLoading(false);});
    return()=>controller.abort();
  },[filters,ready,refresh]);
  function apply(event:FormEvent<HTMLFormElement>){
    event.preventDefault();const values=new FormData(event.currentTarget);
    const next={...draft,q:String(values.get('q')||''),status:String(values.get('status')||''),from:String(values.get('from')||''),to:String(values.get('to')||''),sort:String(values.get('sort')||'newest'),size:Number(values.get('size')||20),page:1};
    if(next.from&&next.to&&next.from>next.to){setError('A data inicial deve ser anterior ou igual à data final.');return;}
    setFilters(next);setDraft(next);
  }
  function clear(){setDraft(defaults);setFilters({...defaults});}
  const hasFilters=!!(filters.q||filters.status||filters.from||filters.to);
  return <HistoryShell>
    <section className="flex flex-wrap items-start justify-between gap-4"><div><p className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em] text-blue-600"><History size={14}/>Memória operacional</p><h1 className="text-3xl font-semibold tracking-tight">Histórico de compras</h1><p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-500">Da primeira pesquisa à decisão: consulte produtos, propostas e conversas de cada solicitação.</p></div><button onClick={()=>setRefresh(x=>x+1)} disabled={loading} className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-semibold text-slate-600 disabled:opacity-50"><RefreshCw size={14} className={loading?'animate-spin':''}/>Atualizar histórico</button></section>
    <div className="grid gap-3 sm:grid-cols-3"><Summary label="Solicitações registradas" value={data?.total} detail="Inclui pesquisas e decisões concluídas"/><Summary label="Resultados desta consulta" value={data?.filtered_total} detail="Uma linha por solicitação"/><div className="rounded-2xl border border-blue-100 bg-blue-50/70 p-5"><p className="text-xs font-semibold text-blue-800">Rastreabilidade da compra</p><p className="mt-2 text-xs leading-relaxed text-blue-700">Etapas atuais e registros persistidos, com propostas parciais identificadas.</p></div></div>
    <form onSubmit={apply} aria-label="Filtros do histórico" className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5"><fieldset disabled={!ready} className="min-w-0 space-y-4"><div className="flex items-center gap-2 text-xs font-semibold text-slate-700"><SlidersHorizontal size={14}/>Consultar solicitações</div><div className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
      <label className="space-y-2 text-[11px] text-slate-500 sm:col-span-2 lg:col-span-1 xl:col-span-2"><span>Produto</span><div className="relative"><Search size={14} className="absolute left-3 top-3 text-slate-400"/><input name="q" className={`${field} pl-9`} value={draft.q} maxLength={200} placeholder="Buscar pelo nome do produto" onChange={e=>setDraft(f=>({...f,q:e.target.value}))}/></div></label>
      <label className="space-y-2 text-[11px] text-slate-500"><span>Estágio</span><select name="status" className={field} value={draft.status} onChange={e=>setDraft(f=>({...f,status:e.target.value}))}><option value="">Todos os estágios</option>{Object.entries(stageLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      <label className="space-y-2 text-[11px] text-slate-500"><span>Criada a partir de</span><input name="from" type="date" className={field} value={draft.from} onChange={e=>setDraft(f=>({...f,from:e.target.value}))}/></label>
      <label className="space-y-2 text-[11px] text-slate-500"><span>Criada até</span><input name="to" type="date" className={field} value={draft.to} onChange={e=>setDraft(f=>({...f,to:e.target.value}))}/></label>
    </div><div className="flex flex-wrap items-end gap-3 border-t border-slate-100 pt-4"><label className="space-y-1.5 text-[11px] text-slate-500"><span>Ordenar por</span><select name="sort" className={field} value={draft.sort} onChange={e=>setDraft(f=>({...f,sort:e.target.value}))}><option value="newest">Mais recentes</option><option value="oldest">Mais antigas</option></select></label><label className="space-y-1.5 text-[11px] text-slate-500"><span>Itens por página</span><select name="size" className={field} value={draft.size} onChange={e=>setDraft(f=>({...f,size:Number(e.target.value)}))}>{[10,20,50].map(n=><option key={n} value={n}>{n} solicitações</option>)}</select></label><button className="rounded-lg bg-blue-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-blue-700">Aplicar filtros</button><button type="button" onClick={clear} className="rounded-lg px-3 py-2.5 text-xs font-semibold text-slate-500 hover:bg-slate-50">Limpar filtros</button><span className="text-[10px] text-slate-400 lg:ml-auto">Datas no horário local do navegador</span></div></fieldset></form>
    {notice&&<p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-xs text-emerald-800">{notice}</p>}
    {error&&<div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs text-rose-800"><span>{error}</span><button onClick={()=>setRefresh(x=>x+1)} className="font-semibold underline">Tentar novamente</button></div>}
    <section aria-label="Solicitações do histórico" aria-busy={loading} className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      {loading?<div role="status" className="space-y-4 p-6"><p className="text-sm text-slate-500">Carregando histórico…</p>{[1,2,3,4].map(i=><div key={i} className="h-14 animate-pulse rounded-lg bg-slate-100"/>)}</div>:data?.items.length?<>
        <div className="overflow-x-auto"><table className="w-full min-w-[1050px] text-left text-xs"><caption className="sr-only">Histórico de solicitações de compra, seus estágios e propostas</caption><thead className="border-b border-slate-200 bg-slate-50 text-[10px] uppercase tracking-wide text-slate-400"><tr>{['Produto / solicitação','Quantidade / destino','Criada em / último registro','Estágio','Propostas / pendências','Decisão','Ações'].map(h=><th key={h} scope="col" className="px-5 py-4 font-semibold">{h}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{data.items.map(row=><tr key={row.id} className="align-top hover:bg-blue-50/30"><td className="max-w-72 px-5 py-5"><Link href={`/history/${row.id}?back=${encodeURIComponent(urlParams(filters).toString())}`} className="group flex items-start gap-2 font-semibold leading-relaxed text-slate-800 hover:text-blue-700"><span className="break-words">{row.product}</span><ArrowRight size={13} className="mt-1 shrink-0 text-blue-500"/></Link><p className="mt-2 font-mono text-[10px] text-slate-400" title={row.id}>#{row.id.slice(0,8)}</p></td><td className="px-5 py-5"><p className="numeric font-medium">{row.qty.toLocaleString('pt-BR')} un.</p><p className="mt-2 max-w-40 break-words text-[11px] text-slate-500">{row.destination}</p></td><td className="whitespace-nowrap px-5 py-5 text-[11px]"><p>{dateTime(row.created_at)}</p><p className="mt-2 text-slate-400">Último: {dateTime(row.last_activity_at)}</p></td><td className="px-5 py-5"><span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-[10px] font-semibold ${stageStyles[row.status]||'bg-slate-100 text-slate-600'}`}>{stageLabels[row.status]||row.status}</span></td><td className="px-5 py-5"><p className="font-medium">{row.quote_count} proposta(s)</p><p className="mt-2 text-[11px] text-slate-500">{row.quote_count?`${row.eligible_quote_count} apta(s) · ${row.partial_quote_count} com pendências`:'Aguardando propostas'}</p></td><td className="max-w-48 px-5 py-5">{row.selected_supplier?<><p className="font-medium text-emerald-700">{row.selected_supplier}</p><p className="numeric mt-2 font-semibold">{moneyCents(row.selected_tco_cents)}</p></>:<span className="text-slate-400">Sem decisão registrada</span>}</td><td className="min-w-48 px-5 py-5"><RequestActions id={row.id} product={row.product} canRepeat={['decidida','concluida'].includes(row.status)} compact onDeleted={()=>{setNotice('Solicitação excluída.');setRefresh(x=>x+1);}} onRepeated={created=>router.push(`/dashboard?request=${created.id}&repeated=1#kanban`)}/></td></tr>)}</tbody></table></div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-5 py-4"><p role="status" className="text-[11px] text-slate-500">{(data.page-1)*data.page_size+1}–{Math.min(data.page*data.page_size,data.filtered_total)} de {data.filtered_total} resultados</p><nav aria-label="Paginação do histórico" className="flex items-center gap-3 text-xs"><button aria-label="Página anterior" disabled={data.page===1} onClick={()=>setFilters({...filters,page:data.page-1})} className="rounded-lg border border-slate-200 p-2 disabled:opacity-30"><ChevronLeft size={15}/></button><span>Página {data.page} de {data.pages}</span><button aria-label="Próxima página" disabled={data.page>=data.pages} onClick={()=>setFilters({...filters,page:data.page+1})} className="rounded-lg border border-slate-200 p-2 disabled:opacity-30"><ChevronRight size={15}/></button></nav></div>
      </>:!error&&<div className="px-6 py-16 text-center"><History className="mx-auto mb-4 text-slate-300" size={32}/><h2 className="text-base font-semibold">{hasFilters&&data?.total?'Nenhuma solicitação encontrada':'Seu histórico começa com uma pesquisa'}</h2><p className="mt-2 text-sm text-slate-500">{hasFilters&&data?.total?'Ajuste os filtros para consultar outros produtos ou períodos.':'As solicitações criadas no workspace aparecerão aqui, inclusive após a decisão.'}</p>{hasFilters&&data?.total?<button onClick={clear} className="mt-5 text-xs font-semibold text-blue-700">Limpar filtros</button>:<Link href="/dashboard" className="mt-5 inline-flex text-xs font-semibold text-blue-700">Ir para solicitações →</Link>}</div>}
    </section><p className="text-[10px] leading-relaxed text-slate-400">Último registro considera criação, propostas e mensagens com data persistida. Este histórico é um registro operacional; a consulta automática pelos agentes não faz parte desta aba.</p>
  </HistoryShell>;
}
function Summary({label,value,detail}:{label:string;value:number|undefined;detail:string}) {return <div className="rounded-2xl border border-slate-200 bg-white p-5"><p className="text-xs text-slate-500">{label}</p><p className="numeric my-2 text-3xl font-semibold tracking-tight">{value===undefined?'—':value.toLocaleString('pt-BR')}</p><p className="text-[10px] text-slate-400">{detail}</p></div>;}
