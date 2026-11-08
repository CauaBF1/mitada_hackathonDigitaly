import { NextRequest, NextResponse } from "next/server";
import { frontendStatus, mapReputationIndications, reputationMatchesOrigin } from "../status";

export const dynamic = "force-dynamic";
const base = () => (process.env.API_URL || "http://127.0.0.1:4000").replace(/\/$/, "");
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function upstream(path: string, init: RequestInit = {}) {
  const timeout = path.endsWith("/reputation-refresh") ? 40000 : 12000;
  return fetch(`${base()}/${path.replace(/^\//, "")}`, { ...init, cache: "no-store", signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout), headers: { "Content-Type": "application/json", ...init.headers } });
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
  const rawCompletedTerms = row.quote_terms_snapshot || analysis.quote_terms_snapshot;
  let completedTerms: any = null;
  if (row.quote_completion_state === "concluida" || analysis.quote_completion_state === "concluida") {
    try { completedTerms = typeof rawCompletedTerms === "string" ? JSON.parse(rawCompletedTerms) : rawCompletedTerms; } catch { completedTerms = null; }
  }
  const decisionQuote = row.decision ? quotes.find((quote: any) => quote.id === row.decision) : null;
  const completedQuote = completedTerms && typeof completedTerms === "object" ? {
    ...completedTerms,
    supplier: completedTerms.supplier ?? completedTerms.supplier_name,
    unit_cents: completedTerms.unit_cents ?? (completedTerms.final_price != null ? Math.round(Number(completedTerms.final_price) * 100) : null),
    shipping_cents: completedTerms.shipping_cents ?? (completedTerms.shipping_fee != null ? Math.round(Number(completedTerms.shipping_fee) * 100) : null),
    fees_cents: completedTerms.fees_cents ?? (completedTerms.fees != null ? Math.round(Number(completedTerms.fees) * 100) : null),
    lead_days: completedTerms.lead_days ?? completedTerms.delivery_days ?? null,
    available_qty: completedTerms.available_qty ?? null,
    source_url: completedTerms.source_url ?? completedTerms.product_url ?? null,
    conditions: completedTerms.conditions ?? "",
    valid_until: completedTerms.valid_until ?? null,
    payment_terms: completedTerms.payment_terms ?? null,
    product_confirmed: Boolean(completedTerms.product_confirmed),
    destination_confirmed: Boolean(completedTerms.destination_confirmed),
    tco: completedTerms.tco ?? completedTerms.final_tco ?? (completedTerms.tco_cents != null ? Number(completedTerms.tco_cents) / 100 :
      Number.isSafeInteger(Number(completedTerms.unit_cents ?? (completedTerms.final_price != null ? Math.round(Number(completedTerms.final_price) * 100) : NaN))) &&
      Number.isSafeInteger(Number(completedTerms.shipping_cents ?? (completedTerms.shipping_fee != null ? Math.round(Number(completedTerms.shipping_fee) * 100) : NaN))) &&
      Number.isSafeInteger(Number(completedTerms.fees_cents ?? (completedTerms.fees != null ? Math.round(Number(completedTerms.fees) * 100) : NaN)))
        ? (Number(completedTerms.unit_cents ?? Math.round(Number(completedTerms.final_price) * 100)) * row.qty + Number(completedTerms.shipping_cents ?? Math.round(Number(completedTerms.shipping_fee) * 100)) + Number(completedTerms.fees_cents ?? Math.round(Number(completedTerms.fees) * 100))) / 100
        : null),
    event_id: completedTerms.event_id ?? `completed:${row.id}`,
    created_at: completedTerms.completed_at ?? row.updated_at ?? row.created_at,
  } : null;
  const snapshotQuoteId = row.completed_quote_id ?? completedTerms?.quote_id ?? completedTerms?.id ?? analysis.confirmed_quote_id ?? row.confirmed_quote_id;
  const matchedCompletedQuote = snapshotQuoteId != null
    ? quotes.find((quote: any) => String(quote.id) === String(snapshotQuoteId))
    : completedTerms ? quotes.find((quote: any) => {
      const supplier = String(completedTerms.supplier ?? completedTerms.supplier_name ?? "").trim().toLocaleLowerCase("pt-BR");
      const unitCents = Number(completedTerms.unit_cents ?? (completedTerms.final_price != null ? Math.round(Number(completedTerms.final_price) * 100) : NaN));
      const shippingCents = completedTerms.shipping_cents ?? (completedTerms.shipping_fee != null ? Math.round(Number(completedTerms.shipping_fee) * 100) : null);
      return !!supplier && String(quote.supplier ?? "").trim().toLocaleLowerCase("pt-BR") === supplier && Number(quote.unit_cents) === unitCents && (shippingCents == null || Number(quote.shipping_cents) === Number(shippingCents));
    }) : null;
  const confirmedQuote = decisionQuote || matchedCompletedQuote;
  const draft = row.supplier_draft && typeof row.supplier_draft === "object" ? row.supplier_draft : null;
  const draftTerms = draft?.terms && typeof draft.terms === "object" ? draft.terms : null;
  const latestTelegramQuote = quotes.find((quote: any) => !quote.source_url && (quote.supplier_chat_id != null || /^(?:telegram|conversation|recovery):/i.test(String(quote.event_id || ""))));
  const hasDraftExtraction = Boolean(draftTerms && (["unit_cents", "shipping_cents", "fees_cents", "lead_days", "available_qty", "valid_until", "payment_terms", "conditions"].some(k => draftTerms[k] != null && draftTerms[k] !== "") || draftTerms.product_confirmed === true || draftTerms.destination_confirmed === true));
  const partialSupplierQuote = !confirmedQuote && !completedQuote && (latestTelegramQuote || hasDraftExtraction) ? (() => {
    const unitCents = draftTerms?.unit_cents ?? latestTelegramQuote?.unit_cents ?? null;
    const shippingCents = draftTerms?.shipping_cents ?? latestTelegramQuote?.shipping_cents ?? null;
    const feesCents = draftTerms?.fees_cents ?? latestTelegramQuote?.fees_cents ?? null;
    const completeTco = unitCents != null && shippingCents != null && feesCents != null && Number.isSafeInteger(Number(unitCents) * row.qty + Number(shippingCents) + Number(feesCents))
      ? (Number(unitCents) * row.qty + Number(shippingCents) + Number(feesCents)) / 100
      : null;
    return {
      id: latestTelegramQuote?.id ?? null,
      event_id: latestTelegramQuote?.event_id ?? `draft:${row.id}`,
      supplier: draftTerms?.supplier ?? latestTelegramQuote?.supplier ?? "Fornecedor Telegram",
      unit_cents: unitCents,
      shipping_cents: shippingCents,
      fees_cents: feesCents,
      lead_days: draftTerms?.lead_days ?? latestTelegramQuote?.lead_days ?? null,
      available_qty: draftTerms?.available_qty ?? latestTelegramQuote?.available_qty ?? null,
      conditions: draftTerms?.conditions ?? latestTelegramQuote?.conditions ?? "",
      valid_until: draftTerms?.valid_until ?? latestTelegramQuote?.valid_until ?? null,
      payment_terms: draftTerms?.payment_terms ?? latestTelegramQuote?.payment_terms ?? null,
      product_confirmed: Boolean(draftTerms?.product_confirmed ?? latestTelegramQuote?.product_confirmed),
      destination_confirmed: Boolean(draftTerms?.destination_confirmed ?? latestTelegramQuote?.destination_confirmed),
      source_url: null,
      tco: completeTco,
      created_at: draft?.updated_at ?? latestTelegramQuote?.created_at ?? row.created_at,
    };
  })() : null;
  const chosen = confirmedQuote || completedQuote || partialSupplierQuote;
  const preferredMarketQuoteId = row.preferred_market_quote_id ? String(row.preferred_market_quote_id) : null;
  const preferredMarketSource = preferredMarketQuoteId ? sources.find((item: any) => item.quote_id === preferredMarketQuoteId) : null;
  const chosenUrl = preferredMarketSource?.product_url || chosen?.source_url || null;
  const audit = confirmedQuote ? {
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
  } : completedQuote && Number.isSafeInteger(completedQuote.unit_cents) && completedQuote.unit_cents > 0 ? {
    additional_costs: null, additional_cost_total: completedQuote.fees_cents == null ? null : (Number(completedQuote.fees_cents) / 100).toFixed(2),
    source_type: "legacy_unverified", agreement_status: "confirmed_quote", savings_status: "legacy_unverified", confidence: "legacy_unverified",
    missing_information: ["Baseline de mercado e decisão humana não disponíveis."], roi_basis: "tco_v1", deal_closed: false,
    final_unit_price: (Number(completedQuote.unit_cents) / 100).toFixed(2),
    final_shipping_fee: completedQuote.shipping_cents == null ? null : (Number(completedQuote.shipping_cents) / 100).toFixed(2),
    final_total_cost: completedQuote.tco == null ? null : Number(completedQuote.tco).toFixed(2),
    audit_justification: "Termos finais registrados no snapshot da cotação concluída. Nenhuma decisão de compra foi registrada.",
    shipping_savings: null, tco_savings: null, tco_cost_avoidance: null,
    final_price: (Number(completedQuote.unit_cents) / 100).toFixed(2), shipping_fee: completedQuote.shipping_cents == null ? null : (Number(completedQuote.shipping_cents) / 100).toFixed(2),
    delivery_days: completedQuote.lead_days, delivery_day_type: "unspecified", quantity: row.qty,
    product_subtotal: (Number(completedQuote.unit_cents * row.qty) / 100).toFixed(2), initial_tco: null,
    final_tco: completedQuote.tco == null ? null : Number(completedQuote.tco).toFixed(2), market_tco: null, hard_savings: null, cost_avoidance: null,
    justification: "Registro factual dos termos finais recebidos; sem decisão de compra ou baseline para calcular economia.",
    limitations: ["Decisão de compra não registrada.", "Economias permanecem indisponíveis sem baseline."], evidence_message_ids: [], audited_at: completedQuote.created_at,
  } : null;
  const researchDomainSet = new Set<string>(quotes.filter((quote: any) => typeof quote.event_id === "string" && /^[^:]+:[a-f0-9]{64}$/i.test(quote.event_id) && typeof quote.source_url === "string").map((quote: any) => {
    try { return new URL(quote.source_url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
  }).filter(Boolean));
  const rawReputations = analysis.reputations;
  const reputations = Array.isArray(rawReputations) ? rawReputations.filter((item: any) => item && typeof item.supplier_domain === "string" && typeof item.reason === "string").map((item: any) => ({
    supplier_domain: item.supplier_domain, company_name: typeof item.company_name === "string" ? item.company_name : null,
    url: typeof item.url === "string" ? item.url : null, score: item.verified === true && (typeof item.score === "number" || (typeof item.score === "string" && /^\d+(?:\.\d+)?$/.test(item.score))) ? Number(item.score).toFixed(2) : null,
    label: typeof item.label === "string" ? item.label : "Não verificada", period: typeof item.period === "string" ? item.period : null,
    checked_at: typeof item.checked_at === "string" ? item.checked_at : "", verified: item.verified === true && item.score != null && Number.isFinite(Number(item.score)),
    approved: item.verified === true && item.approved === true && item.score != null && Number.isFinite(Number(item.score)), reason: item.reason,
    evidence_sha256: typeof item.evidence_sha256 === "string" ? item.evidence_sha256 : null,
  })).filter((item: any) => [...researchDomainSet].some((origin: string) => reputationMatchesOrigin(item.supplier_domain, origin, true))) : [];
  const reputation_indications = mapReputationIndications(analysis.reputation_indications);
  const status = frontendStatus(row.status, quotes.length);
  const marketAverage = sources.length ? (sources.reduce((sum: number, item: any) => sum + Number(item.price), 0) / sources.length).toFixed(2) : null;
  return {
    id: String(row.id), version: row.version, item: row.product, qty: row.qty, requested_target: null, target_price: null,
    market_average: marketAverage, status, stage: row.status, sources, reputations, reputation_indications, purchase_simulation: row.purchase_simulation || null,
    quote_completion_state: row.quote_completion_state || "coletando",
    missing_fields: Array.isArray(draft?.missing_fields) ? draft.missing_fields : [],
    preferred_market_quote_id: preferredMarketQuoteId,
    preferred_market_at: row.preferred_market_at || null,
    selected_product_url: chosenUrl,
    quote: chosen ? {
      additional_costs: null, initial_additional_costs: null, supplier_domain: (() => { try { return new URL(chosen.source_url).hostname.replace(/^www\./, ""); } catch { return null; } })(),
      supplier_name: chosen.supplier, product_name: String(chosen.conditions || "").split(" | ")[0] || row.product,
      quantity: row.qty, delivery_location: row.destination, initial_message_id: null, initial_offer_evidence: [], source_type: chosen.source_url ? "legacy_unverified" : "supplier_telegram",
      id: chosen.id != null ? String(chosen.id) : snapshotQuoteId != null ? String(snapshotQuoteId) : null, agreement_status: confirmedQuote || completedQuote ? "confirmed_quote" : "legacy_unverified", request_id: String(row.id), event_id: chosen.event_id || `quote:${chosen.id}`,
      product_url: chosen.source_url || "",
      initial_price: chosen.unit_cents == null ? null : (Number(chosen.unit_cents) / 100).toFixed(2),
      final_price: chosen.unit_cents == null ? null : (Number(chosen.unit_cents) / 100).toFixed(2),
      shipping_fee: chosen.shipping_cents == null ? null : (Number(chosen.shipping_cents) / 100).toFixed(2),
      fees_fee: chosen.fees_cents == null ? null : (Number(chosen.fees_cents) / 100).toFixed(2),
      initial_shipping_fee: null,
      initial_tco: chosen.tco == null ? null : Number(chosen.tco).toFixed(2), final_tco: chosen.tco == null ? null : Number(chosen.tco).toFixed(2),
      delivery_days: chosen.lead_days ?? null, delivery_day_type: "unspecified", available_qty: chosen.available_qty ?? null,
      delivery_time: chosen.lead_days == null ? "Não confirmado" : `${chosen.lead_days} dias`, conditions: chosen.conditions || "",
      valid_until: chosen.valid_until || null, payment_terms: chosen.payment_terms || null,
      product_confirmed: Boolean(chosen.product_confirmed), destination_confirmed: Boolean(chosen.destination_confirmed),
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
  const hostHeader = request.headers.get("host");
  let requestHostname = request.nextUrl.hostname;
  if (hostHeader) {
    try { requestHostname = new URL(`http://${hostHeader}`).hostname; } catch { return json({ detail: "Acesso permitido somente pelo endereço local." }, 403); }
  }
  if (!["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(requestHostname)) return json({ detail: "Acesso permitido somente pelo endereço local." }, 403);
  const origin = request.headers.get("origin");
  if (origin) { try { if (new URL(origin).host !== request.headers.get("host")) return json({ detail: "Origem inválida." }, 403); } catch { return json({ detail: "Origem inválida." }, 403); } }
  const endpoint = (await context.params).path.join("/");
  if (request.method === "GET" && endpoint === "auth/config") {
    try {
      const response = await upstream("auth/config");
      if (response.ok) {
        const cfg: any = await response.json();
        return json({
          google_client_id: cfg?.google_client_id || process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || null,
          has_client_secret: Boolean(cfg?.has_client_secret),
        });
      }
    } catch {}
    return json({ google_client_id: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || null, has_client_secret: false });
  }
  if (request.method === "POST" && endpoint === "auth/config") {
    const response = await upstream("auth/config", { method: "POST", body: await request.text() });
    const payload: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = typeof payload?.detail === "string" ? payload.detail : typeof payload?.message === "string" ? payload.message : "Falha ao salvar configuração Google OAuth.";
      return json({ detail: msg, message: msg }, response.status);
    }
    return json(payload, 200);
  }
  if (request.method === "POST" && endpoint === "auth/logout") {
    const res = json({ ok: true });
    res.cookies.set("nexo_session", "", { httpOnly: true, path: "/", sameSite: "lax", maxAge: 0 });
    return res;
  }
  if (request.method === "POST" && (endpoint === "auth/register" || endpoint === "auth/login" || endpoint === "auth/google")) {
    const response = await upstream(endpoint, { method: "POST", body: await request.text() });
    const payload: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = typeof payload?.detail === "string" ? payload.detail : typeof payload?.message === "string" ? payload.message : Array.isArray(payload?.message) ? payload.message.join(", ") : "Falha na autenticação.";
      return json({ detail: msg, message: msg }, response.status);
    }
    const res = json(payload, response.status);
    if (typeof payload?.token === "string") {
      res.cookies.set("nexo_session", payload.token, { httpOnly: true, path: "/", sameSite: "lax", maxAge: 60 * 60 * 24 * 7 });
    }
    return res;
  }
  if (request.method === "GET" && endpoint === "auth/me") {
    const headerAuth = request.headers.get("authorization");
    const cookieToken = request.cookies.get("nexo_session")?.value;
    const authHeader = headerAuth || (cookieToken ? `Bearer ${cookieToken}` : "");
    if (!authHeader) return json({ detail: "Não autenticado." }, 401);
    const response = await upstream("auth/me", { headers: { Authorization: authHeader } });
    const payload: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = typeof payload?.detail === "string" ? payload.detail : typeof payload?.message === "string" ? payload.message : "Sessão inválida.";
      return json({ detail: msg, message: msg }, response.status);
    }
    return json(payload, 200);
  }
  if (request.method === "GET" && endpoint === "godmode/dashboard") return dashboard();

  if (request.method === "GET" && /^history(?:\/[0-9a-f-]{36})?$/i.test(endpoint)) {
    try {
      const response = await upstream(`${endpoint}${request.nextUrl.search}`);
      if (response.status === 404) return json({ detail: "Solicitação não encontrada." }, 404);
      return new NextResponse(await response.text(), { status: response.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    } catch { return json({ detail: "Histórico temporariamente indisponível. Tente novamente." }, 503); }
  }

  const chat = endpoint.match(/^chat\/([0-9a-f-]{36})$/i);
  if (request.method === "GET" && chat) {
    const response = await upstream(`requests/${chat[1]}/messages${request.nextUrl.search}`);
    if (!response.ok) return new NextResponse(await response.text(), { status: response.status });
    const rows: any = await response.json();
    if (!Array.isArray(rows)) return json({ detail: "Histórico de mensagens incompatível." }, 502);
    return json(rows.map((message: any) => ({ id: String(message.id), request_id: chat[1], supplier_domain: message.supplier_domain || "", sender_type: message.sender_type, text: message.content, timestamp: message.created_at, channel: message.channel || "telegram", delivery_status: message.delivery_status || "" })));
  }
  if (request.method === "POST" && chat) {
    const response = await upstream(`requests/${chat[1]}/contact-supplier`, { method: "POST", body: await request.text() });
    return new NextResponse(await response.text(), { status: response.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }
  if (request.method === "POST" && endpoint === "request") {
    let input: any;
    try { input = await request.json(); } catch { return json({ detail: "Corpo JSON inválido." }, 400); }
    const response = await upstream("requests", { method: "POST", headers: request.headers.get("Idempotency-Key") ? { "Idempotency-Key": request.headers.get("Idempotency-Key")! } : {}, body: JSON.stringify({ product: input.item, specs: {}, qty: input.qty, destination: input.delivery_location }) });
    if (!response.ok) return new NextResponse(await response.text(), { status: response.status });
    return json(asRun(await response.json()), response.status);
  }
  const mutation = endpoint.match(/^requests?\/([0-9a-f-]{36})(\/repeat)?$/i);
  if (mutation && ((request.method === "DELETE" && !mutation[2]) || (request.method === "POST" && mutation[2]))) {
    let body: unknown = {};
    if (request.method === "POST") {
      try { const text = await request.text(); body = text.trim() ? JSON.parse(text) : {}; }
      catch { return json({ detail: "Corpo JSON inválido." }, 400); }
    }
    try {
      const response = await upstream(`requests/${mutation[1]}${mutation[2] || ""}`, {
        method: request.method, ...(request.method === "POST" ? { body: JSON.stringify(body) } : {}),
      });
      const result = await response.json();
      if (!response.ok) return json({ detail: typeof result.message === "string" ? result.message : "Não foi possível concluir a ação." }, response.status);
      return json(request.method === "POST" ? asRun(result) : result, response.status);
    } catch { return json({ detail: "Serviço de solicitações indisponível. Tente novamente." }, 503); }
  }
  const decision = endpoint.match(/^request\/([0-9a-f-]{36})\/decision$/i);
  if (request.method === "POST" && decision) {
    const response = await upstream(`requests/${decision[1]}/decision`, { method: "POST", headers: request.headers.get("Idempotency-Key") ? { "Idempotency-Key": request.headers.get("Idempotency-Key")! } : {}, body: await request.text() });
    return new NextResponse(await response.text(), { status: response.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }
  const marketPreference = endpoint.match(/^request\/([0-9a-f-]{36})\/market-preference$/i);
  if (request.method === "POST" && marketPreference) {
    const response = await upstream(`requests/${marketPreference[1]}/market-preference`, { method: "POST", body: await request.text() });
    if (!response.ok) {
      const err: any = await response.json().catch(() => null);
      return json({ detail: err?.message || err?.detail || "Não foi possível registrar a preferência." }, response.status);
    }
    return json(asRun(await response.json()), response.status);
  }
  const reputationRefresh = endpoint.match(/^request\/([0-9a-f-]{36})\/reputation-refresh$/i);
  if (request.method === "POST" && reputationRefresh) {
    const response = await upstream(`requests/${reputationRefresh[1]}/reputation-refresh`, { method: "POST", body: await request.text() });
    return new NextResponse(await response.text(), { status: response.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }
  const simulation = endpoint.match(/^request\/([0-9a-f-]{36})\/purchase-simulation(?:\/(cancel))?$/i);
  if (simulation && request.method === "GET") {
    const response = await upstream(`requests/${simulation[1]}/purchase-simulation`);
    return new NextResponse(await response.text(), { status: response.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }
  if (simulation && simulation[2] === "cancel" && request.method === "POST") {
    const response = await upstream(`requests/${simulation[1]}/purchase-simulation/cancel`, { method: "POST", body: await request.text() });
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
export const DELETE = proxy;
