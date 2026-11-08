"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BarChart3, CircleDollarSign, RefreshCw, Scale, TrendingDown } from "lucide-react";
import WorkspaceSidebar from "../../WorkspaceSidebar";
import PriceTimingSection from "./components/PriceTimingSection";
import { economicCosts } from "./economic-costs";
import { brl, requestJson, type AuthUser, type Dashboard, type PurchaseRequest, type WhatsAppPending } from "../../contracts";

function WhatsAppEconomicEvidence({ rows }: { rows: PurchaseRequest[] }) {
  const pending = rows.filter(row => row.whatsapp_pending?.length);
  if (!pending.length) return null;
  return <section aria-label="Propostas de fornecedores pelo WhatsApp" className="rounded-2xl border border-green-200 bg-white p-5 sm:p-7"><h2 className="text-lg font-bold">Retornos de fornecedores pelo WhatsApp</h2><p className="mt-2 text-xs leading-relaxed text-slate-500">Propostas separadas por canal e contato. Valores parciais ficam fora das economias e do custo final até a cotação estar completa e confirmada.</p><div className="mt-4 space-y-3">{pending.map(row => <details key={row.id} className="rounded-xl border border-slate-200"><summary className="cursor-pointer px-4 py-3 text-xs font-semibold text-slate-800">{row.item} · {row.qty} unidades · {row.whatsapp_pending?.length} contato(s) WhatsApp</summary><div className="space-y-3 border-t border-slate-100 p-3">{row.whatsapp_pending?.map((contact: WhatsAppPending) => {
    const terms = contact.terms || {};
    const cents = (key: string) => Number.isSafeInteger(terms[key]) ? Number(terms[key]) as number : null;
    const unit = cents("unit_cents"), shipping = cents("shipping_cents"), fees = cents("fees_cents");
    const subtotal = unit !== null && Number.isSafeInteger(unit * row.qty) ? unit * row.qty : null;
    const total = subtotal !== null && shipping !== null && fees !== null && Number.isSafeInteger(subtotal + shipping + fees) ? subtotal + shipping + fees : null;
    const eligibleTerms = total !== null && terms.product_confirmed === true && terms.destination_confirmed === true && contact.missing_fields.length === 0;
    const value = (amount: number | null) => amount === null ? "Não informado" : brl((amount / 100).toFixed(2));
    return <article key={contact.supplier_id} className="rounded-lg bg-green-50/60 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-xs font-semibold text-slate-800">{contact.supplier_name || "Fornecedor WhatsApp"}</h3><span className="text-[10px] text-slate-500">WhatsApp · {contact.supplier_id}</span></div><dl className="mt-3 grid gap-3 text-[11px] sm:grid-cols-4"><div><dt className="text-slate-500">Preço unitário</dt><dd className="mt-1 font-medium">{value(unit)}</dd></div><div><dt className="text-slate-500">Frete</dt><dd className="mt-1 font-medium">{value(shipping)}</dd></div><div><dt className="text-slate-500">Taxas</dt><dd className="mt-1 font-medium">{value(fees)}</dd></div><div><dt className="text-slate-500">{eligibleTerms ? "TCO completo informado" : "TCO calculável · pendente"}</dt><dd className="mt-1 font-semibold">{value(total)}</dd></div></dl>{contact.missing_fields.length > 0 && <p className="mt-3 text-[10px] text-amber-800">Pendente: {contact.missing_fields.join(", ")}</p>}</article>;
  })}</div></details>)}</div></section>;
}

export default function EconomicAnalysisPage() {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [data, setData] = useState<Dashboard | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true); setError("");
      try {
        const auth = await requestJson("/auth/me", { signal: controller.signal }).catch(() => null) as { user?: AuthUser } | null;
        if (!auth?.user) { if (!controller.signal.aborted) router.replace("/login"); return; }
        if (!controller.signal.aborted) setUser(auth.user);
        const result = await requestJson("/godmode/dashboard", { signal: controller.signal }) as Dashboard;
        if (result.data_mode !== "real" || !Array.isArray(result.runs)) throw new Error("Dados de análise incompatíveis.");
        if (!controller.signal.aborted) setData(result);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Análise indisponível.");
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load();
    return () => controller.abort();
  }, [router, revision]);

  const available = data?.runs.filter(row => row.audit?.deal_closed && row.quote && row.mode !== "sandbox") ?? [];
  const selected = available.find(row => row.id === selectedId) ?? available[0];
  const audit = selected?.audit;
  const comparisons = selected ? [
    ...selected.sources.map(source => ({ id: source.quote_id ?? source.product_url, label: source.supplier_name, price: source.price, chosen: false })),
    ...(selected.quote?.final_price != null ? [{ id: 'selected', label: 'Opção final selecionada', price: selected.quote.final_price, chosen: true }] : []),
  ] : [];
  const maxPrice = Math.max(1, ...comparisons.map(item => Number(item.price)));
  const costs = economicCosts(selected);
  const costMetrics = [
    { label: 'Custo do fornecedor', value: costs.supplier, icon: CircleDollarSign, color: 'bg-emerald-500', detail: 'Preço unitário informado pelo fornecedor. Sem frete e taxas.' },
    { label: 'Menor custo', value: costs.lowest, icon: TrendingDown, color: 'bg-sky-500', detail: 'Menor preço unitário entre o fornecedor e as ofertas levantadas. Sem frete e taxas; ofertas sujeitas à confirmação.' },
  ];
  const maxCost = Math.max(1, ...costMetrics.map(item => Number(item.value ?? 0)));

  return <div className="min-h-screen bg-[#f5f7fb] text-slate-900 [color-scheme:light]">
    <WorkspaceSidebar active="analysis" total={data?.total_runs} user={user} />
    <main className="mx-auto max-w-[1700px] space-y-6 p-4 sm:p-8 xl:ml-[218px]">
      <nav aria-label="Navegação da análise" className="flex flex-wrap items-center gap-4 text-xs font-semibold text-blue-700"><Link href="/dashboard">Visão geral</Link><Link href="/dashboard#kanban">Solicitações</Link><Link href="/history">Histórico</Link><button onClick={() => setRevision(value => value + 1)} disabled={loading} className="ml-auto flex items-center gap-2 disabled:opacity-50"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} />Atualizar análise</button></nav>
      <header className="rounded-3xl bg-gradient-to-r from-[#019EFD] to-[#415AFF] p-6 text-white sm:p-8"><BarChart3 size={28} /><p className="mt-5 text-[10px] font-bold uppercase tracking-[0.18em] text-blue-100">Dashboard / Análise Econômica</p><h1 className="mt-2 text-2xl font-bold sm:text-4xl">O impacto da sua decisão de compra.</h1><p className="mt-3 max-w-2xl text-sm leading-relaxed text-blue-50">Compare o mercado com a opção final e consulte a economia registrada, o custo total e os critérios que sustentam a escolha.</p></header>
      {error && <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{error}</p>}
      {loading && !data && <p role="status" className="p-6 text-sm text-slate-500">Carregando as análises disponíveis…</p>}
      {data && <WhatsAppEconomicEvidence rows={data.runs.filter(row => row.mode !== "sandbox")} />}
      {!loading && data && !available.length && <section className="rounded-3xl border border-slate-200 bg-white px-6 py-16 text-center"><Scale size={36} className="mx-auto text-[#415AFF]" /><h2 className="mt-5 text-xl font-bold">Sua próxima decisão começa com uma boa comparação.</h2><p className="mx-auto mt-3 max-w-lg text-sm leading-relaxed text-slate-500">Ainda não há cotações reais com auditoria econômica disponível. Conclua e confirme os termos de uma cotação para consultar seus indicadores aqui.</p><Link href="/dashboard#kanban" className="mt-6 inline-flex rounded-xl bg-[#415AFF] px-5 py-3 text-sm font-semibold text-white">Acompanhar solicitações</Link></section>}
      {selected && audit && <>
        <label className="block text-xs font-semibold text-slate-600">Solicitação analisada<select value={selected.id} onChange={event => setSelectedId(event.target.value)} className="mt-2 block w-full rounded-xl border border-slate-200 bg-white p-3 text-sm"><option disabled value="">Selecione uma solicitação</option>{available.map(row => <option key={row.id} value={row.id}>{row.item} · {row.qty} unidades</option>)}</select></label>
        <section aria-label="Indicadores econômicos" className="grid gap-4 md:grid-cols-3">
          {costMetrics.map(metric => <article key={metric.label} className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5"><metric.icon size={20} className="text-[#415AFF]" /><h2 className="mt-4 text-sm font-semibold">{metric.label}</h2><p className="mt-2 text-3xl font-bold">{brl(metric.value)}</p><div className="my-4 h-2 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${metric.color}`} style={{ width: `${Number(metric.value ?? 0) / maxCost * 100}%` }} /></div><p className="text-xs leading-relaxed text-slate-500">{metric.value == null ? 'Preço ainda não informado para esta comparação.' : metric.detail}</p></article>)}
          <article className="min-w-0 rounded-2xl bg-[#101827] p-5 text-white"><CircleDollarSign size={20} className="text-sky-300" /><h2 className="mt-4 text-sm font-semibold">Custo total final</h2><p className="mt-2 text-3xl font-bold">{brl(audit.final_total_cost ?? audit.final_tco)}</p><p className="mt-4 text-xs leading-relaxed text-slate-400">Produtos, frete e taxas registrados na cotação.</p></article>
        </section>
        <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-7"><h2 className="text-lg font-bold">Cotações encontradas vs. opção selecionada</h2><p className="mt-2 text-xs text-slate-500">Preços unitários em BRL. Frete e taxas são considerados no custo total, acima.</p><div className="mt-6 space-y-5">{comparisons.map(item => <div key={item.id}><div className="mb-2 flex flex-wrap justify-between gap-2 text-xs"><span className={item.chosen ? 'font-bold text-[#415AFF]' : 'text-slate-600'}>{item.label}</span><span className="font-semibold">{brl(item.price)}</span></div><div className="h-3 rounded-full bg-slate-100"><div className={`h-full rounded-full ${item.chosen ? 'bg-[#415AFF]' : 'bg-sky-300'}`} style={{ width: `${Number(item.price) / maxPrice * 100}%` }} /></div></div>)}</div></section>
        <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-7"><h2 className="flex items-center gap-2 text-lg font-bold"><Scale size={20} className="text-[#415AFF]" />Contexto da decisão</h2><dl className="mt-5 grid gap-4 sm:grid-cols-3"><div><dt className="text-xs text-slate-500">Prazo final</dt><dd className="mt-1 font-semibold">{audit.delivery_days} dias · {audit.delivery_day_type === 'business' ? 'úteis' : audit.delivery_day_type === 'calendar' ? 'corridos' : 'tipo não informado'}</dd></div><div><dt className="text-xs text-slate-500">Quantidade auditada</dt><dd className="mt-1 font-semibold">{audit.quantity} unidades</dd></div><div><dt className="text-xs text-slate-500">ReclameAqui</dt><dd className="mt-1 text-sm font-semibold">{selected.reputations.find(reputation => reputation.verified && reputation.supplier_domain === selected.quote?.supplier_domain)?.score ?? 'Nota não verificada'}</dd></div></dl><p className="mt-5 text-sm leading-relaxed text-slate-600">{audit.justification}</p><p className="mt-4 text-xs leading-relaxed text-slate-400">Custo do fornecedor e menor custo comparam preços unitários, sem frete e taxas. O custo total final inclui os encargos registrados. Valores negociados não representam pagamento realizado.</p></section>
      </>}
      {data && <PriceTimingSection key={selected?.id ?? "all"} requests={data.runs.filter(row => row.mode !== "sandbox")} defaultRequestId={selected?.id} refreshVersion={revision} />}
    </main>
  </div>;
}
