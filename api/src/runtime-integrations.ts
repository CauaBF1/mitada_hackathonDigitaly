import { lookup } from 'node:dns/promises';
import { publicAppUrl } from './voice-session';

/** Docker-internal webhook delivery; no host-side relay is necessary. */
export async function configureWhatsAppWebhook() {
  const base=process.env.WHATSAPP_API_URL?.replace(/\/$/,'');
  const key=process.env.WHATSAPP_API_KEY, secret=process.env.WHATSAPP_WEBHOOK_SECRET;
  const name=process.env.WHATSAPP_INSTANCE_NAME;
  if(!base || !key || !secret || !name || process.env.WHATSAPP_AUTO_CONFIGURE_WEBHOOK==='false')return false;
  const headers={'Content-Type':'application/json',apikey:key};
  const status=await fetch(`${base}/instance/connectionState/${encodeURIComponent(name)}`,{headers,signal:AbortSignal.timeout(8000)});
  if(status.status===404){
    const created=await fetch(`${base}/instance/create`,{method:'POST',headers,body:JSON.stringify({instanceName:name,integration:'WHATSAPP-BAILEYS',qrcode:true}),signal:AbortSignal.timeout(10000)});
    if(!created.ok)return false;
  } else if(!status.ok)return false;
  const url=process.env.WHATSAPP_INTERNAL_WEBHOOK_URL || 'http://api:4000/webhook/whatsapp';
  const response=await fetch(`${base}/webhook/set/${encodeURIComponent(name)}`,{method:'POST',headers,
    body:JSON.stringify({webhook:{enabled:true,url,headers:{'x-whatsapp-webhook-secret':secret},byEvents:false,base64:false,events:['MESSAGES_UPSERT']}}),signal:AbortSignal.timeout(10000)});
  return response.ok;
}

export async function refreshPublicOrigin() {
  const metrics=process.env.TUNNEL_METRICS_URL;
  if(metrics){
    try {
      const response=await fetch(metrics,{signal:AbortSignal.timeout(1500)});
      if(response.ok){
        const text=await response.text();const found=text.match(/userHostname="(https:\/\/[a-z0-9-]+\.trycloudflare\.com)"/i);
        if(found)process.env.PUBLIC_APP_URL=found[1];
      }
    }catch{}
  }
  return publicAppUrl();
}

export async function configureTelegramWebhook(resolveIPv4:(host:string)=>Promise<{address:string}>=host=>lookup(host,{family:4})) {
  const token=process.env.TELEGRAM_BOT_TOKEN,secret=process.env.TELEGRAM_WEBHOOK_SECRET;
  const origin=publicAppUrl();
  if(!token || !secret || !origin.startsWith('https://'))return false;
  const payload:any={url:`${origin}/api/webhook/telegram`,secret_token:secret,allowed_updates:['message']};
  const send=async()=>{
    const response=await fetch(`${process.env.TELEGRAM_API_URL||'https://api.telegram.org'}/bot${token}/setWebhook`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
    const body:any=await response.json();return {ok:response.ok&&body.ok===true,description:String(body.description||'')};
  };
  let result=await send();
  if(!result.ok && /failed to resolve host/i.test(result.description)){
    // Official Bot API option: retain HTTPS hostname/SNI while bypassing stale Telegram DNS.
    payload.ip_address=(await resolveIPv4(new URL(origin).hostname)).address;
    result=await send();
  }
  return result.ok;
}

export function startIntegrationBootstrap() {
  if(process.env.AUTO_CONFIGURE_INTEGRATIONS!=='true')return;
  let running=false,waReady=false,tgOrigin='';
  const tick=async()=>{
    if(running)return;running=true;
    try{
      const origin=await refreshPublicOrigin();
      if(!waReady)waReady=await configureWhatsAppWebhook().catch(()=>false);
      if(origin!==tgOrigin && await configureTelegramWebhook().catch(()=>false))tgOrigin=origin;
    }finally{running=false;}
  };
  void tick();setInterval(()=>void tick(),10000).unref();
}
