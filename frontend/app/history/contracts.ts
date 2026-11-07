export const stageLabels: Record<string, string> = { recebida:'Recebida', pesquisando:'Em pesquisa', aguardando:'Aguardando cotação', comparação:'Em comparação', decidida:'Decidida' };
export const stageStyles: Record<string, string> = { recebida:'bg-slate-100 text-slate-600', pesquisando:'bg-blue-50 text-blue-700', aguardando:'bg-amber-50 text-amber-800', comparação:'bg-violet-50 text-violet-700', decidida:'bg-emerald-50 text-emerald-700' };
export const dateTime = (value: string) => new Intl.DateTimeFormat('pt-BR', { dateStyle:'short', timeStyle:'short' }).format(new Date(value));
export function moneyCents(value: number | null) {
  if (value === null || !Number.isSafeInteger(value)) return 'Não informado';
  const cents=BigInt(value), abs=cents < 0n ? -cents : cents;
  return `${cents < 0n ? '−' : ''}R$ ${(abs/100n).toLocaleString('pt-BR')},${String(abs%100n).padStart(2,'0')}`;
}
export interface HistoryRow {
  id:string; product:string; qty:number; destination:string; status:string; created_at:string; last_activity_at:string;
  quote_count:number; eligible_quote_count:number; partial_quote_count:number; selected_supplier:string|null; selected_tco_cents:number|null;
}
export interface HistoryList { items:HistoryRow[]; total:number; filtered_total:number; page:number; page_size:number; pages:number }
export interface HistoryQuote {
  id:string; supplier:string; unit_cents:number; shipping_cents:number|null; fees_cents:number|null; lead_days:number|null; available_qty:number|null;
  conditions:string; source_url:string|null; product_confirmed:boolean; destination_confirmed:boolean; created_at:string; tco_cents:number|null;
  eligible:boolean; eligibility_reasons:string[]; selected:boolean; channel:string|null;
}
export interface Conversation { id:string; channel:string; contact_name:string; messages:{ id:string;sender_type:'AI'|'SUPPLIER';content:string;delivery_status:string;channel:string;created_at:string }[] }
export interface HistoryDetail {
  id:string; product:string; specs:Record<string,string>; qty:number; destination:string; status:string; notice:string|null; created_at:string;
  last_activity_at:string; decision_quote_id:string|null; decision_at:string|null; quotes:HistoryQuote[]; conversations:Conversation[];
  timeline:{id:string;kind:string;created_at:string;label:string;description:string}[]; timeline_limitations:string;
}
