import type { Money, PurchaseRequest } from "../../contracts";

function cents(value: Money | null | undefined): bigint | null {
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return amount > 0n ? amount : null;
}
function money(value: bigint | null): Money | null {
  return value === null ? null : `${value / 100n}.${String(value % 100n).padStart(2, "0")}`;
}

/** Unit prices share one basis; shipping/fees remain in the separate total card. */
export function economicCosts(request: Pick<PurchaseRequest, "quote" | "sources" | "supplier_unit_price"> | undefined) {
  const quote = request?.quote;
  const direct = quote && (quote.channel === "telegram" || quote.channel === "whatsapp" || quote.source_type === "supplier_telegram" || quote.source_type === "supplier_whatsapp");
  const supplier = request && "supplier_unit_price" in request ? cents(request.supplier_unit_price) : direct ? cents(quote.final_price) : null;
  const offers = (request?.sources ?? []).flatMap(source => {
    const amount = cents(source.price);
    return amount === null ? [] : [amount];
  });
  if (supplier !== null) offers.push(supplier);
  const lowest = offers.length ? offers.reduce((a, b) => a < b ? a : b) : null;
  return { supplier: money(supplier), lowest: money(lowest) };
}
