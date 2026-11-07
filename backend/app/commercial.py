import re
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

from pydantic import BaseModel, ConfigDict, Field


class AdditionalCost(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    description: str = Field(min_length=2, max_length=120)
    amount: Decimal = Field(ge=0, max_digits=12, decimal_places=2)


def cents(value: Decimal) -> Decimal:
    return value.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)


def total_cost(unit_price, quantity, freight, additional_costs):
    if unit_price is None or freight is None or additional_costs is None:
        return None
    if isinstance(quantity, bool) or not isinstance(quantity, int) or quantity <= 0:
        raise ValueError('Quantidade deve ser um inteiro positivo.')
    values = [Decimal(unit_price), Decimal(freight)] + [Decimal(c.amount if isinstance(c, AdditionalCost) else c['amount']) for c in additional_costs]
    if any(not value.is_finite() or value < 0 for value in values):
        raise ValueError('Custos devem ser finitos e não negativos.')
    return cents(values[0] * quantity + sum(values[1:]))


def postal_code(value):
    if value is None:
        return None
    match = re.search(r'(?<!\d)(\d{5})-?(\d{3})(?!\d)', value)
    return ''.join(match.groups()) if match else None


def validate_destination(value):
    if value is None:
        return None
    value = value.strip()
    code = postal_code(value)
    if not code or code == '00000000' or len(re.findall(r'\d{5}-?\d{3}', value)) != 1:
        raise ValueError('Informe um único CEP válido com oito dígitos (ex.: 01001-000).')
    return value


def amount(value):
    value = value.rstrip('.,')
    if ',' in value:
        value = value.replace('.', '').replace(',', '.')
    elif re.fullmatch(r'\d{1,3}(?:\.\d{3})+', value):
        value = value.replace('.', '')
    try:
        result = Decimal(value)
        return result if result.is_finite() else None
    except InvalidOperation:
        return None


MONEY = re.compile(r'(?:R\$|\bBRL)\s*(\d[\d.,]*)|(\d[\d.,]*)\s*reais\b', re.I)
NEGATED = re.compile(r'\b(?:talvez|hipot[eé]tic|suponha|seria|poderia|se\s+(?:fosse|conseguisse|voc[eê])|n[aã]o\s+(?:confirmo|aceito|inclu|tem\s+(?:frete|preço|estoque)|[eé]|ofere[çc]))', re.I)
ACCEPTED = re.compile(r'\b(?:confirmo|confirmamos|aceito|aceitamos|fechado|combinado|de\s+acordo|cotação\s+confirmada)\b', re.I)


def monetary_values(text, field):
    values = set()
    for match in MONEY.finditer(text):
        prefix = text[max(0, match.start() - 45):match.start()].lower()
        suffix = text[match.end():match.end() + 30].lower()
        prefix = re.split(r'[,;!?\n]|\.(?!\d)', prefix)[-1]
        shipping = bool(re.search(r'(?:frete|entrega)\s*(?:total\s*)?(?:de|:|=|é|fica|por|a)?\s*$', prefix) or re.match(r'\s*(?:de|para o)\s+frete', suffix))
        fee = bool(re.search(r'(?:taxa|seguro|encargo|adicional|imposto|embalagem|montagem|instalação|manuseio)', prefix))
        total = bool(re.search(r'\b(?:total|pedido|lote)\b', prefix))
        eligible = shipping if field == 'shipping_fee' else not shipping and not fee and not total
        value = amount(match.group(1) or match.group(2))
        if eligible and value is not None:
            values.add(value)
    return values


def supported_numeric(field, value, quotes):
    if value is None:
        return False
    for text in quotes:
        if NEGATED.search(text):
            continue
        if field in {'price', 'shipping_fee'}:
            if monetary_values(text, field) == {Decimal(value)}:
                return True
            if field == 'shipping_fee' and value == 0 and re.search(r'frete\s+(?:[eé]\s+)?(?:gr[aá]tis|gratuito|incluso)|sem\s+(?:custo\s+de\s+)?frete|isen[çc][aã]o\s+(?:do|de)\s+frete', text, re.I):
                return True
        else:
            pattern = r'(?<!\d)(\d+)\s*(?:unidades?|un\b|em\s+estoque)' if field == 'available_qty' else r'(?<!\d)(\d+)\s*dias?\b'
            if int(value) in [int(v) for v in re.findall(pattern, text, re.I)]:
                return True
    return False


def confirmed_costs(costs, quotes):
    if costs is None:
        return None
    charge = re.compile(r'(?:taxa|seguro|encargo|embalagem|montagem|instalação|manuseio)[\wÀ-ÿ :]*?(?:R\$|BRL)\s*(\d[\d.,]*)', re.I)
    announced = {match.group(0).casefold(): amount(match.group(1)) for q in quotes for match in charge.finditer(q) if amount(match.group(1)) not in {None, Decimal('0')}}
    if not costs:
        return [] if not announced and any(re.search(r'n[aã]o\s+(?:tem|h[aá])\s+taxas?\b|sem\s+(?:outras?\s+)?(?:taxas|custos|encargos)(?:\s+adicionais)?|(?:taxas|custos|encargos)\s+(?:adicionais\s+)?(?:inclusos|incluídos|zero|zerados)', q, re.I) and not NEGATED.search(q) for q in quotes) else None
    validated = []
    for cost in costs:
        evidence = [q for q in quotes if cost.description.casefold() in q.casefold() and not NEGATED.search(q)]
        pattern = re.compile(re.escape(cost.description) + r'\s*(?:de|:|=)?\s*(?:R\$|BRL)\s*(\d[\d.,]*)', re.I)
        if not any(cost.amount in {amount(v) for v in pattern.findall(q)} for q in evidence):
            return None
        validated.append(cost)
    names = [c.description.casefold() for c in validated]
    complete = all(any(c.description.casefold() in text and c.amount == value for c in validated) for text, value in announced.items())
    return validated if len(names) == len(set(names)) and complete else None


def explicit_acceptance(quotes, history):
    latest = next((m for m in reversed(history) if m['sender'] == 'SUPPLIER'), None)
    return bool(latest and any(q in latest['text'] and ACCEPTED.search(q) and not NEGATED.search(q) and '?' not in q for q in quotes))
