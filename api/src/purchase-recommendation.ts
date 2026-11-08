import { createHash, randomUUID } from 'node:crypto';

export const DEFAULT_SUPPLIER_MAX_PREMIUM_PERCENT = 5;
export const JEV_GATE = 0.7;

export type RecommendationRequest = {
  product: string;
  specs: unknown;
  qty: number;
  destination: string;
};

export type RecommendationOffer = {
  id: string;
  supplier: string;
  event_id: string;
  supplier_chat_id?: string | null;
  unit_cents: number;
  shipping_cents: number | null;
  fees_cents: number | null;
  lead_days: number | null;
  available_qty: number | null;
  conditions?: string | null;
  product_confirmed: number | boolean;
  destination_confirmed: number | boolean;
  source_url?: string | null;
  eligible: boolean;
  tco_cents: number | null;
  valid_until?: string | null;
  listing_product_name?: string | null;
  is_completed_supplier?: boolean;
};

const channelOf = (offer: RecommendationOffer) => offer.event_id.startsWith('whatsapp:')
  ? 'whatsapp'
  : offer.supplier_chat_id || offer.event_id.startsWith('telegram:') ? 'telegram'
  : offer.source_url ? 'market' : 'telegram';

const safeSpecs = (value: unknown): unknown => {
  if (typeof value === 'string') return value.slice(0, 300);
  if (Array.isArray(value)) return value.slice(0, 20).map(safeSpecs);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !/(?:address|postal|cep|email|phone|contact|person|name|destination|location)/i.test(key))
    .slice(0, 30).map(([key, item]) => [key.slice(0, 60), safeSpecs(item)]));
};
const safeEvidenceExcerpt = (value: unknown) => typeof value === 'string'
  ? value.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\b\d{5}-?\d{3}\b/g, '[postal code]')
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[tax id]')
    .replace(/\b(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,3}\)?[\s.-]?)?\d{4,5}[\s.-]?\d{4}\b/g, '[phone]')
    .replace(/https?:\/\/\S+/gi, '[link]')
    .slice(0, 700)
  : null;

/** Exact request sent to Jev, exported for audit and authorized live probing. */
export function buildJevRecommendationPayload(request: RecommendationRequest, offers: RecommendationOffer[]) {
  const candidates = offers.map((offer) => ({
    offer_id: offer.id,
    provenance: channelOf(offer) === 'market' ? 'market_listing' : `direct_${channelOf(offer)}_quote`,
    channel: channelOf(offer),
    source_host: offer.source_url ? (() => { try { return new URL(offer.source_url).host; } catch { return null; } })() : null,
    listing_product_name: channelOf(offer) === 'market' ? offer.listing_product_name || null : null,
    captured_offer_excerpt: safeEvidenceExcerpt(offer.conditions),
    captured_listing_evidence_reference: channelOf(offer) === 'market' && /evid[eê]ncia\s+[a-f0-9]{16,}/i.test(String(offer.conditions || '')),
    requested_product: request.product.slice(0, 300),
    requested_specifications: safeSpecs(request.specs),
    requested_quantity: request.qty,
    unit_price_cents: offer.unit_cents,
    shipping_cents: offer.shipping_cents,
    fees_cents: offer.fees_cents,
    lead_days: offer.lead_days,
    available_quantity: offer.available_qty,
    product_confirmed: !!offer.product_confirmed,
    destination_confirmed: !!offer.destination_confirmed,
    supplier_quote_status: offer.is_completed_supplier ? 'completed_and_supplier_confirmed' : 'not_completed',
    supplier_quote_confirmation: offer.is_completed_supplier ? {
      product_and_destination_confirmed: !!offer.product_confirmed && !!offer.destination_confirmed,
      structured_terms_present: offer.unit_cents !== null && offer.shipping_cents !== null && offer.fees_cents !== null && offer.lead_days !== null && offer.available_qty !== null,
      evidence_note: 'These are structured terms from the supplier quote saved after explicit supplier confirmation. No chat transcript is included.',
    } : null,
    complete_calculable_total: offer.tco_cents !== null,
    seller_confirmed_product_and_destination: !!offer.product_confirmed && !!offer.destination_confirmed,
    valid_until: offer.valid_until || null,
  }));
  const questions: Record<string, unknown> = {};
  for (const candidate of candidates) {
    const id = candidate.offer_id;
    questions[`same_product_${id}`] = {
      type: 'noul',
      instructions: `Does offer ${id} offer the same product with specifications that satisfy the requested product?`,
      criteria: {
        true: 'The market listing product name or the direct seller confirmation and captured quote facts establish the requested product and specifications.',
        false: 'The offer appears to be a different product, a material specification conflicts, or the supplied facts do not establish a match.',
      },
    };
    questions[`trustworthy_evidence_${id}`] = {
      type: 'noul',
      instructions: `Does offer ${id} include trustworthy evidence supporting the stated price and availability for this seller?`,
      criteria: {
        true: 'A concrete captured excerpt or structured quote terms, together with the channel or host and specific price and offer facts, directly support the stated offer and source.',
        false: 'The source or captured facts are missing, weak, unrelated, or do not support the stated price and source identity.',
      },
    };
  }
  return { model: process.env.TYPESAFE_MODEL || process.env.JEV_MODEL || 'jev-1.14.0', state: { request: { product: request.product.slice(0, 300), specifications: safeSpecs(request.specs), quantity: request.qty }, offers: candidates }, questions };
}

export function hashRecommendationInputs(offers: RecommendationOffer[], factor: number, context: unknown = null) {
  const sorted = [...offers].sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256').update(JSON.stringify({ factor, context, offers: sorted })).digest('hex');
}

export function createRecommendationSummary(requestId: string, version: number, maxPremiumPercent: number, offers: RecommendationOffer[], answers: Record<string, any>, explanation = '', completedQuoteId: string | null = null, quantity = 1) {
  const candidates: any[] = offers.map((offer) => {
    const equivalent = answers[`same_product_${offer.id}`]?.noul;
    const evidence = answers[`trustworthy_evidence_${offer.id}`]?.noul;
    const validProb = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
    const equivalenceProbability = validProb(equivalent) ? equivalent : null;
    const evidenceProbability = validProb(evidence) ? evidence : null;
    const productSubtotal = offer.unit_cents * quantity;
    const subtotal = Number.isSafeInteger(productSubtotal) && productSubtotal > 0 ? productSubtotal : null;
    const priceValid = subtotal !== null;
    const expired = !!offer.valid_until && Number.isFinite(Date.parse(offer.valid_until)) && Date.parse(offer.valid_until) < Date.now();
    const knownConfirmed = offer.is_completed_supplier === true && offer.product_confirmed === true && offer.destination_confirmed === true
      && offer.shipping_cents !== null && offer.fees_cents !== null && offer.lead_days !== null && offer.available_qty !== null;
    const modelComparable = equivalenceProbability !== null && equivalenceProbability >= JEV_GATE;
    const comparable = priceValid && !expired && !(offer.available_qty !== null && offer.available_qty < quantity) && (knownConfirmed || modelComparable);
    const reliable = comparable && (knownConfirmed || (evidenceProbability !== null && evidenceProbability >= JEV_GATE));
    const channel = channelOf(offer);
    const actualAmount = offer.tco_cents !== null ? offer.tco_cents : subtotal === null ? null : subtotal;
    return {
      offer_id: offer.id, supplier: offer.supplier, channel, source_url: offer.source_url || null,
      unit_cents: offer.unit_cents, shipping_cents: offer.shipping_cents, fees_cents: offer.fees_cents,
      lead_days: offer.lead_days, available_qty: offer.available_qty,
      tco_cents: offer.tco_cents, product_subtotal_cents: subtotal, eligible: offer.eligible, cost_complete: offer.tco_cents !== null,
      pending_checks: [offer.shipping_cents === null ? 'shipping' : null, offer.fees_cents === null ? 'fees' : null, offer.available_qty === null || offer.available_qty < quantity ? 'availability' : null, offer.lead_days === null ? 'lead_time' : null, !offer.product_confirmed ? 'product_confirmation' : null, !offer.destination_confirmed ? 'destination_confirmation' : null].filter(Boolean),
      equivalence_probability: equivalenceProbability, evidence_probability: evidenceProbability,
      known_confirmed: knownConfirmed, is_completed_supplier: offer.is_completed_supplier === true,
      comparable, reliable, expired, comparison_amount_cents: actualAmount,
    };
  });
  const reliableCandidates = candidates.filter((candidate) => candidate.reliable);
  const useCompleteTco = (reliableCandidates.some((candidate) => candidate.channel === 'market')
    && reliableCandidates.some((candidate) => candidate.channel !== 'market')
    && reliableCandidates.every((candidate) => candidate.tco_cents !== null))
    || (!reliableCandidates.some((candidate) => candidate.channel === 'market') && reliableCandidates.length > 0 && reliableCandidates.every((candidate) => candidate.tco_cents !== null));
  const comparisonBasis = useCompleteTco ? 'complete_tco' : 'product_subtotal';
  const basisMarkets = (rows: any[]) => rows.filter((candidate) => candidate.channel === 'market' && candidate.comparable && candidate.reliable && (comparisonBasis === 'complete_tco' ? candidate.tco_cents !== null : candidate.product_subtotal_cents !== null));
  const markets = candidates.filter((candidate) => candidate.channel === 'market' && candidate.comparable && (comparisonBasis === 'complete_tco' ? candidate.tco_cents !== null : candidate.product_subtotal_cents !== null));
  const reliableMarkets = markets.filter((candidate) => candidate.reliable);
  const amount = (candidate:any) => comparisonBasis === 'complete_tco' ? candidate.tco_cents : candidate.product_subtotal_cents;
  const suppliers = candidates.filter((candidate) => candidate.channel !== 'market' && candidate.reliable && amount(candidate) !== null);
  const displaySupplier = candidates.find((candidate) => candidate.offer_id === completedQuoteId) || null;
  const bestMarket = [...markets].sort((a, b) => amount(a)! - amount(b)!)[0] || null;
  const mostReliableMarket = [...markets].sort((a, b) => (b.evidence_probability ?? -1) - (a.evidence_probability ?? -1) || amount(a)! - amount(b)!)[0] || null;
  const comparatorMarket = [...basisMarkets(reliableMarkets)].sort((a, b) => amount(a)! - amount(b)!)[0] || null;
  const supplier = [...suppliers].sort((a, b) => amount(a)! - amount(b)!)[0] || null;
  for (const candidate of candidates) {
    candidate.comparison_amount_cents = amount(candidate);
    candidate.max_premium_cents = candidate.channel === 'market' || candidate.comparison_amount_cents === null ? null : Math.round(candidate.comparison_amount_cents * (1 + maxPremiumPercent / 100));
  }
  const supplierPremiumAllowed = !!supplier && supplier.known_confirmed && !!comparatorMarket
    && supplier.lead_days !== null && comparatorMarket.lead_days !== null && supplier.lead_days <= comparatorMarket.lead_days
    && supplier.tco_cents !== null && comparatorMarket.tco_cents !== null;
  const supplierLimit = supplier && comparatorMarket
    ? supplierPremiumAllowed ? Math.round(comparatorMarket.comparison_amount_cents! * (1 + maxPremiumPercent / 100)) : comparatorMarket.comparison_amount_cents
    : null;
  const supplierWithinLimit = comparatorMarket ? [...suppliers].sort((a, b) => amount(a)! - amount(b)!)
    .find((candidate) => amount(candidate)! <= Math.round(amount(comparatorMarket)! * (supplierPremiumAllowed ? 1 + maxPremiumPercent / 100 : 1))) || null : null;
  const confirmedSupplierWithoutMarket = !comparatorMarket && !!supplier && supplier.known_confirmed;
  const recommendation = confirmedSupplierWithoutMarket ? 'supplier' : supplierWithinLimit && comparatorMarket
    ? 'supplier'
    : comparatorMarket ? 'market' : 'review';
  const selectedOfferId = recommendation === 'supplier' ? (supplierWithinLimit || supplier)!.offer_id : recommendation === 'market' ? comparatorMarket!.offer_id : null;
  const reason = recommendation === 'supplier' ? confirmedSupplierWithoutMarket ? 'only_confirmed_supplier_quote_no_valid_market_comparator' : supplierPremiumAllowed ? 'confirmed_supplier_within_max_premium' : 'supplier_at_or_below_reliable_market'
    : recommendation === 'market' ? 'no_supplier_meets_preference_threshold_against_reliable_market'
    : 'no_reliable_comparable_market_offer';
  return {
    review_id: randomUUID(), request_id: requestId, version,
    offer_hash: hashRecommendationInputs(offers, maxPremiumPercent),
    recommendation, reason,
    supplier_max_premium_percent: maxPremiumPercent,
    premium_limit_cents: supplierLimit,
    supplier_premium_allowed: supplierPremiumAllowed,
    comparison_basis: comparisonBasis,
    comparison_supplier_cents: supplier ? amount(supplier) : null,
    supplier_offer_id: displaySupplier?.offer_id ?? supplier?.offer_id ?? null,
    actual_supplier_tco_cents: displaySupplier?.tco_cents ?? supplier?.tco_cents ?? null,
    actual_supplier_comparison_cents: displaySupplier ? amount(displaySupplier) : supplier ? amount(supplier) : null,
    adjusted_supplier_tco_cents: null,
    best_market_offer_id: bestMarket?.offer_id ?? null,
    best_market_tco_cents: bestMarket?.tco_cents ?? null,
    best_market_comparison_cents: bestMarket ? amount(bestMarket) : null,
    most_reliable_market_offer_id: mostReliableMarket?.offer_id ?? null,
    most_reliable_market_tco_cents: mostReliableMarket?.tco_cents ?? null,
    comparator_market_offer_id: comparatorMarket?.offer_id ?? null,
    comparator_market_tco_cents: comparatorMarket?.tco_cents ?? null,
    comparator_market_cents: comparatorMarket ? amount(comparatorMarket) : null,
    selected_offer_id: selectedOfferId,
    verdict: confirmedSupplierWithoutMarket ? 'Única cotação confirmada; não há oferta de mercado comparável validada.' : recommendation === 'supplier' ? 'Fornecedor dentro do limite de custo definido.' : recommendation === 'market' ? 'Oferta de mercado validada tem menor custo comparável.' : 'Ainda não há oferta comparável validada para recomendar.',
    savings_or_premium_cents: supplier && comparatorMarket ? amount(supplier)! - amount(comparatorMarket)! : null,
    savings_or_premium_percent: supplier && comparatorMarket && amount(comparatorMarket)! > 0 ? Math.round((amount(supplier)! - amount(comparatorMarket)!) / amount(comparatorMarket)! * 10000) / 100 : null,
    comparison_provisional: comparisonBasis === 'product_subtotal',
    threshold_market_tco_cents: comparatorMarket?.tco_cents ?? null,
    candidates,
    pending_checks: [...new Set([selectedOfferId, comparatorMarket?.offer_id].filter(Boolean).flatMap((id) => candidates.find((candidate) => candidate.offer_id === id)?.pending_checks || []))],
    explanation: explanation || null,
    created_at: new Date().toISOString(),
    approval: null as null | { approved: boolean; selected_offer_id: string | null; at: string },
  };
}

export function recommendationReviewToken() { return randomUUID(); }
