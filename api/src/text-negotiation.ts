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
    for(const column of ['last_supplier_cents','counter_cents']) {
      if(!(db.prepare('PRAGMA table_info(text_negotiations)').all() as any[]).some(row=>row.name===column))db.exec(`ALTER TABLE text_negotiations ADD COLUMN ${column} INTEGER`);
    }
  }
  state(id:string,channel:string,supplier:string):any {return this.db.prepare('SELECT * FROM text_negotiations WHERE request_id=? AND channel=? AND supplier=?').get(id,channel,supplier);}
  accept(id:string,channel:string,supplier:string,accepted:boolean,message='',parsedPrice?:number|null) {
    const state=this.state(id,channel,supplier);
    // Only a complete, unqualified affirmative to an existing counteroffer is deterministic.
    // Conditions, negation, new amounts and unrelated uses of 'sim' still go through typed interpretation.
    const affirmative=/^(?:consigo(?: (?:sim|ss))?|sim(?:[,! ]+(?:consigo|aceito|pode ser))?|aceito(?: (?:a|essa|esta|sua) (?:contra)?proposta)?|de acordo|fechado|combinado|pode ser|confirmo)[.!\s]*$/iu.test(message.trim());
    if(/\b(?:não|nao|mas|porém|porem)\b/iu.test(message))return null;
    if(/\d/u.test(message)&&!(accepted&&parsedPrice===(state?.counter_cents??state?.target_cents)))return null;
    return (accepted || affirmative) && state && state.rounds>0 && !state.finished ? (state.counter_cents??state.target_cents) as number : null;
  }
  turn(request:any,channel:string,supplier:string,terms:any,finalOffer:boolean,key:string,message=''):{reply:string;negotiating:boolean} {
    return this.db.transaction(()=>{
      const cached=this.db.prepare('SELECT result FROM text_negotiation_turns WHERE request_id=? AND channel=? AND supplier=? AND update_key=?').get(request.id,channel,supplier,key) as any;
      if(cached)return JSON.parse(cached.result);
      this.db.prepare('INSERT OR IGNORE INTO text_negotiations(request_id,channel,supplier,initial_cents,target_cents,rounds,finished) VALUES(?,?,?,?,?,0,0)').run(request.id,channel,supplier,terms.unit_cents,targetUnitCents(request,terms.unit_cents));
      const state=this.state(request.id,channel,supplier);
      const refusal=state.rounds>0&&/^(?:n[aã]o(?:,?\s+(?:consigo|aceito|posso|d[aá]|tem como)(?:\s+(?:baixar|reduzir|melhorar|esse valor|esse pre[cç]o|o pre[cç]o))?)?|sem desconto|esse [eé] (?:o )?(?:[uú]ltimo|menor|melhor) (?:valor|pre[cç]o))[.!\s]*$/iu.test(message.trim());
      const previousCounter=state.counter_cents??state.target_cents;
      // Concede toward the supplier's new offer instead of repeating a rejected target.
      const counter=state.rounds===0?state.target_cents:Math.floor((previousCounter+terms.unit_cents)/2);
      const negotiating=!state.finished && !finalOffer && !refusal && terms.unit_cents>counter && state.rounds<3;
      this.db.prepare('UPDATE text_negotiations SET rounds=rounds+?,finished=?,last_supplier_cents=?,counter_cents=? WHERE request_id=? AND channel=? AND supplier=?').run(negotiating?1:0,negotiating?0:1,terms.unit_cents,negotiating?counter:previousCounter,request.id,channel,supplier);
      const money=(value:number)=>`R$ ${(value/100).toFixed(2)}`;
      const acknowledgement=state.rounds>0?`Entendi sua oferta de ${money(terms.unit_cents)} por unidade. Posso propor ${money(counter)}, mantendo as demais condições?`:`Obrigado pelos termos. Para ${request.qty} unidades, você consegue oferecer ${money(counter)} por unidade, mantendo o frete, as taxas e o prazo informados?`;
      const result={negotiating,reply:negotiating?`${acknowledgement} A compra depende de aprovação humana.`:`${refusal||finalOffer?'Entendido, vou respeitar seu limite. ':''}${quoteSummary(terms)}`};
      this.db.prepare('INSERT INTO text_negotiation_turns VALUES(?,?,?,?,?)').run(request.id,channel,supplier,key,JSON.stringify(result));
      return result;
    })();
  }
}
