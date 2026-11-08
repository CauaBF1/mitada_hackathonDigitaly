import Database from 'better-sqlite3';

export function targetUnitCents(request:any, initial:number) {
  const prices=(request.quotes||[]).filter((q:any)=>typeof q.source_url==='string' && q.source_url.startsWith('https://') && Number.isSafeInteger(q.unit_cents) && q.unit_cents>0).map((q:any)=>q.unit_cents);
  const reference=prices.length ? Math.min(...prices) : initial;
  return Math.max(1,Math.floor((reference*80+50)/100));
}
export function quoteSummary(terms:any) {
  return `Preço unitário R$ ${(terms.unit_cents/100).toFixed(2)}, frete R$ ${(terms.shipping_cents/100).toFixed(2)}, taxas R$ ${(terms.fees_cents/100).toFixed(2)}, prazo ${terms.lead_days} dias e estoque ${terms.available_qty} unidades${terms.payment_terms?`, pagamento ${terms.payment_terms}`:''}. Confirma essas condições para registrar a cotação?`;
}
export class TextNegotiation {
  constructor(private db:Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS text_negotiations(request_id TEXT NOT NULL,channel TEXT NOT NULL,supplier TEXT NOT NULL,initial_cents INTEGER NOT NULL,target_cents INTEGER NOT NULL,rounds INTEGER NOT NULL,finished INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(request_id,channel,supplier));
      CREATE TABLE IF NOT EXISTS text_negotiation_turns(request_id TEXT NOT NULL,channel TEXT NOT NULL,supplier TEXT NOT NULL,update_key TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(request_id,channel,supplier,update_key));`);
  }
  state(id:string,channel:string,supplier:string):any {return this.db.prepare('SELECT * FROM text_negotiations WHERE request_id=? AND channel=? AND supplier=?').get(id,channel,supplier);}
  accept(id:string,channel:string,supplier:string,accepted:boolean,message='') {
    const state=this.state(id,channel,supplier);
    // Only a complete, unqualified affirmative to an existing counteroffer is deterministic.
    // Conditions, negation, new amounts and unrelated uses of 'sim' still go through typed interpretation.
    const affirmative=/^(?:consigo(?: (?:sim|ss))?|sim(?:[,! ]+(?:consigo|aceito|pode ser))?|aceito(?: (?:a|essa|esta|sua) (?:contra)?proposta)?|de acordo|fechado|combinado|pode ser|confirmo)[.!\s]*$/iu.test(message.trim());
    return (accepted || affirmative) && state && state.rounds>0 && !state.finished ? state.target_cents as number : null;
  }
  turn(request:any,channel:string,supplier:string,terms:any,finalOffer:boolean,key:string):{reply:string;negotiating:boolean} {
    return this.db.transaction(()=>{
      const cached=this.db.prepare('SELECT result FROM text_negotiation_turns WHERE request_id=? AND channel=? AND supplier=? AND update_key=?').get(request.id,channel,supplier,key) as any;
      if(cached)return JSON.parse(cached.result);
      this.db.prepare('INSERT OR IGNORE INTO text_negotiations VALUES(?,?,?,?,?,0,0)').run(request.id,channel,supplier,terms.unit_cents,targetUnitCents(request,terms.unit_cents));
      const state=this.state(request.id,channel,supplier);
      const negotiating=!state.finished && !finalOffer && terms.unit_cents>state.target_cents && state.rounds<3;
      this.db.prepare('UPDATE text_negotiations SET rounds=rounds+?,finished=? WHERE request_id=? AND channel=? AND supplier=?').run(negotiating?1:0,negotiating?0:1,request.id,channel,supplier);
      const result={negotiating,reply:negotiating?`Obrigado pelos termos. Para ${request.qty} unidades, você consegue oferecer R$ ${(state.target_cents/100).toFixed(2)} por unidade, mantendo o frete, as taxas e o prazo informados? É uma negociação de cotação, sujeita à aprovação de compra.`:quoteSummary(terms)};
      this.db.prepare('INSERT INTO text_negotiation_turns VALUES(?,?,?,?,?)').run(request.id,channel,supplier,key,JSON.stringify(result));
      return result;
    })();
  }
}
