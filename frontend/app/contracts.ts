export type Money = string;
export type Status = "TODO" | "CALLING" | "NEGOTIATING" | "DONE";
export interface AdditionalCost { description: string; amount: Money }
export interface Product { quote_id?: string; eligible?: boolean; additional_costs: AdditionalCost[] | null; gtin: string | null; supplier_name: string; supplier_domain: string; supplier_website: string; product_name: string; product_url: string; price: Money; shipping_fee: Money | null; shipping_scope: string | null; currency: "BRL"; availability: string; price_basis: string; observed_at: string; extraction_method: string; evidence_sha256: string }
export interface Candidate { url: string; title: string; description: string; kind: "product" | "category" | "unknown"; price: Money | null; product_name: string | null; error: string | null }
export interface Reputation { supplier_domain: string; company_name: string | null; url: string | null; score: Money | null; label: string; period: string | null; checked_at: string; verified: boolean; approved: boolean; reason: string; evidence_sha256: string | null }
export interface ReputationIndication { supplier_domain?: string | null; company_name?: string | null; title?: string | null; url: string | null; excerpt: string; observed_at: string | null }
export type PurchaseSimulationStatus = "awaiting_supplier" | "review_required" | "confirmed" | "rejected" | "cancelled";
export interface PurchaseSimulation { id: string; status: PurchaseSimulationStatus; quote_id: string; created_at?: string; updated_at?: string; [key: string]: unknown }
export interface Quote { id: string | null; additional_costs: AdditionalCost[] | null; initial_additional_costs: AdditionalCost[] | null; supplier_domain: string | null; supplier_name: string | null; product_name: string | null; quantity: number | null; delivery_location: string | null; initial_message_id: number | null; initial_offer_evidence: { field: string; message_id: number; quote: string }[]; source_type: "legacy_unverified" | "supplier_telegram" | "sandbox_supplier"; agreement_status: "legacy_unverified" | "confirmed_quote"; request_id: string; event_id: string; product_url: string; initial_price: Money | null; final_price: Money | null; shipping_fee: Money | null; fees_fee?: Money | null; initial_shipping_fee: Money | null; initial_tco: Money | null; final_tco: Money | null; delivery_days: number | null; delivery_day_type: "business" | "calendar" | "unspecified"; available_qty: number | null; delivery_time: string; conditions: string; valid_until?: string | null; payment_terms?: string | null; product_confirmed?: boolean; destination_confirmed?: boolean }
export interface DiscoveryPlan { approved_suppliers: string[]; market_avg_unit_price: Money | null; baseline_tco: Money | null; target_tco: Money | null; discovery_justification: string }
export interface MemoryProfile { has_previous_history: boolean; historical_discount_avg_pct: Money | null; preferred_concession: "FRETE_GRATIS" | "DESCONTO_UNITA" | "PAGAMENTO_PIX" | null; tactical_briefing: string }
export interface TacticalSummary { tco_oferta_atual: Money | null; distancia_meta_pct: Money | null; estrategia_aplicada: "SOLICITAR_COTACAO" | "CONFIRMAR_TERMOS" | "BATNA" | "DESCONTO_VOLUME" | "FRETE_GRATIS" | "PAGAMENTO_PIX" | "DESCONTO_UNITARIO" }
export interface ComplianceAudit { additional_costs: AdditionalCost[] | null; additional_cost_total: Money | null; source_type: "legacy_unverified" | "supplier_telegram" | "sandbox_supplier"; agreement_status: "legacy_unverified" | "confirmed_quote"; savings_status: "legacy_unverified" | "negotiated" | "sandbox"; confidence: "legacy_unverified" | "evidence_validated"; missing_information: string[]; roi_basis: "tco_v1" | "unit_price"; deal_closed: boolean; final_unit_price: Money | null; final_shipping_fee: Money | null; final_total_cost: Money | null; audit_justification: string | null; shipping_savings: Money | null; tco_savings: Money | null; tco_cost_avoidance: Money | null; final_price: Money; shipping_fee: Money; delivery_days: number; delivery_day_type: "business" | "calendar" | "unspecified"; quantity: number; product_subtotal: Money; initial_tco: Money | null; final_tco: Money; market_tco: Money | null; hard_savings: Money | null; cost_avoidance: Money | null; justification: string; limitations: string[]; evidence_message_ids: number[]; audited_at: string }
export interface PurchaseRequest { discovery_justification: string | null; discovery_plan: DiscoveryPlan | null; supplier_profiles: Record<string, MemoryProfile>; tactical_summary: TacticalSummary | null; model_used: string | null; mode: "live" | "sandbox"; delivery_location: string | null; tco_base: Money | null; market_shipping: Money | null; target_basis: "complete_tco" | "product_subtotal" | "legacy_unit_price"; audit: ComplianceAudit | null; candidates: Candidate[]; comparison_item: string | null; selected_candidate_url: string | null; blocked_sites: number; id: string; version: number; item: string; qty: number; requested_target: Money | null; target_price: Money | null; market_average: Money | null; status: Status; stage: string; sources: Product[]; reputations: Reputation[]; reputation_indications: ReputationIndication[]; purchase_simulation: PurchaseSimulation | null; quote_completion_state?: string; missing_fields?: string[]; preferred_market_quote_id?: string | null; preferred_market_at?: string | null; selected_product_url: string | null; quote: Quote | null; hard_savings: Money | null; cost_avoidance: Money | null; errors: string[]; notice: string | null; created_at: string; updated_at: string; data_mode: "real" }
export interface Metrics { hard_savings: Money; cost_avoidance: Money; final_spend: Money; completed_count: number; active_count: number; verified_suppliers_count: number; pending_tco_count: number }
export interface Dashboard { metrics_available?: boolean; runs: PurchaseRequest[]; metrics: Metrics; total_runs: number; data_mode: "real" }
export interface AgentEvent { id: number; run_id: string; created_at: string; stage: string; level: string; message: string }
export interface AuthUser { id: string; name: string; email: string; google_id: string | null; avatar_url: string | null; created_at: string }
export function referenceProduct(row: PurchaseRequest): Product | undefined {
  const selected = row.sources.find(source => source.product_url === row.selected_product_url);
  const domains = row.discovery_plan?.approved_suppliers || [];
  const eligible = row.sources.filter(source => domains.includes(source.supplier_domain));
  return selected || [...(eligible.length ? eligible : row.sources)].sort((a, b) => Number(a.price) - Number(b.price))[0];
}
export const API = (process.env.NEXT_PUBLIC_API_URL || "/api").replace(/\/$/, "");
function cents(value: Money): bigint { const negative = value.startsWith("-"); const [whole, decimal = ""] = value.replace(/^-/, "").split("."); const result = BigInt(whole) * 100n + BigInt(decimal.padEnd(2, "0").slice(0, 2)); return negative ? -result : result; }
export function brl(value: Money | null | undefined): string { if (value == null) return "—"; const amount = cents(value); const absolute = amount < 0n ? -amount : amount; return `${amount < 0n ? "−" : ""}R$ ${(absolute / 100n).toLocaleString("pt-BR")},${String(absolute % 100n).padStart(2, "0")}`; }
export function safeUrl(value: string | null | undefined): string | undefined { try { const url = new URL(value || ""); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; } }
export async function requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
  const token = typeof window !== "undefined" ? window.localStorage.getItem("nexo_token") : null;
  const headers = new Headers(init.headers);
  if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
  const timeout = (path.endsWith("/reputation-refresh") || path.includes("/price-history")) ? 45000 : path.startsWith("/integrations/") || path === "/suppliers/invite" ? 30000 : 12000;
  const response = await fetch(`${API}${path}`, { ...init, headers, cache: "no-store", signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof body?.detail === "string" ? body.detail : typeof body?.message === "string" ? body.message : `Não foi possível concluir a operação (${response.status}).`);
  return body;
}

export interface PriceHistoryPoint { date: string; price: Money; supplier: string }
export interface PriceTimingReport {
  trend: "FALLING" | "STABLE" | "RISING";
  verdict: "BUY_NOW" | "WAIT" | "MONITOR";
  savings_vs_historical_avg_pct: string;
  lowest_historical_price: Money;
  highest_historical_price: Money;
  current_price_percentile: number;
  confidence_score: number;
  timing_justification: string;
}
export interface PriceHistoryResponse {
  history: PriceHistoryPoint[];
  observed_history: PriceHistoryPoint[];
  analysis: PriceTimingReport | null;
  historical_average: Money | null;
  selected_price: Money | null;
  selected_date: string;
  price_source: "selected" | "negotiated" | "reference" | "unavailable";
  data_source: "persisted" | "simulation" | "unavailable";
  analysis_source: "llm" | "statistical_fallback" | "insufficient_data";
  days: number;
  real_observation_count: number;
  message: string;
}
