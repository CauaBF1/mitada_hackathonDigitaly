// Fixtures are used only by isolated tests, never by the application's data path.
import { randomUUID } from 'node:crypto';
export function seedHistory(db) {
  const ids=Array.from({length:26},()=>randomUUID());
  const quoteIds=[randomUUID(),randomUUID()];
  db.transaction(()=>{
    for(let i=0;i<ids.length;i++){
      const status=i===1?'comparação':i===2?'decidida':['recebida','pesquisando','aguardando','comparação','decidida'][i%5];
      const created=new Date(Date.UTC(2026,10,i+1,12)).toISOString();
      db.prepare('INSERT INTO requests(id,product,specs,qty,destination,status,decision,created_at,agent_analysis) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(ids[i],i<3?'SSD empresarial':i===3?'Produto 100% real_test':`Produto histórico ${String(i).padStart(2,'0')}`,JSON.stringify({capacidade:'1 TB'}),2,'01001-000',status,i===2?quoteIds[1]:null,created,JSON.stringify({private:'must-not-leak'}));
    }
    const insert=db.prepare('INSERT INTO quotes(id,request_id,event_id,supplier,unit_cents,shipping_cents,fees_cents,lead_days,available_qty,conditions,product_confirmed,destination_confirmed,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
    insert.run(quoteIds[0],ids[1],'telegram:fixture-1','Fornecedor parcial',12345,null,0,null,2,'Prazo e frete pendentes.',1,0,'2026-11-02T13:00:00.000Z');
    insert.run(quoteIds[1],ids[2],'whatsapp:fixture-2','Fornecedor escolhido',10000,900,100,3,10,'Pagamento Pix.',1,1,'2026-11-03T13:00:00.000Z');
    for(const [number,name] of [['5511999999999','Contato A'],['5511888888888','Contato B']])db.prepare('INSERT INTO whatsapp_contacts VALUES(?,?,?,?)').run(ids[2],name.replace(' ','-'),name,number);
    const message=db.prepare('INSERT INTO conversation_messages(id,request_id,chat_id,sender_type,content,channel,created_at,delivery_status) VALUES(?,?,?,?,?,?,?,?)');
    message.run(randomUUID(),ids[2],'5511999999999','SUPPLIER','Condições exclusivas do contato A.','whatsapp','2026-11-03T14:00:00.000Z','received');
    message.run(randomUUID(),ids[2],'5511888888888','SUPPLIER','Condições exclusivas do contato B.','whatsapp','2026-11-03T15:00:00.000Z','received');
    message.run(randomUUID(),ids[2],'12345','AI','Mensagem de outro canal.','telegram','2026-11-03T16:00:00.000Z','uncertain');
  })();
  return {empty:ids[0],partial:ids[1],decided:ids[2],literal:ids[3],ids,quoteIds};
}
