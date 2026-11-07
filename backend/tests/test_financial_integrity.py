from decimal import Decimal

import pytest
from pydantic import ValidationError

from app import agent
from app.commercial import AdditionalCost, total_cost, validate_destination
from test_telegram_agent import parsed_offer


def quotation(text, **updates):
    history = [{'id': 1, 'sender': 'SUPPLIER', 'text': text}]
    parsed = parsed_offer(history, **updates)
    return agent.grounded_offer(parsed, history)


@pytest.mark.parametrize('unit,qty,freight,fees,expected', [
    ('0.10', 3, '0', [], '0.30'), ('80', 100, '40', [('Seguro', '10')], '8050.00'),
    ('99.99', 7, '19.91', [('Embalagem', '5'), ('Seguro', '3.17')], '728.01'),
    ('0', 1, '0', [], '0.00'), ('9999999999.99', 1000000, '0', [], '9999999999990000.00'),
])
def test_independent_tco_arithmetic(unit, qty, freight, fees, expected):
    costs = [AdditionalCost(description=name, amount=value) for name, value in fees]
    assert total_cost(Decimal(unit), qty, Decimal(freight), costs) == Decimal(expected)


@pytest.mark.parametrize('unit,shipping,fees', [(None, '0', []), ('80', None, []), ('80', '0', None)])
def test_unknown_is_not_zero(unit, shipping, fees):
    assert total_cost(unit, 1, shipping, fees) is None


@pytest.mark.parametrize('qty', [True, 0, -1, 1.5])
def test_invalid_quantity_never_enters_cost_calculation(qty):
    with pytest.raises(ValueError):
        total_cost('80', qty, '0', [])


@pytest.mark.parametrize('value', ['NaN', 'Infinity', '-0.01'])
def test_invalid_cost_values(value):
    with pytest.raises(ValueError):
        total_cost(value, 1, '0', [])


@pytest.mark.parametrize('text', [
    'Talvez R$ 80 cada, frete grátis, 1 unidade, 5 dias, Pix, sem taxas adicionais',
    'Se você fechar, R$ 80 cada, frete grátis, 1 unidade, 5 dias, Pix, sem taxas adicionais',
    'Confirmo R$ 80 cada, frete grátis, 1 unidade, 5 dias, Pix, sem taxas adicionais?',
    'R$ 80 cada, frete grátis, 1 unidade, 5 dias, Pix, sem taxas adicionais',
])
def test_hypothetical_or_unaccepted_quotes_cannot_close(text):
    assert not agent.can_accept({'quantity': 1, 'target': '85'}, quotation(text))


def test_cross_field_numeric_hallucination_is_rejected():
    text = 'Confirmo R$ 80 cada, frete R$ 30, 5 unidades, 5 dias úteis, Pix, sem taxas adicionais'
    offer = quotation(text, price='5', shipping='30', qty=5)
    assert offer.price is None
    assert not agent.can_accept({'quantity': 1, 'target': '85'}, offer)


def test_missing_fees_destination_and_nonfree_shipping_block_finalization():
    text = 'Confirmo R$ 80 cada, frete grátis, 1 unidade, 5 dias úteis, Pix'
    offer = quotation(text)
    assert offer.additional_costs is None
    assert not agent.can_accept({'quantity': 1, 'target': '85'}, offer)
    offer = quotation(text + ', sem taxas adicionais, CEP 01001-000')
    assert agent.can_accept({'quantity': 1, 'target': '85', 'delivery_location': '01001-000'}, offer)
    assert not agent.can_accept({'quantity': 1, 'target': '85', 'delivery_location': '20000-000'}, offer)
    assert quotation(text.replace('frete grátis', 'não tem frete grátis')).shipping_fee is None


def test_multiple_fees_require_individual_evidence_and_are_counted_once():
    text = 'Confirmo R$ 80 cada, frete R$ 5, 2 unidades, 5 dias úteis, Pix, Seguro R$ 10, Embalagem R$ 4, CEP 01001-000'
    history = [{'id': 1, 'sender': 'SUPPLIER', 'text': text}]
    offer = parsed_offer(history, shipping='5', qty=2)
    offer.additional_costs = [AdditionalCost(description='Seguro', amount='10'), AdditionalCost(description='Embalagem', amount='4')]
    result = agent.grounded_offer(offer, history)
    assert agent.offer_total(result, 2) == Decimal('179')
    offer.additional_costs.pop()
    assert agent.grounded_offer(offer, history).additional_costs is None
    offer.additional_costs = []
    assert agent.grounded_offer(offer, history).additional_costs is None


def test_buyer_acceptance_and_old_supplier_acceptance_are_not_current_agreement():
    text = 'Confirmo R$ 80 cada, frete grátis, 1 unidade, 5 dias úteis, Pix, sem taxas adicionais'
    history = [{'id': 1, 'sender': 'SUPPLIER', 'text': text}]
    parsed = parsed_offer(history)
    history += [{'id': 2, 'sender': 'SUPPLIER', 'text': 'Não confirmo; preciso revisar o valor.'}]
    assert not agent.grounded_offer(parsed, history).agreement_confirmed
    history[0]['sender'] = 'AI'
    assert not agent.grounded_offer(parsed, history).agreement_confirmed


@pytest.mark.parametrize('destination', ['abc', 'CEP 123', '1234-5678', '00000-000', '123456789', '01001-000 e 20000-000'])
def test_invalid_destination_is_rejected(destination):
    with pytest.raises((ValueError, ValidationError)):
        agent.NewPurchase(item='Capacete industrial', qty=100, delivery_location=destination)


def test_original_specs_and_valid_cep_are_preserved():
    text = 'Capacete industrial com certificado CA, classe B, branco'
    row = agent.NewPurchase(item=text, qty=100, delivery_location='CEP 01001-000, São Paulo')
    assert row.item == text and row.qty == 100 and row.delivery_location == 'CEP 01001-000, São Paulo'
    assert validate_destination(None) is None


def test_negative_unit_savings_are_never_positive():
    text = 'Confirmo R$ 80 cada, frete grátis, 1 unidade, 5 dias úteis, Pix, sem taxas adicionais'
    offer = quotation(text)
    audit = agent.calculate_audit({'quantity': 1, 'target': '85', 'average': '70'}, {'initial_price': '60'}, offer, [{'id': 1, 'sender': 'SUPPLIER', 'text': text}])
    assert audit.hard_savings == Decimal('-20') and audit.cost_avoidance == Decimal('-10')
    assert audit.savings_status == 'negotiated'


def test_old_lower_price_cannot_be_mixed_into_latest_acceptance():
    old = 'R$ 80 cada, frete grátis, 1 unidade, 5 dias, Pix, sem taxas adicionais'
    new = 'Confirmo R$ 100 cada, frete grátis, 1 unidade, 5 dias, Pix, sem taxas adicionais'
    history = [{'id': 1, 'sender': 'SUPPLIER', 'text': old}, {'id': 2, 'sender': 'SUPPLIER', 'text': new}]
    offer = parsed_offer(history)
    offer.evidence.append(agent.TermEvidence(field='price', message_id=1, quote=old))
    result = agent.grounded_offer(offer, history)
    assert result.price is None
    assert not agent.can_accept({'quantity': 1, 'target': '85'}, result)


def test_two_different_fees_with_same_value_cannot_collapse_to_one():
    text = 'Confirmo R$ 80 cada, frete grátis, 1 unidade, 5 dias, Pix, Seguro R$ 10, Embalagem R$ 10'
    history = [{'id': 1, 'sender': 'SUPPLIER', 'text': text}]
    offer = parsed_offer(history)
    offer.additional_costs = [AdditionalCost(description='Seguro', amount='10')]
    assert agent.grounded_offer(offer, history).additional_costs is None


def test_ambiguous_total_for_multiple_units_requires_unit_price():
    text = 'Confirmo R$ 80, frete grátis, 100 unidades, 5 dias, Pix, sem taxas adicionais'
    assert quotation(text, qty=100).price is None


@pytest.mark.parametrize('text,expected', [('1.200', '1200'), ('1.200,50', '1200.50'), ('80.50', '80.50'), ('80,50', '80.50')])
def test_brazilian_currency_precision(text, expected):
    from app.commercial import amount
    assert amount(text) == Decimal(expected)


def test_short_llm_evidence_is_checked_in_original_sentence_context():
    text = 'Confirmo R$ 80 cada, frete R$ 40, 100 unidades, 5 dias úteis, Pix, Seguro R$ 10, CEP 01001-000'
    history = [{'id': 1, 'sender': 'SUPPLIER', 'text': text}]
    offer = parsed_offer(history, shipping='40', qty=100)
    offer.additional_costs = [AdditionalCost(description='Seguro', amount='10')]
    for term in offer.evidence:
        if term.field == 'price': term.quote = 'R$ 80'
        elif term.field == 'acceptance': term.quote = 'Confirmo'
        elif term.field == 'additional_costs': term.quote = 'Seguro R$ 10'
    grounded = agent.grounded_offer(offer, history)
    assert grounded.price == Decimal('80')
    assert agent.can_accept({'quantity': 100, 'target': '8500', 'delivery_location': '01001-000'}, grounded)
    history[0]['text'] += ', Embalagem R$ 10'
    assert agent.grounded_offer(offer, history).additional_costs is None


def test_truncated_evidence_cannot_hide_hypothesis_or_negation():
    text = 'Não confirmo R$ 80 cada; não tem frete grátis, 1 unidade, 5 dias, Pix, sem taxas adicionais'
    history = [{'id': 1, 'sender': 'SUPPLIER', 'text': text}]
    offer = parsed_offer(history)
    for term in offer.evidence:
        if term.field == 'shipping_fee': term.quote = 'frete grátis'
        elif term.field == 'price': term.quote = 'R$ 80'
    result = agent.grounded_offer(offer, history)
    assert result.price is None and result.shipping_fee is None and not result.agreement_confirmed


def test_colloquial_supplier_reply_preserves_price_stock_and_zero_fees():
    text = '470 reais é o preço, tem 5 em estoque, o frete é gratis e o prazo é para amanhã e não tem taxa'
    history = [{'id': 1, 'sender': 'SUPPLIER', 'text': text}]
    offer = parsed_offer(history, price='470', shipping='0', qty=5)
    offer.agreement_confirmed = False
    result = agent.grounded_offer(offer, history, quantity=1)
    assert result.price == Decimal('470') and result.available_qty == 5
    assert result.shipping_fee == 0 and result.additional_costs == []
    assert result.delivery_days is None
    assert not agent.can_accept({'quantity': 1, 'target': '500'}, result)
