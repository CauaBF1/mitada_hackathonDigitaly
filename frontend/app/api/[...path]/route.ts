import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
const base = () => (process.env.API_URL || "http://127.0.0.1:4000").replace(/\/$/, "");
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function upstream(path: string, init: RequestInit = {}) {
  return fetch(`${base()}/${path.replace(/^\//, "")}`, { ...init, cache: "no-store", headers: { "Content-Type": "application/json", ...init.headers } });
}
function asRun(row: any) {
  const quotes = Array.isArray(row.quotes) ? row.quotes : [];
  const analysis = row.agent_analysis || {};
  const rawErrors = [...(Array.isArray(analysis.errors) ? analysis.errors : []), ...(Array.isArray(analysis.discovery?.errors) ? analysis.discovery.errors : [])];
  const errors = [...new Set(rawErrors.filter((value: unknown): value is string => typeof value === "string"))];
  const sources = quotes.flatMap((quote: any) => {
    let url: URL;
    try { url = new URL(quote.source_url); if (!["http:", "https:"].includes(url.protocol)) return []; } catch { return []; }
    const productName = String(quote.conditions || "").split(" | ")[0] || row.product;
    const domain = url.hostname.replace(/^www\./, "");
    return [{
      quote_id: String(quote.id), eligible: quote.eligible === true, additional_costs: null, gtin: null, supplier_name: quote.supplier, supplier_domain: domain,
      supplier_website: `${url.protocol}//${url.host}`, product_name: productName, product_url: url.href,
      price: (Number(quote.unit_cents) / 100).toFixed(2), shipping_fee: quote.shipping_cents == null ? null : (Number(quote.shipping_cents) / 100).toFixed(2),
      shipping_scope: null, currency: "BRL", availability: quote.available_qty == null ? "Não confirmada" : String(quote.available_qty),
      price_basis: "Preço unitário da cotação registrada pela API Nest", observed_at: quote.created_at,
      extraction_method: "Cotação persistida na API Nest", evidence_sha256: "",
    }];
  });
  const chosen = row.decision ? quotes.find((quote: any) => quote.id === row.decision) : null;
  const chosenUrl = chosen?.source_url || null;
  const audit = chosen?.eligible ? {
    additional_costs: [], additional_cost_total: (Number(chosen.fees_cents || 0) / 100).toFixed(2), source_type: "legacy_unverified",
    agreement_status: "confirmed_quote", savings_status: "legacy_unverified", confidence: "legacy_unverified", missing_information: [], roi_basis: "tco_v1",
    deal_closed: true, final_unit_price: (Number(chosen.unit_cents) / 100).toFixed(2),
    final_shipping_fee: (Number(chosen.shipping_cents) / 100).toFixed(2), final_total_cost: Number(chosen.tco).toFixed(2),
    audit_justification: "Decisão humana registrada na API Nest. TCO e valores refletem a proposta persistida; economia não calculada por ausência de baseline negociado.",
    shipping_savings: null, tco_savings: null, tco_cost_avoidance: null,
    final_price: (Number(chosen.unit_cents) / 100).toFixed(2), shipping_fee: (Number(chosen.shipping_cents) / 100).toFixed(2),
    delivery_days: chosen.lead_days, delivery_day_type: "unspecified", quantity: row.qty,
    product_subtotal: (Number(chosen.unit_cents * row.qty) / 100).toFixed(2), initial_tco: null,
    final_tco: Number(chosen.tco).toFixed(2), market_tco: null, hard_savings: null, cost_avoidance: null,
    justification: "Registro factual da proposta escolhida e da decisão humana.", limitations: ["Baseline de mercado e preço anterior não disponíveis; economias não calculadas."],
    evidence_message_ids: [], audited_at: chosen.created_at,
  } : null;
  const status = row.status === "decidida" ? "DONE" : row.status === "pesquisando" || row.status === "recebida" ? "CALLING" : quotes.length ? "NEGOTIATING" : "TODO";
  const profile = row.profile || row.specs?.profile || "saude";
  return {
    id: String(row.id), profile, version: row.version, item: row.product, qty: row.qty, requested_target: null, target_price: null,
    market_average: null, status, stage: row.status, sources, reputations: [], selected_product_url: chosenUrl,
    quote: chosen ? {
      additional_costs: null, initial_additional_costs: null, supplier_domain: (() => { try { return new URL(chosen.source_url).hostname.replace(/^www\./, ""); } catch { return null; } })(),
      supplier_name: chosen.supplier, product_name: String(chosen.conditions || "").split(" | ")[0] || row.product,
      quantity: row.qty, delivery_location: row.destination, initial_message_id: null, initial_offer_evidence: [], source_type: "legacy_unverified",
      agreement_status: chosen.eligible ? "confirmed_quote" : "legacy_unverified", request_id: String(row.id), event_id: chosen.event_id,
      product_url: chosen.source_url || "", initial_price: (Number(chosen.unit_cents) / 100).toFixed(2), final_price: (Number(chosen.unit_cents) / 100).toFixed(2),
      shipping_fee: chosen.shipping_cents == null ? null : (Number(chosen.shipping_cents) / 100).toFixed(2), initial_shipping_fee: null,
      initial_tco: chosen.tco == null ? null : Number(chosen.tco).toFixed(2), final_tco: chosen.tco == null ? null : Number(chosen.tco).toFixed(2),
      delivery_days: chosen.lead_days, delivery_day_type: "unspecified", available_qty: chosen.available_qty,
      delivery_time: chosen.lead_days == null ? "Não confirmado" : `${chosen.lead_days} dias`, conditions: chosen.conditions || "",
    } : null,
    hard_savings: null, cost_avoidance: null, errors, notice: row.notice || null,
    created_at: row.created_at, updated_at: row.created_at, data_mode: "real", mode: "live",
    delivery_location: row.destination, tco_base: null, market_shipping: null, target_basis: "complete_tco", audit,
    candidates: quotes.flatMap((quote: any) => { try { const url = new URL(quote.source_url); return [{ url: url.href, title: quote.supplier, description: String(quote.conditions || ""), kind: "product", price: (Number(quote.unit_cents) / 100).toFixed(2), product_name: String(quote.conditions || "").split(" | ")[0] || row.product, error: null }]; } catch { return []; } }),
    comparison_item: analysis.query || row.product, selected_candidate_url: chosenUrl,
    blocked_sites: new Set(errors.filter((error: string) => /bloquead[ao].*HTTP 403/i.test(error)).map((error: string) => error.match(/(?:www\.)?[\w.-]+\.[a-z]{2,}/i)?.[0]).filter(Boolean)).size,
    discovery_justification: analysis.discovery?.justification || null, discovery_plan: null, supplier_profiles: {}, tactical_summary: null, model_used: null,
  };
}
async function dashboard() {
  const response = await upstream("requests");
  if (!response.ok) return new NextResponse(await response.text(), { status: response.status });
  const rows: any = await response.json();
  if (!Array.isArray(rows)) return json({ detail: "Resposta incompatível da API de solicitações." }, 502);
  const runs = rows.map(asRun);
  const active = runs.filter((row: any) => row.status !== "DONE").length;
  const quotes = rows.flatMap((row: any) => Array.isArray(row.quotes) ? row.quotes : []);
  return json({ data_mode: "real", metrics_available: false, total_runs: runs.length, runs, metrics: {
    // A API atual não registra baseline de mercado; nenhuma economia/preço final é inferida.
    hard_savings: "0.00", cost_avoidance: "0.00", final_spend: "0.00",
    completed_count: runs.filter((row: any) => row.status === "DONE").length,
    active_count: active, verified_suppliers_count: new Set(quotes.filter((quote: any) => quote.source_url && quote.product_confirmed && quote.destination_confirmed).map((quote: any) => quote.supplier).filter(Boolean)).size,
    pending_tco_count: quotes.filter((quote: any) => quote.tco === null).length,
  } });
}
async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(request.nextUrl.hostname)) return json({ detail: "Acesso permitido somente pelo endereço local." }, 403);
  const origin = request.headers.get("origin");
  if (origin) { try { if (new URL(origin).host !== request.headers.get("host")) return json({ detail: "Origem inválida." }, 403); } catch { return json({ detail: "Origem inválida." }, 403); } }
  const endpoint = (await context.params).path.join("/");
  if (request.method === "GET" && endpoint === "godmode/dashboard") return dashboard();

  const chat = endpoint.match(/^chat\/([0-9a-f-]{36})$/i);
  if (request.method === "GET" && chat) {
    const response = await upstream(`requests/${chat[1]}/messages${request.nextUrl.search}`);
    if (!response.ok) return new NextResponse(await response.text(), { status: response.status });
    const rows: any = await response.json();
    if (!Array.isArray(rows)) return json({ detail: "Histórico de mensagens incompatível." }, 502);
    return json(rows.map((message: any) => ({ id: String(message.id), request_id: chat[1], supplier_domain: message.supplier_domain || "", sender_type: message.sender_type, text: message.content, timestamp: message.created_at, delivery_status: message.delivery_status || "" })));
  }
  if (request.method === "POST" && chat) {
    const response = await upstream(`requests/${chat[1]}/contact-supplier`, { method: "POST", body: await request.text() });
    return new NextResponse(await response.text(), { status: response.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }
  if (request.method === "POST" && endpoint === "request") {
    let input: any;
    try { input = await request.json(); } catch { return json({ detail: "Corpo JSON inválido." }, 400); }
    const profile = input.profile || "saude";
    const specs = { ...(input.specs || {}), profile };
    const response = await upstream("requests", { method: "POST", headers: request.headers.get("Idempotency-Key") ? { "Idempotency-Key": request.headers.get("Idempotency-Key")! } : {}, body: JSON.stringify({ product: input.item, specs, qty: input.qty, destination: input.delivery_location, profile }) });
    if (!response.ok) return new NextResponse(await response.text(), { status: response.status });
    return json(asRun(await response.json()), response.status);
  }
  const decision = endpoint.match(/^request\/([0-9a-f-]{36})\/decision$/i);
  if (request.method === "POST" && decision) {
    const response = await upstream(`requests/${decision[1]}/decision`, { method: "POST", body: await request.text() });
    return new NextResponse(await response.text(), { status: response.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }
  const legacyGet = endpoint.match(/^request\/([0-9a-f-]{36})$/i);
  if (request.method === "GET" && legacyGet) {
    const response = await upstream(`requests/${legacyGet[1]}`);
    if (!response.ok) return new NextResponse(await response.text(), { status: response.status });
    return json(asRun(await response.json()));
  }
  if (/^(godmode\/events|godmode\/events\/history|kanban|dashboard\/metrics|integrations\/|suppliers\/)/.test(endpoint) || endpoint === "health")
    return json({ detail: `A API Nest atual não oferece a rota ${endpoint}.` }, 501);
  if (/^request\/[0-9a-f-]{36}\/retry$/i.test(endpoint)) return json({ detail: "A API Nest atual não oferece retomada de pesquisa para solicitações existentes." }, 501);
  return json({ detail: "Rota não encontrada." }, 404);
}
export const GET = proxy;
export const POST = proxy;
