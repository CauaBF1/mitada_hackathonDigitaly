import HistoryDetails from './HistoryDetails';

export default async function HistoryDetailPage({ params, searchParams }: { params:Promise<{id:string}>;searchParams:Promise<{back?:string|string[]}> }) {
  const {id}=await params, search=await searchParams;
  const back=new URLSearchParams(typeof search.back==='string'?search.back:'');
  const safe=new URLSearchParams();
  for(const key of ['q','status','from','to','sort','page','size'])if(back.has(key))safe.set(key,back.get(key)!);
  return <HistoryDetails id={id} backHref={`/history${safe.size?`?${safe}`:''}`}/>;
}
