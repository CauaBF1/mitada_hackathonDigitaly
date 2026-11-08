import assert from 'node:assert/strict';
import { buildJevRecommendationPayload, createRecommendationSummary } from '../dist/purchase-recommendation.js';

const request = { product: 'SSD NVMe 1 TB', specs: { interface: 'PCIe 4.0', destination: 'private data must be omitted' }, qty: 2, destination: '01001-000' };
const direct = (id, unit, shipping = null, fees = null, more = {}) => ({
  id, supplier: 'Contato Maria', event_id: `telegram:${id}`, supplier_chat_id: 'private-chat-id',
  unit_cents: unit, shipping_cents: shipping, fees_cents: fees, lead_days: null,
  available_qty: null, conditions: 'SSD NVMe 1 TB por R$ 1.20 cada. Email pessoa@example.com CEP 01001-000 telefone 11912345678',
  product_confirmed: true, destination_confirmed: true, source_url: null, eligible: false,
  tco_cents: null, valid_until: null, is_completed_supplier: true, ...more,
});
const market = (id, unit, more = {}) => ({
  id, supplier: 'Loja Exemplo', event_id: `market:${id}`, supplier_chat_id: null,
  unit_cents: unit, shipping_cents: null, fees_cents: null, lead_days: null,
  available_qty: null, conditions: 'SSD NVMe 1 TB | https://shop.test/ssd?email=x@example.com | evidência abcdef0123456789',
  product_confirmed: false, destination_confirmed: false, source_url: 'https://shop.test/ssd?token=secret',
  eligible: false, tco_cents: null, valid_until: null, listing_product_name: 'SSD NVMe 1 TB', ...more,
});
const answers = (offers, probabilities = {}) => Object.fromEntries(offers.flatMap((offer) => [
  [`same_product_${offer.id}`, { noul: probabilities[offer.id]?.equivalent ?? 0.98 }],
  [`trustworthy_evidence_${offer.id}`, { noul: probabilities[offer.id]?.evidence ?? 0.9 }],
]));
const calculate = (supplierUnit, marketUnit, options = {}) => {
  const offers = [direct('supplier-1', supplierUnit, options.shipping ?? null, options.fees ?? null), market('market-1', marketUnit)];
  return createRecommendationSummary('request-1', 7, 0.8, offers, answers(offers), '', 'supplier-1', 2);
};

let result = calculate(6000, 5000);
assert.equal(result.recommendation, 'supplier', 'R$120 subtotal adjusted to R$96 beats R$100');
assert.equal(result.comparison_basis, 'product_subtotal');
assert.equal(result.comparison_supplier_cents, 12000);
assert.equal(result.comparator_market_cents, 10000);
assert.equal(result.adjusted_supplier_tco_cents, 9600);
assert.equal(result.actual_supplier_tco_cents, null, 'unknown freight and fees stay null');
assert.ok(result.pending_checks.includes('shipping'));

result = calculate(6500, 5000);
assert.equal(result.recommendation, 'market', 'R$130 subtotal adjusted to R$104 loses to R$100');
assert.equal(result.selected_offer_id, 'market-1');
result = calculate(6250, 5000);
assert.equal(result.recommendation, 'supplier', 'exact 0.8 threshold is inclusive');
result = calculate(6251, 5000);
assert.equal(result.recommendation, 'market', 'one cent above the inclusive threshold selects market');

const completeOffers = [
  direct('supplier-complete', 6000, 1000, 100, { tco_cents: 13100 }),
  market('market-complete', 5000, { shipping_cents: 1000, fees_cents: 100, tco_cents: 11100 }),
];
result = createRecommendationSummary('request-complete', 4, 0.8, completeOffers, answers(completeOffers), '', 'supplier-complete', 2);
assert.equal(result.comparison_basis, 'complete_tco');
assert.equal(result.comparison_supplier_cents, 13100);
assert.equal(result.comparator_market_cents, 11100);
assert.equal(result.recommendation, 'supplier', 'complete TCO values use the same full-cost basis');

const uncertainOffers = [direct('supplier-2', 6250), market('market-2', 5000)];
result = createRecommendationSummary('request-2', 3, 0.8, uncertainOffers,
  answers(uncertainOffers, { 'supplier-2': { evidence: 0.69 }, 'market-2': { evidence: 0.69 } }), '', 'supplier-2', 2);
assert.equal(result.recommendation, 'review', 'probabilities below 0.7 do not select either offer');

const expiredOffers = [direct('supplier-3', 5000, null, null, { valid_until: '2000-01-01' }), market('market-3', 5000)];
result = createRecommendationSummary('request-3', 1, 0.8, expiredOffers, answers(expiredOffers), '', 'supplier-3', 2);
assert.equal(result.candidates[0].expired, true);
assert.notEqual(result.selected_offer_id, 'supplier-3');

const payload = buildJevRecommendationPayload(request, [direct('synthetic-supplier', 6000), market('synthetic-market', 5000)]);
const serialized = JSON.stringify(payload);
assert.equal(payload.model, 'jev-1.14.0');
assert.ok(!serialized.includes('01001-000'), 'destination postal code is not sent');
assert.ok(!serialized.includes('private-chat-id'), 'supplier chat identifiers are not sent');
assert.ok(!serialized.includes('Contato Maria'), 'supplier contact names are not sent');
assert.ok(!serialized.includes('pessoa@example.com'), 'email evidence is redacted');
assert.ok(!serialized.includes('11912345678'), 'phone evidence is redacted');
assert.ok(!serialized.includes('token=secret'), 'URL query parameters are not sent');
assert.ok(serialized.includes('captured_offer_excerpt'), 'captured offer evidence is available to Jev');
console.log('PASS purchase recommendation rules: shared subtotal, 0.8 threshold, exact cents, uncertain evidence, expiration, missing-cost nulls, and Jev payload privacy.');
