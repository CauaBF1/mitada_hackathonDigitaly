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
  const offers = [direct('supplier-1', supplierUnit, 0, 0, { lead_days: 2, available_qty: 10, tco_cents: supplierUnit * 2, ...options }), market('market-1', marketUnit, { shipping_cents: 0, fees_cents: 0, lead_days: 2, available_qty: 10, tco_cents: marketUnit * 2 })];
  return createRecommendationSummary('request-1', 7, 5, offers, answers(offers), '', 'supplier-1', 2);
};

let result = calculate(5250, 5000);
assert.equal(result.recommendation, 'supplier', 'confirmed supplier at exactly 5% premium qualifies');
assert.equal(result.comparison_basis, 'complete_tco');
assert.equal(result.comparison_supplier_cents, 10500);
assert.equal(result.comparator_market_cents, 10000);
assert.equal(result.premium_limit_cents, 10500);
assert.equal(result.supplier_premium_allowed, true);

result = calculate(5350, 5000);
assert.equal(result.recommendation, 'market', 'supplier above the configured premium loses');
assert.equal(result.selected_offer_id, 'market-1');
result = calculate(5200, 5000, { lead_days: 4 });
assert.equal(result.recommendation, 'market', 'slower supplier gets no premium');
assert.equal(result.supplier_premium_allowed, false);

const partialOffers = [direct('supplier-partial', 5250), market('market-partial', 5000)];
result = createRecommendationSummary('request-partial', 4, 5, partialOffers, answers(partialOffers), '', 'supplier-partial', 2);
assert.equal(result.comparison_basis, 'product_subtotal');
assert.equal(result.comparison_provisional, true);
assert.equal(result.recommendation, 'market', 'unknown freight prevents the premium');
assert.equal(result.candidates[0].shipping_cents, null, 'unknown freight remains null');

const solo = [direct('supplier-solo', 26500, 0, 0, { lead_days: 2, available_qty: 10, tco_cents: 26500 })];
result = createRecommendationSummary('request-solo', 4, 5, solo, answers(solo, { 'supplier-solo': { equivalent: 0.56, evidence: 0.33 } }), '', 'supplier-solo', 1);
assert.equal(result.recommendation, 'supplier', 'the canonical completed quote remains recommendable with low Jev probabilities');
assert.equal(result.selected_offer_id, 'supplier-solo');
assert.match(result.verdict, /não há oferta de mercado comparável validada/);

const uncertainOffers = [direct('supplier-2', 6250), market('market-2', 5000)];
result = createRecommendationSummary('request-2', 3, 5, uncertainOffers,
  answers(uncertainOffers, { 'supplier-2': { evidence: 0.69 }, 'market-2': { evidence: 0.69 } }), '', 'supplier-2', 2);
assert.equal(result.recommendation, 'review', 'unconfirmed quotes below the 0.7 confidence gates do not select either offer');

const expiredOffers = [direct('supplier-3', 5000, 0, 0, { lead_days: 1, available_qty: 10, tco_cents: 10000, valid_until: '2000-01-01' }), market('market-3', 5000)];
result = createRecommendationSummary('request-3', 1, 5, expiredOffers, answers(expiredOffers), '', 'supplier-3', 2);
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
console.log('PASS purchase recommendation rules: 5% confirmed-supplier premium, lead-time restriction, provisional subtotals, low-confidence canonical supplier, uncertainty, expiration, and payload privacy.');
