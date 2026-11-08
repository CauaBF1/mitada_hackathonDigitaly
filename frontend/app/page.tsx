"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Activity,
  ArrowRight,
  Award,
  BarChart3,
  Bot,
  CalendarCheck,
  CheckCircle2,
  ClipboardCheck,
  CircleDollarSign,
  Command,
  FileCheck2,
  FolderOpen,
  Globe2,
  Layers,
  Link2,
  Lock,
  MessageSquare,
  PieChart,
  RefreshCw,
  Scale,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  Users,
  Zap,
} from "lucide-react";
import { brl, requestJson, type AuthUser, type Dashboard } from "./contracts";

interface HoverCardProps {
  href?: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  description: string;
}

function NexoHoverCard({ href, icon: Icon, title, description }: HoverCardProps) {
  const inner = (
    <div className="group flex h-full flex-col rounded-[20px] bg-white p-[22px] text-left shadow-[0_0_10px_0_rgba(0,0,0,0.45)] transition-all duration-300 hover:-translate-y-1 hover:bg-[linear-gradient(0deg,#415AFF_0%,#019CFD_100%)]">
      <div className="mb-4 flex size-[62px] items-center justify-center rounded-full bg-[#019EFD] text-white transition-colors duration-300 group-hover:bg-white group-hover:text-[#415AFF]">
        <Icon size={30} />
      </div>
      <h3 className="mb-3 text-[19px] font-black leading-snug text-[#019EFD] transition-colors duration-300 group-hover:text-white">
        {title}
      </h3>
      <p className="text-[14px] font-normal leading-relaxed text-[#121212] transition-colors duration-300 group-hover:text-white/95">
        {description}
      </p>
    </div>
  );

  if (href) {
    return (
      <a href={href} className="block h-full no-underline">
        {inner}
      </a>
    );
  }
  return inner;
}

function BluePillButton({ href, label }: { href: string; label: string }) {
  return (
    <div className="mt-10 flex w-full justify-center">
      <Link
        href={href}
        className="inline-flex w-full max-w-[560px] items-center justify-center rounded-[50px] bg-[#049DFD] px-8 py-[15px] text-center text-[16px] font-extrabold text-white shadow-lg shadow-[#049DFD]/25 transition-all duration-200 hover:scale-105 hover:bg-[#35A6DF] sm:px-[60px] sm:text-[20px]"
      >
        {label}
      </Link>
    </div>
  );
}

function WhitePillButton({ href, label, compact = false }: { href: string; label: string; compact?: boolean }) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center justify-center rounded-[50px] bg-white font-extrabold text-[#049DFD] shadow-lg transition-all duration-200 hover:scale-105 hover:bg-[#35A6DF] hover:text-white ${
        compact
          ? "px-7 py-[11px] text-[15px] sm:px-[44px] sm:text-[16px]"
          : "w-full max-w-[560px] px-8 py-[15px] text-center text-[16px] sm:px-[60px] sm:text-[20px]"
      }`}
    >
      {label}
    </Link>
  );
}

function ModuleBadge({ text }: { text: string }) {
  return (
    <div className="mb-4 inline-flex w-[175px] items-center justify-center rounded-[50px] border-2 border-white bg-[#019EFDC7] px-[10px] py-[10px] shadow-md">
      <span className="text-[20px] font-normal leading-none text-white">{text}</span>
    </div>
  );
}

function NexoBrandLogo({ light = true }: { light?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <span
        className={`flex size-10 items-center justify-center rounded-xl shadow-md ${
          light ? "bg-white text-[#049DFD]" : "bg-[#049DFD] text-white"
        }`}
      >
        <Command size={21} strokeWidth={2.5} />
      </span>
      <div className="leading-none">
        <span className="text-[28px] font-black tracking-[-0.06em] text-white">
          nexo<span className={light ? "text-white" : "text-[#019EFD]"}>.</span>
        </span>
        <span className="mt-0.5 block text-[9px] font-bold uppercase tracking-[0.2em] text-white/80">
          Procurement Intelligence
        </span>
      </div>
    </div>
  );
}

const economicPreviewQuotes = [
  { id: 'orbita', name: 'Órbita', initialUnit: 120000, unit: 98000, shipping: 20000, days: 7, reputation: '8,9' },
  { id: 'prisma', name: 'Prisma', initialUnit: 110000, unit: 102000, shipping: 0, days: 3, reputation: '8,1' },
  { id: 'atlas', name: 'Atlas', initialUnit: 100000, unit: 100000, shipping: 30000, days: 10, reputation: '9,3' },
] as const;
const previewMoney = (cents: number) => brl((cents / 100).toFixed(2));

function EconomicAnalysisPreview() {
  const [selectedId, setSelectedId] = useState<string>('orbita');
  const selected = economicPreviewQuotes.find(quote => quote.id === selectedId) ?? economicPreviewQuotes[0];
  const quantity = 10;
  const marketUnit = economicPreviewQuotes.reduce((sum, quote) => sum + quote.initialUnit, 0) / economicPreviewQuotes.length;
  const hardSavings = (selected.initialUnit - selected.unit) * quantity;
  const costAvoidance = (marketUnit - selected.unit) * quantity;
  const savingsScale = Math.max(...economicPreviewQuotes.map(quote => (quote.initialUnit - quote.unit) * quantity), 1);
  const metrics = [
    { label: 'Hard Savings', value: hardSavings, explanation: 'Primeira cotação − preço final, por quantidade', color: 'bg-emerald-400', text: 'text-emerald-300' },
    { label: 'Cost Avoidance', value: costAvoidance, explanation: 'Média de mercado − preço final, por quantidade', color: 'bg-sky-400', text: 'text-sky-300' },
  ];
  return (
    <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white text-slate-900 shadow-2xl shadow-blue-950/10">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-5 py-4 sm:px-7">
        <div className="flex items-center gap-2 text-sm font-bold"><Command size={18} className="text-[#415AFF]" />nexo<span className="text-[#019EFD]">.</span></div>
        <span className="rounded-full border border-blue-100 bg-blue-50 px-3 py-1 text-[11px] font-semibold text-blue-700">Prévia interativa · valores ilustrativos</span>
      </div>
      <div className="flex flex-wrap gap-4 border-b border-slate-100 px-5 py-3 text-[11px] sm:px-7 sm:text-xs" aria-label="Organização do workspace na prévia">
        <span className="flex items-center gap-2 font-semibold text-[#415AFF]"><PieChart size={15} />Dashboard / Análise Econômica</span>
        <span className="text-slate-500">Solicitações</span><span className="text-slate-500">Histórico</span>
      </div>
      <div className="space-y-6 p-5 sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#415AFF]">Impacto da decisão</p><h3 className="mt-2 text-xl font-bold sm:text-2xl">Cada escolha conta. Veja quanto.</h3></div>
          <span className="rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-600">Lote de {quantity} unidades · BRL</span>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="min-w-0 rounded-2xl border border-slate-200 bg-slate-50 p-5">
            <p className="flex items-center gap-2 text-xs font-semibold text-slate-500"><Search size={16} />Cotações encontradas</p>
            <p className="mt-4 text-3xl font-bold tracking-tight">{previewMoney(marketUnit)}</p><p className="mt-1 text-xs text-slate-500">Preço unitário médio · 3 opções de mercado</p>
            <div className="mt-4 flex justify-between gap-2 border-t border-slate-200 pt-3 text-xs"><span className="text-slate-500">Primeira cotação · {selected.name}</span><span className="font-semibold">{previewMoney(selected.initialUnit)}/un.</span></div>
          </div>
          <div className="min-w-0 rounded-2xl border border-[#415AFF]/25 bg-gradient-to-br from-blue-50 to-indigo-50 p-5">
            <p className="flex items-center gap-2 text-xs font-semibold text-[#415AFF]"><CheckCircle2 size={16} />Opção selecionada · {selected.name}</p>
            <p className="mt-4 text-3xl font-bold tracking-tight text-[#415AFF]">{previewMoney(selected.unit)}</p><p className="mt-1 text-xs text-slate-500">Preço unitário final negociado</p>
            <div className="mt-4 flex justify-between gap-2 border-t border-blue-100 pt-3 text-xs"><span className="text-slate-500">Total com frete · taxas zero</span><span className="font-bold text-[#415AFF]">{previewMoney(selected.unit * quantity + selected.shipping)}</span></div>
          </div>
        </div>
        <div className="rounded-2xl bg-[#101827] p-5 text-white sm:p-6" aria-label="Gráfico ilustrativo de economia nos produtos">
          <div className="mb-5 flex items-center justify-between gap-3"><h4 className="flex items-center gap-2 text-sm font-semibold"><TrendingDown size={17} />Economia em perspectiva</h4><span className="text-[10px] text-slate-400">Mesma escala em reais</span></div>
          <div className="grid gap-6 sm:grid-cols-2">{metrics.map(metric => <div key={metric.label}>
            <div className="flex flex-wrap items-baseline justify-between gap-2"><span className={`text-xs font-medium ${metric.text}`}>{metric.label}</span><span className="text-xl font-bold">{previewMoney(metric.value)}</span></div>
            <div className="mt-3 h-3 overflow-hidden rounded-full bg-white/10" role="meter" aria-label={metric.label} aria-valuemin={0} aria-valuemax={savingsScale} aria-valuenow={metric.value} aria-valuetext={previewMoney(metric.value)}><div className={`h-full rounded-full transition-all duration-500 motion-reduce:transition-none ${metric.color}`} style={{ width: `${metric.value / savingsScale * 100}%` }} /></div>
            <p className="mt-2 text-[10px] leading-relaxed text-slate-400">{metric.explanation}</p>
          </div>)}</div>
          <p className="mt-5 border-t border-white/10 pt-3 text-[10px] leading-relaxed text-slate-400">São duas referências para a mesma decisão: os indicadores não devem ser somados. Frete e taxas compõem o total da opção escolhida.</p>
        </div>
        <fieldset>
          <legend className="flex items-center gap-2 text-sm font-bold"><Scale size={18} className="text-[#415AFF]" />Preço, prazo ou reputação? Compare o equilíbrio.</legend>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">Selecione outra cotação para atualizar os gráficos. O menor preço pode ter um prazo maior.</p>
          <div className="mt-4 grid gap-3 lg:grid-cols-3">{economicPreviewQuotes.map(quote => <button key={quote.id} type="button" aria-pressed={selectedId === quote.id} onClick={() => setSelectedId(quote.id)} className={`min-w-0 rounded-2xl border p-4 text-left transition hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#415AFF] ${selectedId === quote.id ? 'border-[#415AFF] bg-indigo-50 ring-1 ring-[#415AFF]' : 'border-slate-200 bg-white hover:border-blue-300'}`}>
            <div className="flex items-center justify-between gap-2 text-xs font-bold"><span>Fornecedor {quote.name}</span>{selectedId === quote.id && <CheckCircle2 size={16} className="text-[#415AFF]" />}</div>
            <dl className="mt-4 grid grid-cols-3 gap-2"><div><dt className="text-[9px] text-slate-500">Custo total</dt><dd className="mt-1 text-[11px] font-bold">{previewMoney(quote.unit * quantity + quote.shipping)}</dd></div><div><dt className="text-[9px] text-slate-500">Entrega</dt><dd className="mt-1 text-[11px] font-bold">{quote.days} dias</dd></div><div><dt className="text-[9px] text-slate-500">ReclameAqui</dt><dd className="mt-1 text-[11px] font-bold">{quote.reputation}/10</dd></div></dl>
          </button>)}</div>
        </fieldset>
        <p className="text-[10px] leading-relaxed text-slate-400">Fornecedores, preços e notas fictícios para demonstrar a interface. No workspace, a análise usa as cotações e evidências disponíveis para cada compra.</p>
      </div>
    </div>
  );
}

export default function LandingPage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [apiOnline, setApiOnline] = useState<boolean | null>(null);
  const [totalRuns, setTotalRuns] = useState<number>(0);

  useEffect(() => {
    let mounted = true;
    void requestJson("/auth/me")
      .then((res: any) => {
        if (mounted && res?.user) setUser(res.user as AuthUser);
      })
      .catch(() => {});

    void requestJson("/godmode/dashboard")
      .then((res: any) => {
        const d = res as Dashboard;
        if (mounted && d) {
          setApiOnline(true);
          setTotalRuns(d.total_runs ?? 0);
        }
      })
      .catch(() => {
        if (mounted) setApiOnline(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  const primaryHref = user ? "/dashboard" : "/login";
  const ctaText = user ? "Acessar Painel Nexo Agora" : "Automatize seu Processo de Compras";

  return (
    <div className="min-h-screen bg-white text-[#121212] [color-scheme:light] selection:bg-[#019EFD] selection:text-white">
      {/* =====================================================================
          SECTION 1: HERO
          Gradient linear-gradient(90deg, #019EFD 0%, #415AFF 100%)
          Bottom triangle SVG shape divider
         ===================================================================== */}
      <section
        className="relative flex min-h-[82vh] flex-col justify-between overflow-hidden px-5 pb-20 pt-6 text-white"
        style={{
          backgroundImage: "linear-gradient(90deg, #019EFD 0%, #415AFF 100%)",
        }}
      >
        {/* Subtle decorative geometric rings matching Nexo dashboard banner */}
        <div className="pointer-events-none absolute -right-16 -top-28 size-[420px] rounded-full border-[55px] border-white/[0.06]" />
        <div className="pointer-events-none absolute -left-20 bottom-10 size-[320px] rounded-full border-[40px] border-white/[0.05]" />

        {/* Top Header Row inside Hero */}
        <header className="relative z-10 mx-auto flex w-full max-w-[1140px] flex-wrap items-center justify-between gap-4 pb-6">
          <Link href="/" className="transition-transform duration-200 hover:scale-105">
            <NexoBrandLogo light />
          </Link>

          <nav className="hidden items-center gap-6 text-[14px] font-semibold text-white/95 lg:flex">
            <a href="#modulo-1" className="transition hover:text-white hover:underline">
              Descoberta IA
            </a>
            <a href="#modulo-2" className="transition hover:text-white hover:underline">
              Compliance & TCO
            </a>
            <a href="#modulo-3" className="transition hover:text-white hover:underline">
              Telegram Bot
            </a>
            <a href="#modulo-4" className="transition hover:text-white hover:underline">
              Análise Econômica
            </a>
            <a href="#beneficios" className="transition hover:text-white hover:underline">
              Benefícios
            </a>
          </nav>

          <div className="flex items-center gap-3">
            {!user && (
              <Link
                href="/register"
                className="hidden rounded-[50px] border-2 border-white px-6 py-[9px] text-[15px] font-extrabold text-white transition-all duration-200 hover:scale-105 hover:bg-white hover:text-[#049DFD] sm:inline-flex"
              >
                Criar Conta
              </Link>
            )}
            <WhitePillButton
              href={primaryHref}
              label={user ? `Dashboard (${user.name.split(" ")[0]})` : "Entrar na Plataforma"}
              compact
            />
          </div>
        </header>

        {/* Hero Center Content */}
        <div className="relative z-10 mx-auto my-auto flex w-full max-w-[1140px] flex-col items-center py-10 text-center">
          <h1 className="text-[42px] font-black leading-[1.08] tracking-tight text-white sm:text-[62px] lg:text-[75px]">
            Compre com inteligência.
            <br /><span className="text-white/85">Veja o impacto de cada decisão.</span>
          </h1>
          <p className="mt-6 max-w-[92%] text-[15px] font-medium leading-relaxed text-white sm:text-[17px]">
            Pesquise fornecedores, negocie com IA e transforme cada escolha em inteligência econômica. Compare cotações e visualize, em relatórios e gráficos instantâneos, a economia negociada, os custos evitados e o impacto financeiro da sua decisão.
          </p>

          <div className="mt-10 flex w-full flex-col items-center justify-center gap-4 sm:flex-row">
            <WhitePillButton href={primaryHref} label={ctaText} />
          </div>
        </div>

        {/* Bottom Triangle SVG Shape Divider */}
        <div
          className="pointer-events-none absolute bottom-0 left-0 w-full overflow-hidden leading-none"
          aria-hidden="true"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 1000 100"
            preserveAspectRatio="none"
            className="block h-[40px] w-full"
          >
            <path className="fill-white" d="M500,98.9L0,6.1V0h1000v6.1L500,98.9z" />
          </svg>
        </div>
      </section>

      {/* =====================================================================
          SECTION 2: PLATAFORMA UNIFICADA
          White background, 4 clickable hover-gradient cards + Blue Pill CTA
         ===================================================================== */}
      <section className="bg-white px-5 pb-[70px] pt-[50px]">
        <div className="mx-auto max-w-[1140px]">
          <div className="mx-auto max-w-[90%] text-center">
            <h2 className="text-[28px] font-semibold leading-tight text-black sm:text-[40px]">
              Uma Plataforma Unificada de Inteligência em Compras
            </h2>
            <p className="mt-4 pb-6 text-[15px] font-normal leading-relaxed text-[#404040] sm:text-[19px]">
              O Nexo é uma plataforma modular projetada para otimizar compras corporativas e cotações B2B. Da pesquisa à escolha final, reúne reputação, negociação e custo total em um só fluxo. O Dashboard Econômico transforma as cotações em comparativos visuais para você entender o retorno da negociação e decidir com clareza.
            </p>
          </div>

          <div className="mt-4 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            <NexoHoverCard
              href="#modulo-1"
              icon={Search}
              title="Descoberta Autônoma"
              description="Nossa solução pesquisa automaticamente o mercado público, extraindo preços reais de produtos com links, método de coleta e hash SHA-256."
            />
            <NexoHoverCard
              href="#modulo-2"
              icon={ShieldCheck}
              title="Compliance & TCO Real"
              description="Nossa solução gerencia todo o ciclo de validação, desde a reputação no ReclameAqui até o cálculo completo de Produto + Frete + Taxas."
            />
            <NexoHoverCard
              href="#modulo-3"
              icon={MessageSquare}
              title="Negociação Omnichannel"
              description="Nossa solução substitui trocas manuais de mensagens por um bot Telegram inteligente que coleta e confirma cotações em tempo real."
            />
            <NexoHoverCard
              href="#modulo-4"
              icon={PieChart}
              title="Dashboard Econômico & Análise de Decisão"
              description="Compare a opção escolhida com o mercado e veja imediatamente o impacto da decisão em gráficos de Hard Savings, Cost Avoidance e custo total."
            />
          </div>

          <BluePillButton href={primaryHref} label={ctaText} />
        </div>
      </section>

      {/* =====================================================================
          SECTION 3: IMPACT BANNER
          Gradient background linear-gradient(0deg, #019EFD 0%, #415AFF 100%)
          Left #101827 dark box with 80px numbers + Right check list
         ===================================================================== */}
      <section
        className="px-5 py-[60px] text-white"
        style={{ backgroundImage: "linear-gradient(0deg, #019EFD 0%, #415AFF 100%)" }}
      >
        <div className="mx-auto grid max-w-[1140px] items-center gap-8 lg:grid-cols-12">
          {/* Left Dark Card (#101827) */}
          <div className="rounded-[20px] bg-[#101827] px-7 py-8 shadow-2xl lg:col-span-6">
            <h2 className="text-center text-[24px] font-extrabold leading-snug text-white sm:text-[33px]">
              Não é apenas IA.
              <br />É eficiência e resultados.
            </h2>

            <div className="mt-8 grid grid-cols-2 gap-4 text-center">
              <div>
                <p className="numeric text-[48px] font-black leading-none text-white sm:text-[80px]">90%</p>
                <p className="mt-3 text-[14px] font-semibold text-white sm:text-[16px]">
                  Redução de tempo em cotações
                </p>
              </div>
              <div>
                <p className="numeric text-[48px] font-black leading-none text-white sm:text-[80px]">100%</p>
                <p className="mt-3 text-[14px] font-semibold text-white sm:text-[16px]">
                  TCO auditado com fonte real
                </p>
              </div>
            </div>
          </div>

          {/* Right Column */}
          <div className="space-y-6 px-2 lg:col-span-6">
            <h2 className="text-[28px] font-semibold leading-tight text-white sm:text-[45px]">
              Integração perfeita <br />
              em todas as etapas.
            </h2>

            <ul className="space-y-4 text-[15px] font-medium leading-relaxed text-white sm:text-[17px]">
              <li className="flex items-start gap-3">
                <CheckCircle2 size={22} className="mt-1 shrink-0 text-white" />
                <span>
                  Simplifique o processo inicial de requisição e elimine cotações incompletas, liberando sua equipe de suprimentos para se concentrar em negociações estratégicas de maior valor.
                </span>
              </li>
              <li className="flex items-start gap-3">
                <CheckCircle2 size={22} className="mt-1 shrink-0 text-white" />
                <span>
                  Inteligência Artificial aplicada à gestão de compras. Para garantir a robustez e a precisão do nosso Agente, combinamos busca real na web, extração determinística e modelos LLM de última geração.
                </span>
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* =====================================================================
          SECTION 4: MÓDULO 01 (id="modulo-1")
         ===================================================================== */}
      <section id="modulo-1" className="scroll-mt-10 bg-white px-6 pb-[50px] pt-[45px]">
        <div className="mx-auto max-w-[1140px]">
          <ModuleBadge text="Módulo 01" />
          <h2 className="text-[32px] font-semibold leading-tight text-black sm:text-[42px]">
            Descoberta Autônoma de Fornecedores
          </h2>
          <h3 className="mt-1 text-[18px] font-semibold text-[#7B7B7B] sm:text-[30px]">
            Pesquisa de mercado e extração estruturada
          </h3>
          <p className="mt-4 text-[15px] font-normal leading-relaxed text-[#2B2B2B] sm:text-[17px]">
            A Descoberta Autônoma conecta solicitações de compra a agentes inteligentes em LangGraph que vasculham fontes públicas, extraem ofertas reais (Schema.org, Microdata, OpenGraph) e registram evidências auditáveis.
          </p>

          {/* 2-Column Icon List with dividers */}
          <div className="mt-8 grid gap-8 md:grid-cols-2">
            <ul className="divide-y divide-[#ddd]">
              {[
                { icon: ClipboardCheck, text: "Cadastro estruturado de item, especificações, quantidade e CEP" },
                { icon: Search, text: "Busca pública automatizada via Tavily com controle de créditos" },
                { icon: FileCheck2, text: "Extração determinística de preços via Schema.org e OpenGraph" },
                { icon: Lock, text: "Assinatura criptográfica SHA-256 de cada página de oferta coletada" },
              ].map(item => (
                <li key={item.text} className="flex items-center gap-3.5 py-4 text-[15px] text-black">
                  <item.icon size={22} className="shrink-0 text-[#019EFD]" />
                  <span>{item.text}</span>
                </li>
              ))}
            </ul>
            <ul className="divide-y divide-[#ddd]">
              {[
                { icon: FolderOpen, text: "Rastreamento completo de candidatos analisados e motivos de descarte" },
                { icon: CalendarCheck, text: "Registro de timestamp exato de observação da oferta na loja" },
                { icon: ShieldAlert, text: "Detecção automática de bloqueios anti-bot (HTTP 403) com aviso claro" },
                { icon: Activity, text: "Atualização em tempo real no quadro Kanban a cada 5 segundos" },
              ].map(item => (
                <li key={item.text} className="flex items-center gap-3.5 py-4 text-[15px] text-black">
                  <item.icon size={22} className="shrink-0 text-[#019EFD]" />
                  <span>{item.text}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Benefícios do Módulo 01 */}
          <div className="mt-10">
            <h3 className="mb-6 text-[28px] font-extrabold text-black sm:text-[40px]">Benefícios</h3>
            <div className="grid gap-6 md:grid-cols-3">
              <NexoHoverCard
                icon={Zap}
                title="Eficiência Operacional e Produtividade"
                description="A solução automatiza a pesquisa de mercado e reduz drasticamente a cotação manual. Com processos 100% digitais, diminui falhas humanas e acelera a coleta de referências reais."
              />
              <NexoHoverCard
                icon={Users}
                title="Gestão Completa para o Comprador"
                description="A equipe deixa de perder horas copiando links de lojas e passa a atuar na análise crítica, negociação e tomada de decisão estratégica com dados estruturados."
              />
              <NexoHoverCard
                icon={Award}
                title="Transparência e Fonte Verificável"
                description="Cada preço apresentado possui link direto para a oferta original, método de extração identificado e comprovação íntegra para auditoria interna."
              />
            </div>
          </div>

          <BluePillButton href={primaryHref} label={ctaText} />
        </div>
      </section>

      {/* =====================================================================
          SECTION 5: MÓDULO 02 (id="modulo-2")
         ===================================================================== */}
      <section id="modulo-2" className="scroll-mt-10 bg-white px-6 pb-[50px] pt-[25px]">
        <div className="mx-auto max-w-[1140px]">
          <ModuleBadge text="Módulo 02" />
          <h2 className="text-[32px] font-semibold leading-tight text-black sm:text-[42px]">
            Compliance, Reputação e Cálculo de TCO
          </h2>
          <h3 className="mt-1 text-[18px] font-semibold text-[#7B7B7B] sm:text-[30px]">
            Zero Decisão no Escuro
          </h3>
          <p className="mt-4 text-[15px] font-normal leading-relaxed text-[#2B2B2B] sm:text-[17px]">
            Automatiza todo o ciclo de validação de propostas e cálculo de{" "}
            <b>Hard Savings, Cost Avoidance e TCO (Produto + Frete + Taxas)</b> — da consulta de reputação à aprovação final. Maximize a economia sem custos ocultos.
          </p>

          <div className="mt-8 grid gap-8 md:grid-cols-2">
            <ul className="divide-y divide-[#ddd]">
              <li className="flex items-start gap-3.5 py-4 text-[15px] text-black">
                <ClipboardCheck size={22} className="mt-1 shrink-0 text-[#019EFD]" />
                <span>
                  <b>Fórmula de TCO Determinística</b>
                  <br />
                  Calcula <code className="text-[#019EFD]">qty × unit_price + shipping + fees</code> em centavos inteiros seguros somente quando todos os itens estão confirmados.
                </span>
              </li>
              <li className="flex items-start gap-3.5 py-4 text-[15px] text-black">
                <ShieldCheck size={22} className="mt-1 shrink-0 text-[#019EFD]" />
                <span>
                  <b>Verificação de Reputação no ReclameAqui</b>
                  <br />
                  Validação em tempo real da nota e índice de solução do domínio do fornecedor antes da compra.
                </span>
              </li>
              <li className="flex items-start gap-3.5 py-4 text-[15px] text-black">
                <RefreshCw size={22} className="mt-1 shrink-0 text-[#019EFD]" />
                <span>
                  <b>Trava de Elegibilidade Automática</b>
                  <br />
                  Impede decisões sobre propostas com frete pendente, taxas não informadas, prazo incerto ou estoque insuficiente.
                </span>
              </li>
            </ul>

            <ul className="divide-y divide-[#ddd]">
              <li className="flex items-start gap-3.5 py-4 text-[15px] text-black">
                <Link2 size={22} className="mt-1 shrink-0 text-[#019EFD]" />
                <span>
                  <b>Confirmação de Produto e CEP de Destino</b>
                  <br />
                  Exige confirmação explícita de que o fornecedor atende exatamente à especificação e entrega no CEP solicitado.
                </span>
              </li>
              <li className="flex items-start gap-3.5 py-4 text-[15px] text-black">
                <Scale size={22} className="mt-1 shrink-0 text-[#019EFD]" />
                <span>
                  <b>Ordenação Inteligente de Propostas</b>
                  <br />
                  Classifica fornecedores elegíveis por menor TCO crescente e, em caso de empate, por menor prazo de entrega.
                </span>
              </li>
              <li className="flex items-start gap-3.5 py-4 text-[15px] text-black">
                <TrendingDown size={22} className="mt-1 shrink-0 text-[#019EFD]" />
                <span>
                  <b>Auditoria de Economia Real</b>
                  <br />
                  Registra o parecer completo da decisão humana, separando testes Sandbox dos indicadores financeiros reais.
                </span>
              </li>
            </ul>
          </div>

          {/* Benefícios do Módulo 02 */}
          <div className="mt-10">
            <h3 className="mb-6 text-[28px] font-extrabold text-black sm:text-[40px]">Benefícios</h3>
            <div className="grid gap-6 md:grid-cols-3">
              <NexoHoverCard
                icon={ShieldCheck}
                title="Mitigação de Riscos com Fornecedores"
                description="Evite compras com lojas sem reputação verificada ou com surpresas de frete e impostos após o fechamento do pedido."
              />
              <NexoHoverCard
                icon={BarChart3}
                title="Governança e Compliance Auditável"
                description="Controle de concorrência otimista por versão na API NestJS: nenhuma proposta decidida pode ser adulterada retroativamente."
              />
              <NexoHoverCard
                icon={Scale}
                title="Comparação Justa Pela Base Total"
                description="Compare propostas na mesma régua: o painel destaca claramente quem tem o menor custo total entregue no seu endereço."
              />
            </div>
          </div>

          <BluePillButton href={primaryHref} label={ctaText} />
        </div>
      </section>

      {/* =====================================================================
          SECTION 6: MÓDULO 03 (id="modulo-3")
         ===================================================================== */}
      <section id="modulo-3" className="scroll-mt-10 bg-white px-6 pb-[50px] pt-[25px]">
        <div className="mx-auto max-w-[1140px]">
          <ModuleBadge text="Módulo 03" />
          <h2 className="text-[32px] font-semibold leading-tight text-black sm:text-[42px]">
            Negociação Omnichannel via Telegram
          </h2>
          <h3 className="mt-1 text-[18px] font-semibold text-[#7B7B7B] sm:text-[30px]">
            Automação Inteligente de Contato e Cotações
          </h3>
          <p className="mt-4 text-[15px] font-normal leading-relaxed text-[#2B2B2B] sm:text-[17px]">
            Substitui cobranças manuais repetitivas por automação orientada por IA via Webhook Telegram. Alcance níveis inéditos de velocidade, transparência e organização no recebimento de propostas comerciais.
          </p>

          <div className="mt-8 grid gap-6 md:grid-cols-2">
            {[
              {
                title: "Interpretação em Linguagem Natural",
                desc: "O fornecedor responde normalmente no chat e o agente Python extrai preço unitário, frete, taxas, prazo e estoque.",
                icon: Bot,
              },
              {
                title: "Cobrança Automática de Dados Faltantes",
                desc: "Se o fornecedor esquecer de informar o frete ou prazo, o bot responde automaticamente solicitando apenas os itens pendentes.",
                icon: MessageSquare,
              },
              {
                title: "Modo Live Demo Sandbox no Celular",
                desc: "Teste a negociação em tempo real usando seu próprio Telegram como fornecedor, mantendo os dados de teste isolados.",
                icon: Sparkles,
              },
              {
                title: "Processamento Idempotente e Seguro",
                desc: "Validação de secret token no gateway, fila de retentativas e proteção contra mensagens duplicadas no SQLite.",
                icon: Lock,
              },
            ].map(box => (
              <div
                key={box.title}
                className="flex items-start gap-4 rounded-[20px] border-2 border-[#019EFD]/30 bg-white p-6 shadow-[0_0_10px_0_rgba(0,0,0,0.12)] transition hover:border-[#019EFD]"
              >
                <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-[#019EFD] text-white">
                  <box.icon size={22} />
                </div>
                <div>
                  <h4 className="text-[17px] font-bold text-black">{box.title}</h4>
                  <p className="mt-1 text-[14px] leading-relaxed text-[#404040]">{box.desc}</p>
                </div>
              </div>
            ))}
          </div>

          <BluePillButton href={primaryHref} label={ctaText} />
        </div>
      </section>

      {/* =====================================================================
          SECTION 7: MÓDULO 04 (id="modulo-4")
         ===================================================================== */}
      <section id="modulo-4" className="scroll-mt-10 bg-white px-6 pb-[60px] pt-[25px]">
        <div className="mx-auto max-w-[1140px]">
          <ModuleBadge text="Módulo 04" />
          <h2 className="text-[32px] font-semibold leading-tight text-black sm:text-[42px]">
            Dashboard Econômico & Análise de Decisão
          </h2>
          <h3 className="mt-1 text-[18px] font-semibold text-[#7B7B7B] sm:text-[30px]">
            Da cotação ao impacto financeiro, em uma visão.
          </h3>
          <p className="mt-4 text-[15px] font-normal leading-relaxed text-[#2B2B2B] sm:text-[17px]">
            Entenda o que sua escolha representa. O Dashboard / Análise Econômica compara as cotações encontradas com a opção selecionada e apresenta relatórios e gráficos do impacto financeiro, com o contexto de prazo e reputação que uma planilha de preços não mostra.
          </p>

          <div className="mt-8 grid gap-8 md:grid-cols-2">
            <ul className="divide-y divide-[#ddd]">
              {[
                { icon: BarChart3, text: "Comparativo visual entre cotações de mercado e a opção selecionada" },
                { icon: TrendingDown, text: "Hard Savings e Cost Avoidance com suas referências de cálculo" },
                { icon: Scale, text: "Análise de trade-off entre preço, prazo de entrega e reputação ReclameAqui" },
              ].map(item => (
                <li key={item.text} className="flex items-center gap-3.5 py-4 text-[15px] text-black">
                  <item.icon size={22} className="shrink-0 text-[#019EFD]" />
                  <span>{item.text}</span>
                </li>
              ))}
            </ul>
            <ul className="divide-y divide-[#ddd]">
              {[
                { icon: CircleDollarSign, text: "Custo total da escolha, incluindo produtos, frete e taxas" },
                { icon: FileCheck2, text: "Relatórios visuais instantâneos com contexto para justificar a decisão" },
                { icon: PieChart, text: "Aba dedicada no workspace, ao lado de Solicitações e Histórico" },
              ].map(item => (
                <li key={item.text} className="flex items-center gap-3.5 py-4 text-[15px] text-black">
                  <item.icon size={22} className="shrink-0 text-[#019EFD]" />
                  <span>{item.text}</span>
                </li>
              ))}
            </ul>
          </div>

          <div id="analise-economica" className="mt-10 scroll-mt-8"><EconomicAnalysisPreview /></div>

          <div className="mt-10">
            <h3 className="text-[22px] font-semibold text-black sm:text-[28px]">
              Inteligência Analítica Multidimensional
            </h3>
            <p className="mt-1 text-[15px] text-[#404040]">
              Compare as dimensões da compra em conjunto e visualize o que muda ao escolher outro fornecedor:
            </p>

            {/* 4 Gradient Boxes */}
            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {[
                "Preço Unitário & Escala",
                "Frete & Taxas por CEP",
                "Reputação ReclameAqui",
                "Prazo & Estoque Real",
              ].map(label => (
                <div
                  key={label}
                  className="flex min-h-[90px] items-center justify-center rounded-[20px] px-5 py-6 text-center shadow-lg transition hover:scale-[1.02]"
                  style={{ backgroundImage: "linear-gradient(0deg, #019EFD 0%, #415AFF 100%)" }}
                >
                  <h4 className="text-[18px] font-bold text-white">{label}</h4>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-8 flex justify-center"><Link href={user ? "/dashboard/analise-economica" : "/login"} className="inline-flex items-center gap-3 rounded-full bg-gradient-to-r from-[#019EFD] to-[#415AFF] px-6 py-4 text-sm font-bold text-white shadow-lg shadow-blue-500/20 transition hover:-translate-y-0.5 sm:text-base">Explorar a análise econômica<ArrowRight size={18} /></Link></div>
        </div>
      </section>

      {/* =====================================================================
          SECTION 8: BENEFÍCIOS DO NEXO (id="beneficios")
          Background #E9E9E9, 6 Hover-Gradient Cards in 3x2 grid
         ===================================================================== */}
      <section id="beneficios" className="scroll-mt-10 bg-[#E9E9E9] px-5 pb-[60px] pt-[70px]">
        <div className="mx-auto max-w-[1140px]">
          <div className="text-center">
            <h2 className="text-[28px] font-bold text-black sm:text-[40px]">
              Benefícios do Nexo Procurement
            </h2>
            <p className="mt-2 text-[16px] text-[#404040]">
              Uma plataforma abrangente desenvolvida para os desafios reais das operações de compras e cotações B2B.
            </p>
          </div>

          <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            <NexoHoverCard
              icon={Layers}
              title="Gráficos que Explicam a Decisão"
              description="Transforme cotações em comparativos visuais e relatórios instantâneos do impacto econômico de cada escolha."
            />
            <NexoHoverCard
              icon={Globe2}
              title="Integração Omnichannel Fluida"
              description="Conexão nativa com busca pública Tavily, Google OAuth2 e negociação em tempo real via Webhook Telegram."
            />
            <NexoHoverCard
              icon={Zap}
              title="Redução de Processos Manuais"
              description="Elimine planilhas descentralizadas e coletas manuais repetitivas, liberando os compradores para decisões de alto impacto."
            />
            <NexoHoverCard
              icon={Activity}
              title="Maior Eficiência Operacional"
              description="Acompanhe todas as solicitações em um pipeline Kanban ao vivo com atualização automática e histórico de mensagens."
            />
            <NexoHoverCard
              icon={ShieldCheck}
              title="Conformidade e Auditoria Completa"
              description="Travas determinísticas exigem confirmação de produto, CEP, frete, taxas, prazo e estoque antes de liberar qualquer decisão."
            />
            <NexoHoverCard
              icon={BarChart3}
              title="Retorno Financeiro Visível"
              description="Veja Hard Savings, Cost Avoidance e custo total com suas referências. Entenda o resultado da negociação antes de aprovar a compra."
            />
          </div>
        </div>
      </section>

      {/* =====================================================================
          SECTION 9: FINAL CTA BANNER
          Background linear-gradient(0deg, #019EFD 0%, #415AFF 100%) + White Pill Button
         ===================================================================== */}
      <section
        className="px-5 pb-[65px] pt-[70px] text-center text-white"
        style={{ backgroundImage: "linear-gradient(0deg, #019EFD 0%, #415AFF 100%)" }}
      >
        <div className="mx-auto flex max-w-[1140px] flex-col items-center">
          <h2 className="max-w-3xl text-[26px] font-extrabold leading-tight text-white sm:text-[38px]">
            Transforme suas Operações de Compras com Automação Inteligente
          </h2>
          <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-white/95 sm:text-[18px]">
            Unifique pesquisa, reputação e negociação com uma análise visual do impacto econômico. Compare alternativas, entenda os números e escolha com confiança no Nexo.
          </p>

          <div className="mt-9 flex w-full justify-center">
            <WhitePillButton href={primaryHref} label={ctaText} />
          </div>
        </div>
      </section>

      {/* =====================================================================
          SECTION 10: FOOTER 100% NEXO
          Background #101827, Nexo Brand, Módulos, Acesso Rápido & Status da API
         ===================================================================== */}
      <footer className="bg-[#101827] px-6 py-12 text-white">
        <div className="mx-auto max-w-[1140px]">
          <div className="grid gap-10 md:grid-cols-12">
            {/* Col 1: Nexo Brand & API Status */}
            <div className="space-y-4 md:col-span-4">
              <NexoBrandLogo light={false} />
              <p className="text-xs leading-relaxed text-slate-300">
                Plataforma de compras autônomas, análise de reputação de fornecedores, negociação omnichannel e decisão humana assistida com TCO verificável.
              </p>
              <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3.5 py-1.5 text-xs font-semibold text-slate-200">
                <span
                  className={`size-2 rounded-full ${
                    apiOnline === true
                      ? "bg-emerald-400"
                      : apiOnline === false
                      ? "bg-amber-400"
                      : "bg-[#019EFD]"
                  }`}
                />
                <span>
                  {apiOnline === true
                    ? `API Nexo Conectada · ${totalRuns} solicitações`
                    : apiOnline === false
                    ? "API Nexo Offline"
                    : "Verificando status da API…"}
                </span>
              </div>
            </div>

            {/* Col 2: Módulos do Sistema */}
            <div className="space-y-3 md:col-span-4">
              <h2 className="text-[20px] font-bold text-white">Módulos do Nexo</h2>
              <ul className="space-y-2 text-[15px] font-medium text-slate-300">
                <li>
                  <a href="#modulo-1" className="transition hover:text-[#019EFD]">
                    Módulo 01 · Descoberta Autônoma
                  </a>
                </li>
                <li>
                  <a href="#modulo-2" className="transition hover:text-[#019EFD]">
                    Módulo 02 · Compliance & TCO Real
                  </a>
                </li>
                <li>
                  <a href="#modulo-3" className="transition hover:text-[#019EFD]">
                    Módulo 03 · Negociação via Telegram
                  </a>
                </li>
                <li>
                  <a href="#modulo-4" className="transition hover:text-[#019EFD]">
                    Módulo 04 · Dashboard Econômico
                  </a>
                </li>
                <li>
                  <a href="#beneficios" className="transition hover:text-[#019EFD]">
                    Benefícios da Plataforma
                  </a>
                </li>
              </ul>
            </div>

            {/* Col 3: Acesso Rápido & Arquitetura */}
            <div className="space-y-3 md:col-span-4">
              <h2 className="text-[20px] font-bold text-white">Acesso Rápido</h2>
              <ul className="space-y-2 text-[15px] font-medium text-slate-300">
                <li>
                  <Link href="/dashboard/analise-economica" className="font-bold text-[#019EFD] hover:underline">
                    Dashboard / Análise Econômica
                  </Link>
                </li>
                <li>
                  <Link href="/login" className="transition hover:text-[#019EFD]">
                    Entrar na Conta
                  </Link>
                </li>
                <li>
                  <Link href="/register" className="transition hover:text-[#019EFD]">
                    Criar Conta Corporativa
                  </Link>
                </li>
                <li>
                  <Link href="/settings" className="transition hover:text-[#019EFD]">
                    Conexões e Contatos
                  </Link>
                </li>
              </ul>
              <p className="pt-2 text-xs text-slate-400">
                Arquitetura ativa: API NestJS + SQLite · Agentes Python (LangGraph + Gemini) · Next.js App Router.
              </p>
            </div>
          </div>

          <div className="mt-10 border-t border-white/15 pt-6 text-center text-[12px] text-slate-400">
            ©2026 Nexo · Inteligência de Compras. Todos os direitos reservados.
          </div>
        </div>
      </footer>
    </div>
  );
}
