"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Activity,
  Award,
  BarChart3,
  Bot,
  CalendarCheck,
  CheckCircle2,
  ClipboardCheck,
  Command,
  Cpu,
  Database,
  FileCheck2,
  FolderOpen,
  Globe2,
  Layers,
  Link2,
  Lock,
  MessageSquare,
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
import { requestJson, type AuthUser, type Dashboard } from "./contracts";

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
          Gradient linear-gradient(90deg, #059FFD 0%, #4B53FD 100%)
          Bottom triangle SVG shape divider
         ===================================================================== */}
      <section
        className="relative flex min-h-[82vh] flex-col justify-between overflow-hidden px-5 pb-20 pt-6 text-white"
        style={{
          backgroundImage: "linear-gradient(90deg, #059FFD 0%, #4B53FD 100%)",
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
              Agente Analítico
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
            Conheça o Nexo
          </h1>
          <p className="mt-6 max-w-[92%] text-[15px] font-medium leading-relaxed text-white sm:text-[17px]">
            Uma plataforma de Inteligência de Compras com IA que conecta descoberta autônoma de fornecedores, auditoria de reputação no ReclameAqui, negociação omnichannel via Telegram e cálculo determinístico de TCO para automatizar cotações B2B, reduzir esforço manual e gerar economia real comprovada — trazendo mais eficiência, controle operacional e valor estratégico para sua equipe de compras.
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
              O Nexo é uma plataforma modular projetada para otimizar compras corporativas e cotações B2B. Ele elimina buscas manuais repetitivas, integra agentes autônomos em LangGraph, verifica reputação de fornecedores, automatiza negociações via Telegram e aplica Inteligência Artificial para melhorar a governança, a conformidade e o desempenho financeiro (TCO).
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
              icon={Bot}
              title="Agente Analítico"
              description="Nosso Agente de IA em LangGraph + Gemini atua em todas as etapas críticas da compra, garantindo Hard Savings e Cost Avoidance auditáveis."
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
            Agente Analítico & Arquitetura
          </h2>
          <h3 className="mt-1 text-[18px] font-semibold text-[#7B7B7B] sm:text-[30px]">
            A Tecnologia Por Trás da Inovação
          </h3>
          <p className="mt-4 text-[15px] font-normal leading-relaxed text-[#2B2B2B] sm:text-[17px]">
            O núcleo de inteligência do Nexo combina três serviços isolados (API NestJS, Agentes Python LangGraph e Next.js) com múltiplos modelos de IA (Gemini 3.8 Flash e Groq Llama 3.3) para analisar propostas com precisão sem precedentes.
          </p>

          <div className="mt-8 grid gap-8 md:grid-cols-2">
            <ul className="divide-y divide-[#ddd]">
              {[
                { icon: ShieldAlert, text: "Detecção automática de inconsistências e divergências de especificação" },
                { icon: MessageSquare, text: "Interação em linguagem natural via Telegram ou comando direto /quote" },
                { icon: Layers, text: "Modo Sandbox isolado para simulação ao vivo de cenários de compra" },
              ].map(item => (
                <li key={item.text} className="flex items-center gap-3.5 py-4 text-[15px] text-black">
                  <item.icon size={22} className="shrink-0 text-[#019EFD]" />
                  <span>{item.text}</span>
                </li>
              ))}
            </ul>
            <ul className="divide-y divide-[#ddd]">
              {[
                { icon: Database, text: "Bancos SQLite separados para dados de negócio e checkpoints de agentes" },
                { icon: FileCheck2, text: "Relatórios de auditoria e justificativas factuais automatizadas" },
                { icon: Cpu, text: "Memória tática de fornecedores e histórico de concessões anteriores" },
              ].map(item => (
                <li key={item.text} className="flex items-center gap-3.5 py-4 text-[15px] text-black">
                  <item.icon size={22} className="shrink-0 text-[#019EFD]" />
                  <span>{item.text}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-10">
            <h3 className="text-[22px] font-semibold text-black sm:text-[28px]">
              Inteligência Analítica Multidimensional
            </h3>
            <p className="mt-1 text-[15px] text-[#404040]">
              Nossa IA analisa múltiplas dimensões de cada cotação para fornecer comparativos precisos e insights acionáveis:
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

          <BluePillButton href={primaryHref} label={ctaText} />
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
              title="Arquitetura Modular e Escalável"
              description="Três serviços desacoplados em containers Docker (API NestJS, Agentes Python e Frontend Next.js) prontos para escalar."
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
              title="Inteligência Financeira para TCO"
              description="Cálculo transparente de Hard Savings, Cost Avoidance e Custo Total de Propriedade auditado com evidências SHA-256."
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
            Unifique descoberta de fornecedores, auditoria de reputação, negociação via Telegram e cálculo de TCO em uma única plataforma movida por IA. Acesse agora o Nexo.
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
                    Módulo 04 · Agente Analítico
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
                  <Link href="/dashboard" className="font-bold text-[#019EFD] hover:underline">
                    Acessar Dashboard Nexo
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
