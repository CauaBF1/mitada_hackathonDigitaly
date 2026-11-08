"use client";

import { brl, referenceProduct, safeUrl, requestJson, type Status, type Product, type Reputation, type PurchaseRequest, type Dashboard, type AgentEvent, type AuthUser } from "../contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import LiveDemoModal from "../LiveDemoModal";
import LiveChatModal from "../LiveChatModal";
import SideDrawer from "../SideDrawer";
import RequestActions from "../RequestActions";
import WorkspaceSidebar, { UserAvatar } from "../WorkspaceSidebar";

import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, ExternalLink, LogOut, Plus, RefreshCw, Settings, ShieldCheck, Sparkles } from "lucide-react";

const columns: { status: Status; name: string; color: string }[] = [{ status: "TODO", name: "Na fila / pendências", color: "bg-slate-400" }, { status: "CALLING", name: "Pesquisa e compliance", color: "bg-blue-500" }, { status: "NEGOTIATING", name: "Aguardando cotação", color: "bg-amber-500" }, { status: "DONE", name: "Concluídas", color: "bg-emerald-500" }];
const empty: Dashboard = { runs: [], metrics: { hard_savings: "0.00", cost_avoidance: "0.00", final_spend: "0.00", completed_count: 0, active_count: 0, verified_suppliers_count: 0, pending_tco_count: 0 }, total_runs: 0, data_mode: "real" };
function isEvent(value: unknown): value is AgentEvent { const row = value as AgentEvent; return !!row && Number.isSafeInteger(row.id) && typeof row.run_id === "string" && typeof row.message === "string" && typeof row.created_at === "string"; }
function decode(value: unknown): Dashboard {
  const data = value as Dashboard;
  const money = (item: unknown) => typeof item === "string" && /^-?\d+(\.\d{1,2})?$/.test(item);
  if (!data || data.data_mode !== "real" || !Array.isArray(data.runs) || !data.metrics || !money(data.metrics.hard_savings) || !money(data.metrics.cost_avoidance) || !money(data.metrics.final_spend) || !data.runs.every(row => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.id) && columns.some(column => column.status === row.status) && Array.isArray(row.sources) && row.sources.every(source => money(source.price) && !!safeUrl(source.product_url)) && Array.isArray(row.reputations) && Array.isArray(row.errors))) throw new Error("Resposta incompatível com o contrato de dados reais.");
  return data;
}
function useProcurement() {
  const [data, setData] = useState<Dashboard>(empty);
  const [connection, setConnection] = useState<"loading" | "live" | "offline">("loading");
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState(false);
  const mounted = useRef(false);
  const pending = useRef<AbortController | null>(null);
  const refresh = useCallback(async (force = false) => {
    if (pending.current) { if (!force) return; pending.current.abort(); }
    const controller = new AbortController(); pending.current = controller;
    const timer = setTimeout(() => controller.abort(), 10000); setSyncing(true);
    try {
      const next = decode(await requestJson("/godmode/dashboard", { signal: controller.signal }));
      if (mounted.current && pending.current === controller) { setData(next); setConnection("live"); setError(""); }
    } catch (cause) { if (mounted.current && pending.current === controller) { setConnection("offline"); setError(cause instanceof Error ? cause.message : "API indisponível."); } }
    finally { clearTimeout(timer); if (pending.current === controller) { pending.current = null; if (mounted.current) setSyncing(false); } }
  }, []);
  useEffect(() => {
    mounted.current = true; void refresh();
    const interval = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    const visible = () => { if (!document.hidden) void refresh(); }; document.addEventListener("visibilitychange", visible);
    return () => { mounted.current = false; clearInterval(interval); pending.current?.abort(); pending.current = null; document.removeEventListener("visibilitychange", visible); };
  }, [refresh]);
  return { data, connection, error, syncing, refresh };
}

function SectionTitle({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) { return <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><div><p className="mb-1 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">{eyebrow}</p><h2 className="text-lg font-semibold tracking-tight text-slate-900">{title}</h2></div>{children}</div>; }
function ReputationBadge({ reputation }: { reputation?: Reputation }) {
  return <span title={reputation?.reason} className={`inline-flex items-center gap-1 rounded px-1.5 py-1 text-[9px] font-medium ${reputation?.verified ? reputation.approved ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700" : "bg-amber-50 text-amber-700"}`}><ShieldCheck size={10} />{reputation?.verified ? `${reputation.score}/10 · ${reputation.label}` : "Reputação não verificada"}</span>;
}
function ProductLink({ source, children }: { source: Product; children?: ReactNode }) { return <a href={safeUrl(source.product_url)} target="_blank" rel="noreferrer" className="inline-flex items-start gap-1 text-[11px] font-medium text-blue-700 hover:underline">{children || source.supplier_name}<ExternalLink size={11} className="mt-0.5 shrink-0" /></a>; }
function PurchaseRequestCard({ row, selected, onSelect, onRetry, retrying, deleted, repeated }: { deleted: (id: string) => Promise<void>; repeated: (row: PurchaseRequest) => Promise<void>; row: PurchaseRequest; selected: boolean; onSelect: () => void; onRetry: () => void; retrying: boolean }) {
  const source = referenceProduct(row);
  const reputation = row.reputations.find(item => item.supplier_domain === source?.supplier_domain);
  const blocked = ["blocked", "failed"].includes(row.stage);
  const supplierValue = row.quote?.final_tco ?? row.quote?.final_price ?? null;
  const preferredSource = row.preferred_market_quote_id ? row.sources.find(item => item.quote_id === row.preferred_market_quote_id) : undefined;
  return <article onClick={event => { if (!(event.target as HTMLElement).closest("button, a")) onSelect(); }} className={`min-w-0 cursor-pointer rounded-xl border bg-white p-3.5 shadow-sm transition ${selected ? "border-blue-400 ring-2 ring-blue-100" : "border-slate-200 hover:border-blue-200"}`}><button onClick={onSelect} className="w-full text-left" aria-pressed={selected}><div className="mb-2 flex justify-between text-[9px] text-slate-400"><span>#{String(row.id).padStart(3, "0")}</span><span>{row.qty.toLocaleString("pt-BR")} unidades</span></div><h3 className="break-words text-xs font-semibold leading-relaxed text-slate-900">{row.item}</h3>{row.mode === "sandbox" && <span className="mt-2 inline-flex rounded bg-violet-50 px-2 py-1 text-[9px] font-bold text-violet-700">SANDBOX · seu Telegram</span>}{preferredSource && <span className="mt-2 inline-flex rounded bg-blue-50 px-2 py-1 text-[9px] font-semibold text-blue-700">Preferência: {preferredSource.supplier_name}</span>}</button>{source ? <div className="mt-3 space-y-2"><ProductLink source={source} /><p className="text-[9px] text-slate-400">{preferredSource ? "Opção da internet preferida" : row.selected_product_url ? "Fornecedor selecionado" : "Menor preço coletado · seleção pendente"}</p><ReputationBadge reputation={reputation} />{safeUrl(reputation?.url) && <a href={safeUrl(reputation?.url)} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-blue-600">Ver página no ReclameAqui<ExternalLink size={10} /></a>}</div> : <p className="mt-3 text-[10px] leading-relaxed text-slate-400">{blocked ? "Nenhuma oferta verificável disponível." : row.status === "DONE" ? "Cotação concluída com fornecedor." : row.status === "NEGOTIATING" ? (row.quote ? "Cotação em andamento com fornecedor." : "Aguardando retorno do fornecedor.") : "Pesquisa e negociação em andamento."}</p>}<div className="mt-3 grid grid-cols-2 gap-2 border-t border-slate-100 pt-3"><div><p className="text-[9px] text-slate-400">Preço de mercado</p><p className="numeric mt-1 text-[11px] font-semibold text-slate-700">{brl(source?.price)}</p></div><div><p className="text-[9px] text-slate-400">{row.target_price != null ? "Meta total" : supplierValue != null ? (row.quote?.final_tco != null ? "Total fornecedor" : "Unit. fornecedor") : "Meta total"}</p><p className="numeric mt-1 text-[11px] font-semibold text-blue-700">{brl(row.target_price ?? supplierValue)}</p></div></div>{row.audit && row.hard_savings !== null && <p className="mt-3 text-[10px] font-medium text-emerald-700">{row.mode === "sandbox" ? "Economia do teste" : "Hard Savings"}: {brl(row.hard_savings)}</p>}{blocked && <div className="mt-3 border-t border-slate-100 pt-3"><p className="mb-2 text-[10px] text-amber-700">Pesquisa requer atenção</p>{row.notice && <p className="mb-3 line-clamp-3 text-[10px] leading-relaxed text-slate-500">{row.notice}</p>}<button onClick={onRetry} disabled={retrying} className="flex items-center gap-1 text-[10px] font-semibold text-blue-600 disabled:opacity-50"><RefreshCw size={11} className={retrying ? "animate-spin" : ""} />Tentar novamente</button></div>}<div className="mt-3 border-t border-slate-100 pt-3"><RequestActions id={row.id} product={row.item} canRepeat={row.status === "DONE"} compact onDeleted={deleted} onRepeated={repeated}/></div></article>;
}
function KanbanBoard({ rows, selectedId, select, retry, retrying, deleted, repeated }: { deleted: (id: string) => Promise<void>; repeated: (row: PurchaseRequest) => Promise<void>; rows: PurchaseRequest[]; selectedId?: string; select: (id: string) => void; retry: (id: string) => void; retrying: string | null }) {
  return <section id="kanban" className="scroll-mt-6"><SectionTitle eyebrow="Pipeline de compras" title="Da pesquisa à cotação"><span className="text-[10px] text-slate-400">{rows.length} solicitações · dados persistidos</span></SectionTitle><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{columns.map(column => { const cards = rows.filter(row => row.status === column.status); return <section key={column.status} aria-label={column.name} className="min-w-0 rounded-2xl border border-slate-200/80 bg-slate-50 p-3"><div className="mb-3 flex items-center gap-2 px-1 py-1"><span className={`size-1.5 rounded-full ${column.color}`} /><h3 className="text-[11px] font-semibold text-slate-600">{column.name}</h3><span className="ml-auto rounded bg-white px-1.5 text-[10px] text-slate-400">{cards.length}</span></div><div className="max-h-[440px] space-y-3 overflow-y-auto p-0.5">{cards.map(row => <PurchaseRequestCard key={row.id} row={row} selected={row.id === selectedId} onSelect={() => select(row.id)} onRetry={() => retry(row.id)} retrying={retrying === row.id} deleted={deleted} repeated={repeated} />)}{!cards.length && <p className="flex min-h-24 items-center justify-center text-[10px] text-slate-400">Nenhuma solicitação nesta etapa</p>}</div></section>; })}</div></section>;
}
export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authChecking, setAuthChecking] = useState(true);
  const { data, connection, error, syncing, refresh } = useProcurement();
  const [chatId, setChatId] = useState<string | null>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null); const [open, setOpen] = useState(false); const [retrying, setRetrying] = useState<string | null>(null); const [actionError, setActionError] = useState("");
  const [actionSuccess, setActionSuccess] = useState("");
  const openedFromHistory = useRef<string | null>(null);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("request");
    if (id && openedFromHistory.current !== id && data.runs.some(row => row.id === id)) {
      openedFromHistory.current = id; setSelectedId(id); setDrawerId(id);
      if (new URLSearchParams(window.location.search).get("repeated") === "1") setActionSuccess("Nova solicitação criada. A pesquisa de fornecedores foi iniciada.");
    }
  }, [data.runs]);
  async function deleted(id: string) {
    if (drawerId === id) setDrawerId(null);
    if (chatId === id) setChatId(null);
    if (selectedId === id) setSelectedId(null);
    const url = new URL(window.location.href);
    if (url.searchParams.get('request') === id) { url.searchParams.delete('request'); url.searchParams.delete('repeated'); window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`); }
    setActionSuccess("Solicitação excluída."); await refresh(true);
  }
  async function repeated(row: PurchaseRequest) {
    await refresh(true); setSelectedId(row.id); setDrawerId(row.id);
    setActionSuccess("Nova solicitação criada. A pesquisa de fornecedores foi iniciada.");
  }
  useEffect(() => {
    let active = true;
    const cachedUser = typeof window !== "undefined" ? window.localStorage.getItem("nexo_user") : null;
    if (cachedUser) {
      try { setUser(JSON.parse(cachedUser) as AuthUser); } catch {}
    }
    void requestJson("/auth/me")
      .then((res: any) => {
        if (!active) return;
        if (res?.user) {
          setUser(res.user as AuthUser);
          window.localStorage.setItem("nexo_user", JSON.stringify(res.user));
          setAuthChecking(false);
        } else {
          router.replace("/login");
        }
      })
      .catch(() => {
        if (!active) return;
        window.localStorage.removeItem("nexo_token");
        window.localStorage.removeItem("nexo_user");
        router.replace("/login");
      });
    return () => { active = false; };
  }, [router]);

  async function handleLogout() {
    try { await requestJson("/auth/logout", { method: "POST" }); } catch {}
    if (typeof window !== "undefined") {
      window.localStorage.removeItem("nexo_token");
      window.localStorage.removeItem("nexo_user");
    }
    router.replace("/login");
  }

  async function retry(id: string) { if (retrying !== null || connection !== "live") return; setRetrying(id); setActionError(""); try { await requestJson(`/request/${id}/retry`, { method: "POST" }); await refresh(); } catch (cause) { setActionError(cause instanceof Error ? cause.message : "Não foi possível retomar."); } finally { setRetrying(null); } }

  if (authChecking && !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0b0e14] text-slate-200">
        <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-6 py-4 backdrop-blur-xl">
          <RefreshCw size={16} className="animate-spin text-[#93e9bf]" />
          <span className="text-xs font-medium tracking-wide">Verificando sessão segura Nexo…</span>
        </div>
      </div>
    );
  }

  return <div className="min-h-screen bg-[#f5f7fb] text-slate-900 [color-scheme:light]"><a href="#dashboard" className="sr-only z-50 rounded bg-white p-3 focus:not-sr-only focus:fixed focus:left-4 focus:top-4">Ir para o conteúdo</a>
    <WorkspaceSidebar active="overview" total={data.total_runs} user={user} onLogout={() => void handleLogout()} />
    <div className="xl:ml-[218px]"><header className="flex min-h-16 items-center justify-between gap-3 border-b border-slate-200/80 bg-white px-5 sm:px-8"><div className="flex items-center gap-2 text-[11px]"><Link href="/" className="text-xl font-bold tracking-tight text-blue-600 xl:hidden">nexo.</Link><span className="hidden text-slate-400 sm:inline">Workspace /</span><span className="font-medium text-slate-700">Inteligência de compras</span></div><div className="flex items-center gap-3"><Link href="/history" className="rounded-lg px-2 py-2 text-xs font-semibold text-blue-700 xl:hidden">Histórico</Link><Link href="/settings" aria-label="Configurações" className="rounded-lg p-2 text-slate-500 hover:bg-slate-50"><Settings size={16} /></Link><span className={`inline-flex items-center gap-1.5 text-[10px] ${connection === "live" ? "text-emerald-600" : "text-amber-600"}`}><span className="size-1.5 rounded-full bg-current" />{connection === "live" ? "API conectada" : connection === "offline" ? "Sem conexão" : "Conectando…"}</span><button onClick={() => void refresh()} disabled={syncing} aria-label="Atualizar dados" className="rounded-lg border border-slate-200 p-2 text-slate-400 hover:text-blue-600"><RefreshCw size={13} className={syncing ? "animate-spin" : ""} /></button>
      <div className="flex items-center gap-2 border-l border-slate-200 pl-3">
        <UserAvatar url={user?.avatar_url} name={user?.name || "Comprador"} sizeClass="size-7" textClass="text-[10px]" />
        <span className="hidden max-w-[140px] truncate text-xs font-medium text-slate-700 md:inline">{user?.name || "Comprador"}</span>
        <button onClick={() => void handleLogout()} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-medium text-slate-600 hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600">
          <LogOut size={12} />
          <span>Sair</span>
        </button>
      </div>
    </div></header>
      <main id="dashboard" className="mx-auto max-w-[1700px] space-y-6 p-4 sm:p-7 lg:p-8"><section className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-blue-600 to-blue-400 px-6 py-7 text-white sm:px-8"><div className="pointer-events-none absolute -right-6 -top-24 size-80 rounded-full border-[45px] border-white/[0.06]" /><div className="pointer-events-none absolute right-40 top-24 size-48 rounded-full border-[30px] border-white/[0.05]" /><div className="relative flex flex-wrap items-center justify-between gap-6"><div><div className="mb-3 flex items-center gap-2 text-[9px] font-semibold uppercase tracking-[0.2em] text-blue-100"><Sparkles size={13} />Inteligência que compra melhor</div><h1 className="text-[26px] font-semibold leading-tight tracking-tight sm:text-[32px]">Menos custo. Mais clareza.</h1><p className="mt-3 max-w-xl text-xs leading-relaxed text-blue-100">Pesquise o mercado, conheça os fornecedores e acompanhe cada decisão.</p></div><button onClick={() => setOpen(true)} disabled={connection !== "live"} className="inline-flex items-center gap-2 rounded-xl bg-white px-5 py-3 text-xs font-semibold text-blue-700 shadow-lg shadow-blue-900/10 hover:bg-blue-50 disabled:opacity-50"><Plus size={17} />Nova solicitação<ArrowRight size={15} className="ml-3" /></button></div><div className="relative mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-white/15 pt-4 text-[10px] text-blue-100"><span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-emerald-300" />{data.metrics.active_count} pesquisas em andamento</span><span>{data.metrics.verified_suppliers_count} fornecedores com preços coletados</span><span className="sm:ml-auto">Preços reais · testes identificados como Sandbox</span></div></section>

        {(connection === "offline" || actionError) && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900"><span>{actionError || error} Os dados recebidos permanecem visíveis.</span><button onClick={() => void refresh()} className="font-semibold underline">Tentar novamente</button></div>}
        {actionSuccess && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-xs text-emerald-800">{actionSuccess}</p>}
        <KanbanBoard deleted={deleted} repeated={repeated} rows={data.runs} selectedId={selectedId ?? undefined} select={id => { setSelectedId(id); setDrawerId(id); }} retry={id => void retry(id)} retrying={retrying} />
        <footer className="flex flex-wrap justify-between gap-2 border-t border-slate-200 pt-4 text-[9px] text-slate-400"><span>Nexo · Procurement Intelligence</span><span>Exibindo {data.runs.length} de {data.total_runs} solicitações</span><span>Atualização a cada 5s</span></footer>
      </main>
    </div><SideDrawer deleted={deleted} repeated={repeated} row={data.runs.find(r => r.id === drawerId) || null} close={() => setDrawerId(null)} openChat={() => setChatId(drawerId)} decided={() => { void refresh(); }} /><LiveChatModal sandbox={data.runs.find(r => r.id === chatId)?.mode === "sandbox"} requestId={chatId} close={() => setChatId(null)} /><LiveDemoModal mode="live" open={open} close={() => setOpen(false)} created={async id => { setSelectedId(id); await refresh(); }} />
  </div>;
}
