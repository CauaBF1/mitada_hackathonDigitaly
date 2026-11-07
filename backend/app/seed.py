from sqlalchemy import select

from .database import SessionLocal
from .models import Supplier
from .schemas import PurchaseRequestCreate, SupplierCreate, VoiceWebhook
from .services import persist_request, persist_supplier, persist_voice_quote


def seed_demo() -> None:
    with SessionLocal() as session:
        if session.scalar(select(Supplier.id).limit(1)) is not None:
            return
    supplier = persist_supplier(SupplierCreate(name="Atlas Supply · demonstração", phone="+551155550100"))
    examples = [
        ("Notebooks ThinkPad E14", "3800.00", 8, "4200.00", "3675.00"),
        ('Monitores 27" QHD', "1100.00", 12, "1280.00", "1080.00"),
        ("Cadeiras ergonômicas", "780.00", 20, "920.00", "760.00"),
        ("Hubs USB-C 8 em 1", "185.00", 30, "210.00", "185.00"),
    ]
    for item, target, qty, initial, final in examples:
        request = persist_request(PurchaseRequestCreate(item=item, target_price=target, qty=qty, supplier_id=supplier.id))
        persist_voice_quote(VoiceWebhook(
            request_id=request.id, supplier_id=supplier.id, initial_price=initial, final_price=final,
            available_qty=qty, delivery_time="5 dias úteis", conditions="Pagamento em 30 dias; frete incluso. Cotação simulada.",
            negotiation_rounds=2,
        ))
