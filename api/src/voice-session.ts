import { createHmac, timingSafeEqual } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';

export function publicAppUrl() {
  const value = (process.env.PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/$/, '');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('PUBLIC_APP_URL deve ser a origem HTTP(S) pública da aplicação.');
  return value;
}
export function callSessionToken(requestId: string, supplierId: string) {
  const key = process.env.INTERNAL_API_TOKEN;
  if (!key) throw new Error('Configure INTERNAL_API_TOKEN.');
  const payload = Buffer.from(JSON.stringify({request_id:requestId,supplier_id:supplierId,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url');
  return `${payload}.${createHmac('sha256',key).update(payload).digest('base64url')}`;
}
export function verifyCallSessionToken(token: string, body: any) {
  try {
    const [payload,signature,...rest] = token.split('.');
    const key=process.env.INTERNAL_API_TOKEN;
    if (!key || rest.length || !payload || !signature) throw new Error();
    const expected=createHmac('sha256',key).update(payload).digest();
    const received=Buffer.from(signature,'base64url');
    if (received.length!==expected.length || !timingSafeEqual(expected,received)) throw new Error();
    const data=JSON.parse(Buffer.from(payload,'base64url').toString());
    const metadata=body?.message?.call?.metadata || body?.metadata || body;
    if (!Number.isInteger(data.exp) || data.exp<=Date.now()/1000 || data.request_id!==metadata?.request_id || data.supplier_id!==metadata?.supplier_id) throw new Error();
  } catch { throw new UnauthorizedException('Sessão de voz inválida ou expirada.'); }
}
