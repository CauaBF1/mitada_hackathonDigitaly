"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Download, ExternalLink, Globe, MessageCircle, ShieldCheck, X } from "lucide-react";
import { brl, referenceProduct, safeUrl, requestJson, type PurchaseRequest } from "./contracts";

import RequestActions from "./RequestActions";

const MISSING_LABELS: Record<string, string> = {
  unit_cents: "preço unitário",
  shipping_cents: "frete",
  fees_cents: "taxas adicionais",
  lead_days: "prazo de entrega",
  available_qty: "estoque disponível",
  product_confirmed: "confirmação do produto",
  destination_confirmed: "confirmação do CEP",
  safe_total: "validação de total seguro",
};

function exportEvidence(row: PurchaseRequest) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(row, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = `nexo-evidencias-${row.id}.json`; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function SideDrawer({ row, close, openChat, decided, deleted, repeated }: { deleted: (id: string) => Promise<void>; repeated: (row: PurchaseRequest) => Promise<void>; row: PurchaseRequest | null; close: () => void; openChat: () => void; decided: () => void }) {
  const [decisionBusy, setDecisionBusy] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState("");
  const [confirmPurchase, setConfirmPurchase] = useState(false);
  const [marketBusy, setMarketBusy] = useState<string | null>(null);
  const [marketError, setMarketError] = useState("");
  const [reputationBusy, setReputationBusy] = useState(false);
  const [reputationMessage, setReputationMessage] = useState("");
  const idempotencyKey = useRef<{ key: string; quoteId: string; version: number } | null>(null);
  useEffect(() => {
    setDecisionError(""); setConfirmPurchase(false); setMarketError(""); setReputationMessage("");
  }, [row?.id]);
  async function decide() { if (!row || decisionBusy || !row.quote?.id) return; if (!idempotencyKey.current || idempotencyKey.current.quoteId !== row.quote.id || idempotencyKey.current.version !== row.version) idempotencyKey.current = { key: crypto.randomUUID(), quoteId: row.quote.id, version: row.version }; setDecisionBusy(row.quote.id); setDecisionError(""); try { await requestJson(`/request/${row.id}/decision`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey.current.key }, body: JSON.stringify({ quote_id: row.quote.id, version: row.version, confirmed: true }) }); setConfirmPurchase(false); idempotencyKey.current = null; decided(); } catch (cause) { setDecisionError(cause instanceof Error ? cause.message : "Não foi possível registrar a decisão."); } finally { setDecisionBusy(null); } }
  async function selectMarketPreference(quoteId: string | null) {
    if (!row || marketBusy) return;
    setMarketBusy(quoteId ?? "clear"); setMarketError("");
    try {
      await requestJson(`/request/${row.id}/market-preference`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ quote_id: quoteId, version: row.version }) });
      decided();
    } catch (cause) {
      setMarketError(cause instanceof Error ? cause.message : "Não foi possível registrar a preferência.");
    } finally { setMarketBusy(null); }
  }
  async function refreshReputation() { if (!row || reputationBusy) return; setReputationBusy(true); setReputationMessage(""); try { await requestJson(`/request/${row.id}/reputation-refresh`, { method: "POST" }); setReputationMessage("Reputação atualizada."); decided(); } catch (cause) { setReputationMessage(`Falha ao atualizar. Dados existentes preservados. ${cause instanceof Error ? cause.message : ""}`); } finally { setReputationBusy(false); } }
  const dialog = useRef<HTMLDialogElement>(null);
  const open = row !== null;
  useEffect(() => {
    const element = dialog.current;
    if (!open) { element?.close(); return; }
    element?.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = overflow; element?.close(); };
  }, [open]);
  const source = row ? referenceProduct(row) : undefined;
  const reputation = row?.reputations.find(r => r.supplier_domain === source?.supplier_domain);
  const audit = row?.audit;
  const chosenSource = row?.sources.find(item => item.product_url === row.quote?.product_url) || source;
  const simulation = row?.purchase_simulation;
  const simulationActive = simulation?.status === "awaiting_supplier" || simulation?.status === "confirmed";
  const preferredMarket = row?.preferred_market_quote_id ? row.sources.find(item => item.quote_id === row.preferred_market_quote_id) : undefined;
  const profile = source ? row?.supplier_profiles?.[source.supplier_domain] : undefined;
  const feeAmount = audit?.additional_cost_total ?? row?.quote?.fees_fee ?? null;
  const fullTco = audit?.final_tco ?? row?.quote?.final_tco ?? null;
  const partialTotal = fullTco == null && row?.quote?.final_price != null
    ? (Number(row.quote.final_price) * row.qty + Number(row.quote.shipping_fee || 0) + Number(row.quote.fees_fee || 0)).toFixed(2)
    : null;
  const deliveryDays = audit?.delivery_days ?? row?.quote?.delivery_days ?? null;
  return <dialog ref={dialog} onCancel={close} onClick={event => { if (event.target === event.currentTarget) close(); }} aria-labelledby="drawer-title" className="side-drawer fixed inset-y-0 left-auto right-0 h-dvh max-h-none w-full max-w-xl border-0 bg-white p-0 text-slate-900 shadow-2xl">
    {row && <div className="flex h-full flex-col">
      <header className="flex items-start justify-between gap-4 bg-gradient-to-r from-blue-600 to-blue-400 p-6 text-white"><div><p className="text-[10px] font-semibold uppercase tracking-widest text-blue-100">Inteligência da negociação · #{row.id}</p><h2 id="drawer-title" className="mt-2 text-xl font-semibold">{row.item}</h2><p className="mt-2 text-xs text-blue-100">{row.qty} unidade(s) · {row.delivery_location || "Destino a confirmar"}</p></div><button autoFocus onClick={close} aria-label="Fechar detalhes" className="rounded-lg p-2 hover:bg-white/10"><X size={20} /></button></header>
      <div className="flex-1 space-y-5 overflow-y-auto p-6">
        <RequestActions key={row.id} id={row.id} product={row.item} disabled={decisionBusy !== null} onDeleted={deleted} onRepeated={repeated}/>
        {row.mode === "sandbox" && <p className="rounded-lg bg-violet-50 p-3 text-xs text-violet-800">Teste no seu Telegram · resultados fora dos indicadores reais.</p>}
        {!!row.whatsapp_pending?.length && <section aria-label="Propostas recebidas pelo WhatsApp" className="rounded-2xl border border-green-200 bg-green-50/50 p-4"><h3 className="text-sm font-semibold text-green-900">WhatsApp · propostas em andamento</h3><p className="mt-1 text-[11px] leading-relaxed text-green-800">Cada contato permanece separado do Telegram e dos demais fornecedores. Termos ausentes continuam sem valor.</p><div className="mt-3 space-y-3">{row.whatsapp_pending.map(contact => {
          const terms = contact.terms || {};
          const cents = (key: string) => Number.isSafeInteger(terms[key]) ? Number(terms[key]) as number : null;
          const unit = cents("unit_cents"), shipping = cents("shipping_cents"), fees = cents("fees_cents");
          const subtotal = unit !== null && Number.isSafeInteger(unit * row.qty) ? unit * row.qty : null;
          const total = subtotal !== null && shipping !== null && fees !== null && Number.isSafeInteger(subtotal + shipping + fees) ? subtotal + shipping + fees : null;
          return <article key={contact.supplier_id} className="rounded-xl border border-green-100 bg-white p-3"><div className="flex flex-wrap justify-between gap-2"><strong className="text-xs text-slate-800">{contact.supplier_name || "Fornecedor WhatsApp"}</strong><span className="text-[10px] text-slate-400">WhatsApp · {contact.supplier_id}</span></div><dl className="mt-3 grid grid-cols-2 gap-3 text-[11px]"><div><dt className="text-slate-400">Unitário × {row.qty}</dt><dd className="mt-1 font-medium">{unit === null ? "Não informado" : `${brl((unit / 100).toFixed(2))} × ${row.qty}`}</dd></div><div><dt className="text-slate-400">Frete</dt><dd className="mt-1 font-medium">{shipping === null ? "Não informado" : brl((shipping / 100).toFixed(2))}</dd></div><div><dt className="text-slate-400">Taxas</dt><dd className="mt-1 font-medium">{fees === null ? "Não informado" : brl((fees / 100).toFixed(2))}</dd></div><div><dt className="text-slate-400">TCO calculável</dt><dd className="mt-1 font-semibold">{total === null ? "Pendente" : brl((total / 100).toFixed(2))}</dd></div></dl>{contact.missing_fields.length > 0 && <p className="mt-3 text-[10px] text-amber-800">Pendente: {contact.missing_fields.map(field => MISSING_LABELS[field] || field).join(", ")}</p>}</article>;
        })}</div></section>}
        {row.notice && <p role="status" className="rounded-xl border border-amber-100 bg-amber-50 p-4 text-xs leading-relaxed text-amber-900">{row.notice}</p>}
        <section aria-label="Composição do TCO" className="rounded-2xl bg-[#111827] p-5 text-white shadow-lg">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-blue-200">Composição do TCO · Dados do fornecedor</p>
              <p className="mt-1 text-[11px] text-slate-400">Informações extraídas pelo agente na conversa + custos logísticos</p>
            </div>
            <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${row.status === "DONE" ? "bg-emerald-500/20 text-emerald-200" : row.quote_completion_state === "aguardando_confirmacao" ? "bg-sky-500/20 text-sky-200" : row.quote ? "bg-amber-500/20 text-amber-200" : "bg-slate-700 text-slate-300"}`}>
              {row.status === "DONE" ? "Cotação concluída" : row.quote_completion_state === "aguardando_confirmacao" ? "Aguardando confirmação final" : row.quote ? "Extração em andamento" : "Aguardando fornecedor"}
            </span>
          </div>
          <dl className="mt-5 space-y-3 text-sm">
            <div className="flex justify-between gap-4"><dt className="text-slate-300">Fornecedor ({row.quote?.channel === "whatsapp" ? "WhatsApp" : "Telegram"})</dt><dd className="text-right text-xs font-medium text-slate-100">{row.quote?.supplier_name || "Aguardando retorno"}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-slate-300">Preço unitário final × {row.qty}</dt><dd className="numeric">{audit ? `${brl(audit.final_price)} × ${row.qty}` : row.quote?.final_price ? `${brl(row.quote.final_price)} × ${row.qty}` : "A confirmar"}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-300">Subtotal de produtos</dt><dd className="numeric">{brl(audit?.product_subtotal ?? (row.quote?.final_price ? (Number(row.quote.final_price) * row.qty).toFixed(2) : null))}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-300">Frete</dt><dd className="numeric">{audit ? brl(audit.shipping_fee) : row.quote?.shipping_fee == null ? "Não confirmado" : brl(row.quote.shipping_fee)}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-300">Taxas adicionais</dt><dd className="numeric">{feeAmount == null ? "Não confirmadas" : brl(feeAmount)}</dd></div>
            {audit?.additional_costs?.map((cost, i) => <div key={i} className="flex justify-between text-xs text-slate-400"><dt>{cost.description}</dt><dd>{brl(cost.amount)}</dd></div>)}
            <div className="flex justify-between"><dt className="text-slate-300">Prazo de entrega</dt><dd className="text-xs text-slate-200">{deliveryDays != null ? `${deliveryDays} dias` : row.quote?.delivery_time && row.quote.delivery_time !== "Não confirmado" ? row.quote.delivery_time : "Não confirmado"}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-300">Estoque informado</dt><dd className="text-xs text-slate-200">{row.quote?.available_qty != null ? `${row.quote.available_qty} unidade(s)` : "Não confirmado"}</dd></div>
            {row.quote?.payment_terms && <div className="flex justify-between gap-4"><dt className="text-slate-300">Pagamento</dt><dd className="text-right text-xs text-slate-200">{row.quote.payment_terms}</dd></div>}
            {row.quote?.valid_until && <div className="flex justify-between gap-4"><dt className="text-slate-300">Validade</dt><dd className="text-right text-xs text-slate-200">{row.quote.valid_until}</dd></div>}
            {row.quote?.conditions && !row.quote.conditions.includes(" | https://") && <div className="flex justify-between gap-4"><dt className="text-slate-300">Condições</dt><dd className="text-right text-xs text-slate-200">{row.quote.conditions}</dd></div>}
            <div className="flex justify-between border-t border-white/10 pt-4 text-lg font-semibold">
              <dt>{fullTco != null ? "Total negociado" : partialTotal != null ? "Total parcial extraído" : "Total negociado"}</dt>
              <dd className="numeric text-blue-200">{brl(fullTco ?? partialTotal)}</dd>
            </div>
          </dl>
          {row.status !== "DONE" && row.quote_completion_state === "aguardando_confirmacao" && (
            <p className="mt-4 rounded-xl bg-sky-500/15 p-3 text-xs leading-relaxed text-sky-100">Todos os dados obrigatórios foram extraídos. Aguardando apenas o &ldquo;Confirmo&rdquo; final do fornecedor no Telegram para mover para Concluídas.</p>
          )}
          {row.status !== "DONE" && row.missing_fields && row.missing_fields.length > 0 && (
            <p className="mt-4 rounded-xl bg-amber-500/15 p-3 text-xs leading-relaxed text-amber-100">Pendente com o fornecedor para concluir a cotação: {row.missing_fields.map(field => MISSING_LABELS[field] || field).join(", ")}.</p>
          )}
        </section>

        {row.status === "DONE" && (
          <section aria-label="Decisão de compra" className="space-y-4 rounded-xl border border-emerald-200 bg-emerald-50/60 p-4">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Decisão de compra · Fornecedor ou Internet</h3>
              <p className="mt-1 text-xs text-slate-600">Escolha entre fechar com o fornecedor cotado no Telegram ou registrar preferência por uma oferta da internet.</p>
            </div>
            {row.quote && (
              <div className="space-y-3 rounded-xl border border-emerald-200 bg-white p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold text-slate-900">Opção 1 · Comprar com fornecedor ({row.quote.supplier_name || "Telegram"})</p>
                    <p className="mt-1 text-[11px] text-slate-600">Total: <span className="font-semibold">{brl(fullTco)}</span> · Prazo: {deliveryDays != null ? `${deliveryDays} dias` : row.quote.delivery_time}</p>
                  </div>
                  {simulation?.status === "confirmed" && <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-[10px] font-semibold text-emerald-800"><CheckCircle2 size={12} />Confirmada</span>}
                </div>
                {simulation ? <p role="status" className="text-xs text-slate-700">Status: <span className="font-semibold">{{ awaiting_supplier: "Aguardando fornecedor", review_required: "Revisão humana necessária", confirmed: "Confirmada na simulação", rejected: "Rejeitada", cancelled: "Cancelada" }[simulation.status]}</span></p> : <p className="text-xs text-slate-600">Nenhuma simulação iniciada.</p>}
                <div className="flex flex-wrap gap-2">
                  {(!simulation || ["cancelled", "rejected", "review_required"].includes(simulation.status)) && row.quote.id && (
                    <button onClick={() => setConfirmPurchase(true)} disabled={!!decisionBusy} className="rounded-lg bg-emerald-700 px-4 py-2.5 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50">{decisionBusy ? "Registrando…" : "Quero comprar"}</button>
                  )}
                  {simulation && simulation.status === "awaiting_supplier" && (
                    <button onClick={async () => { try { await requestJson(`/request/${row.id}/purchase-simulation/cancel`, { method: "POST" }); decided(); } catch (cause) { setDecisionError(cause instanceof Error ? cause.message : "Não foi possível cancelar."); } }} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold">Cancelar simulação</button>
                  )}
                </div>
                <p className="text-[10px] leading-relaxed text-slate-500">A ação inicia uma compra simulada pelo Telegram. Não há cobrança nem pagamento real.</p>
              </div>
            )}
            <div className="space-y-2.5 rounded-xl border border-blue-200 bg-white p-3.5">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-900"><Globe size={14} className="text-blue-600" />Opção 2 · Preferência por opção da internet</div>
              {preferredMarket ? (
                <div className="rounded-lg border border-blue-200 bg-blue-50/70 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-xs font-semibold text-blue-950">Preferência registrada: {preferredMarket.supplier_name}</p>
                      <p className="mt-1 text-[11px] text-blue-900">{brl(preferredMarket.price)} / un.{row.qty > 1 ? ` · Subtotal (${row.qty} un.): ${brl((Number(preferredMarket.price) * row.qty).toFixed(2))}` : ""}</p>
                    </div>
                    <span className="rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-semibold text-white">Selecionada</span>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <a href={safeUrl(preferredMarket.product_url)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700">Ir para oferta na loja <ExternalLink size={12} /></a>
                    <button onClick={() => void selectMarketPreference(null)} disabled={!!marketBusy || simulationActive} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 disabled:opacity-50">{marketBusy === "clear" ? "Removendo…" : "Limpar preferência"}</button>
                  </div>
                </div>
              ) : (
                <p className="text-[11px] leading-relaxed text-slate-600">{row.sources.length > 0 ? "Prefere comprar direto em uma loja online? Clique em “Preferir esta opção da internet” em qualquer oferta do mercado listada logo abaixo." : "Nenhuma opção de loja online foi encontrada para esta solicitação."}</p>
              )}
              {simulationActive && <p className="text-[10px] text-amber-800">Há uma simulação ativa com o fornecedor. Cancele-a caso queira trocar para uma opção da internet.</p>}
              {marketError && <p role="alert" className="text-xs text-rose-700">{marketError}</p>}
            </div>
          </section>
        )}

        <section aria-label="Opções do mercado" className="rounded-xl border border-slate-200 p-4">
          <h3 className="text-sm font-semibold">Opções do mercado (fora do fornecedor)</h3>
          <p className="mt-1 text-[11px] text-slate-500">{row.sources.length} ofertas na internet · {row.blocked_sites} páginas bloqueadas</p>
          <div className="mt-4 space-y-3">{row.sources.map(product => {
            const ra = row.reputations.find(r => r.supplier_domain === product.supplier_domain);
            const isPreferred = !!product.quote_id && product.quote_id === row.preferred_market_quote_id;
            return <article key={product.product_url} className={`rounded-lg p-3 transition ${isPreferred ? "border border-blue-400 bg-blue-50/50 ring-1 ring-blue-200" : "bg-slate-50"}`}>
              <div className="flex justify-between gap-3">
                <a href={safeUrl(product.product_url)} target="_blank" rel="noreferrer" className="text-xs font-medium text-blue-700 hover:underline">{product.supplier_name} ↗</a>
                <div className="text-right">
                  <span className="numeric shrink-0 text-xs font-semibold">{brl(product.price)}</span>
                  {row.qty > 1 && <p className="numeric text-[10px] text-slate-500">Subtotal ({row.qty} un.): {brl((Number(product.price) * row.qty).toFixed(2))}</p>}
                </div>
              </div>
              <p className="mt-2 text-xs text-slate-600">{product.product_name}</p>
              <p className="mt-2 text-[10px] text-slate-400">Coletado em {new Date(product.observed_at).toLocaleString("pt-BR")}</p>
              <p className="mt-1 text-[10px] text-slate-500">Frete {product.shipping_fee == null ? "não confirmado no site" : brl(product.shipping_fee)} · {product.availability === "Não confirmada" ? "estoque não confirmado" : `estoque ${product.availability}`}</p>
              {ra?.verified && ra.score !== null && <p className="mt-2 text-[11px] text-slate-500">{ra.verified && ra.score !== null ? `${ra.score}/10 · ${ra.label}` : ""} · {ra.reason}</p>}
              {safeUrl(ra?.url) && <a href={safeUrl(ra?.url)} target="_blank" rel="noreferrer" className="mt-2 block text-[11px] text-blue-700">ReclameAqui ↗</a>}
              {row.status === "DONE" && product.quote_id && (
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-200/80 pt-2.5">
                  {isPreferred ? (
                    <span className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-[11px] font-semibold text-white"><CheckCircle2 size={12} />Preferência da internet selecionada</span>
                  ) : (
                    <button onClick={() => void selectMarketPreference(product.quote_id!)} disabled={!!marketBusy || simulationActive} className="rounded-lg border border-blue-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-50">
                      {marketBusy === product.quote_id ? "Salvando…" : "Preferir esta opção da internet"}
                    </button>
                  )}
                </div>
              )}
            </article>;
          })}</div>
          {decisionError && <p role="alert" className="mt-3 text-xs text-rose-700">{decisionError}</p>}
          {row.sources.length === 0 && <p className="mt-3 text-xs text-slate-500">Nenhuma oferta na internet registrada pela API para esta solicitação.</p>}
        </section>

        <section className="rounded-xl border border-slate-200 p-4"><h3 className="text-sm font-semibold">Referência e economia</h3><dl className="mt-4 space-y-3 text-xs text-slate-600"><div className="flex justify-between"><dt>Mercado · preço unitário médio</dt><dd className="numeric">{brl(row.market_average)}</dd></div><div className="flex justify-between"><dt>TCO base · menor oferta elegível</dt><dd className="numeric">{row.tco_base == null ? "Frete ou taxas pendentes" : brl(row.tco_base)}</dd></div><div className="flex justify-between font-semibold text-blue-700"><dt>Meta total da negociação</dt><dd className="numeric">{brl(row.target_price)}</dd></div><div className="flex justify-between"><dt>TCO da primeira cotação</dt><dd className="numeric">{brl(audit?.initial_tco)}</dd></div><div className="flex justify-between"><dt>Hard Savings · produtos</dt><dd className="numeric">{!audit || row.hard_savings == null ? "Pendente de evidências" : brl(row.hard_savings)}</dd></div><div className="flex justify-between"><dt>Cost Avoidance · produtos</dt><dd className="numeric">{!audit || row.cost_avoidance == null ? "Pendente de evidências" : brl(row.cost_avoidance)}</dd></div><div className="flex justify-between"><dt>Economia no frete</dt><dd className="numeric">{brl(audit?.shipping_savings)}</dd></div><div className="flex justify-between"><dt>Economia total de TCO</dt><dd className="numeric">{brl(audit?.tco_savings)}</dd></div></dl><p className="mt-3 text-[11px] text-slate-500">Economia negociada, ainda não realizada por pagamento ou entrega. Hard Savings e Cost Avoidance comparam preços unitários × quantidade. A economia no frete está incluída na economia de TCO.</p>{row.target_basis === "product_subtotal" && <p className="mt-4 text-[11px] leading-relaxed text-amber-700">Frete ou taxas de mercado desconhecidos. A meta usa 85% do subtotal dos produtos como limite conservador para a cotação completa.</p>}</section>
        {row.discovery_justification && <section className="rounded-xl border border-slate-200 p-4"><h3 className="text-sm font-semibold">Estratégia de compra</h3><p className="mt-3 text-xs leading-relaxed text-slate-600">{row.discovery_justification}</p></section>}
        {profile && <section className="rounded-xl border border-slate-200 p-4"><h3 className="text-sm font-semibold">Memória do fornecedor</h3><p className="mt-3 whitespace-pre-line text-xs leading-relaxed text-slate-600">{profile.tactical_briefing}</p>{profile.historical_discount_avg_pct !== null && <p className="mt-3 text-xs text-blue-700">Desconto unitário histórico médio: {profile.historical_discount_avg_pct}%</p>}</section>}
        <section aria-label="Parecer do auditor" className="rounded-xl border border-blue-100 bg-blue-50/70 p-4"><h3 className="flex items-center gap-2 text-sm font-semibold text-blue-900"><ShieldCheck size={17} />Parecer do auditor</h3><p className="mt-3 text-xs leading-relaxed text-blue-950">{audit?.audit_justification || audit?.justification || "Aguardando confirmação de preço, frete, estoque e prazo pelo fornecedor."}</p>{audit && <><p className="mt-3 text-xs text-slate-600">Condições: {row.quote?.conditions}</p>{!!audit.limitations?.length && <ul className="mt-3 list-disc space-y-2 pl-4 text-[11px] text-slate-600">{audit.limitations.map(item => <li key={item}>{item}</li>)}</ul>}<p className="mt-3 text-[10px] text-slate-500">Evidências: mensagens {audit.evidence_message_ids?.join(", ") || "não informadas"}{audit.audited_at ? ` · ${new Date(audit.audited_at).toLocaleString("pt-BR")}` : ""}</p></>}</section>
        <section className="space-y-3 rounded-xl border border-slate-200 p-4"><h3 className="text-sm font-semibold">Fornecedor e reputação</h3>{source ? <><p className="text-xs text-slate-600">{source.supplier_name}</p><a href={safeUrl(source.product_url)} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-xs text-blue-700">Produto na loja <ExternalLink size={13} /></a></> : <p className="text-xs text-slate-500">Pesquisa de fornecedores em andamento.</p>}{reputation?.verified && reputation.score != null && <><p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Verificação</p><p className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${reputation?.verified && reputation.approved ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>{reputation?.verified && reputation.score != null ? `ReclameAqui: ${reputation.score}/10` : ""}</p></>}{reputation?.verified && <><p className="text-[11px] text-slate-500">{reputation.reason}</p><p className="text-[10px] text-slate-400">Consultado em {reputation.checked_at ? new Date(reputation.checked_at).toLocaleString("pt-BR") : "data não informada"}</p></>}{safeUrl(reputation?.url) && <a href={safeUrl(reputation?.url)} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-xs text-blue-700">Consultar ReclameAqui <ExternalLink size={13} /></a>}<button onClick={() => void refreshReputation()} disabled={reputationBusy} className="rounded-lg border border-slate-200 px-3 py-2 text-[10px] font-semibold text-slate-700 disabled:opacity-50">{reputationBusy ? "Atualizando…" : "Atualizar reputação"}</button>{reputationMessage && <p role="status" className="text-[11px] text-slate-600">{reputationMessage}</p>}</section>
        {confirmPurchase && row.quote && <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/40 p-4"><section role="alertdialog" aria-labelledby="purchase-confirm-title" className="w-full max-w-md rounded-xl bg-white p-5 shadow-2xl"><h3 id="purchase-confirm-title" className="text-base font-semibold">Confirmar compra simulada?</h3><p className="mt-3 text-xs text-slate-600">{row.quote.supplier_name || chosenSource?.supplier_name || "Fornecedor"} · {row.quote.product_name || row.item}</p><dl className="mt-4 space-y-2 text-xs"><div className="flex justify-between"><dt>Quantidade</dt><dd>{row.qty}</dd></div><div className="flex justify-between"><dt>Destino</dt><dd>{row.delivery_location || "Não informado"}</dd></div><div className="flex justify-between"><dt>Preço unitário</dt><dd>{brl(row.quote.final_price)}</dd></div><div className="flex justify-between"><dt>Frete</dt><dd>{brl(row.quote.shipping_fee)}</dd></div><div className="flex justify-between"><dt>Taxas</dt><dd>{brl(feeAmount)}</dd></div><div className="flex justify-between border-t pt-2 font-semibold"><dt>Total</dt><dd>{brl(row.quote.final_tco)}</dd></div></dl><p className="mt-4 rounded-lg bg-amber-50 p-3 text-[11px] text-amber-900">Isso inicia somente uma simulação pelo Telegram. Nenhuma cobrança será feita.</p>{decisionError && <p role="alert" className="mt-3 text-xs text-rose-700">{decisionError}</p>}<div className="mt-4 flex justify-end gap-2"><button onClick={() => setConfirmPurchase(false)} className="rounded-lg border px-3 py-2 text-xs">Voltar</button><button onClick={() => void decide()} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white">Confirmar simulação</button></div></section></div>}
        {!!row.candidates.length && <details className="rounded-xl border border-slate-200 p-4"><summary className="cursor-pointer text-xs font-semibold">Fontes consultadas ({row.candidates.length})</summary><ul className="mt-3 space-y-3">{row.candidates.map(candidate => <li key={candidate.url} className="break-words text-xs"><a href={safeUrl(candidate.url)} target="_blank" rel="noreferrer" className="text-blue-700 underline">{candidate.title}</a><p className="mt-1 text-slate-500">{candidate.price ? brl(candidate.price) : "Preço não confirmado"}</p>{candidate.error && <p className="mt-1 text-amber-700">{candidate.error}</p>}</li>)}</ul></details>}
        {!!row.errors.length && <details className="rounded-xl border border-slate-200 p-4"><summary className="cursor-pointer text-xs font-semibold">Limitações da coleta ({row.errors.length})</summary><ul className="mt-3 space-y-2 text-xs text-slate-500">{row.errors.map((error, i) => <li key={i} className="break-words">{error}</li>)}</ul></details>}
        <button onClick={() => exportEvidence(row)} className="flex items-center gap-2 rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600"><Download size={14} />Exportar evidências</button>
      </div>
      <footer className="border-t border-slate-100 bg-white p-5"><button onClick={openChat} className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 p-3 text-sm font-semibold text-white hover:bg-blue-700"><MessageCircle size={18} />Acompanhar conversa ao vivo</button></footer>
    </div>}
  </dialog>;
}
