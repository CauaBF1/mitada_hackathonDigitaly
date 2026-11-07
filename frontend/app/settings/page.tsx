"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { Check, ExternalLink, Globe2, LoaderCircle, RefreshCw, X } from "lucide-react";
import { requestJson, safeUrl } from "../contracts";

interface SearchConnection { connection_status: string; last_verified_at: string | null; error_code: string | null; balance_is_historical: boolean; configured: boolean; verified: boolean; active_provider: string; plan: string | null; credits_remaining: number | null; free_plan: boolean | null; message: string }
function SearchIntegration() {
  const [connection, setConnection] = useState<SearchConnection | null>(null);
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void requestJson("/integrations/search", { signal: controller.signal }).then(value => setConnection(value as SearchConnection)).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "A API atual não disponibiliza diagnóstico da busca."); });
    return () => controller.abort();
  }, []);
  async function connect(event: FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setError("");
    try {
      const value = await requestJson("/integrations/search", { method: "POST", headers: { "Content-Type": "application/json", "X-Nexo-Settings": "1" }, body: JSON.stringify({ api_key: key.trim() }) });
      setConnection(value as SearchConnection); setKey(""); setEditing(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível conectar."); }
    finally { setBusy(false); }
  }
  async function verify() {
    setBusy(true); setError("");
    try { setConnection(await requestJson("/integrations/search") as SearchConnection); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível verificar o saldo."); }
    finally { setBusy(false); }
  }
  const connected = connection?.active_provider === "tavily" && connection.verified;
  return <section aria-label="Provedor de busca" className="rounded-2xl border border-blue-100 bg-white p-5"><div className="flex flex-wrap items-center justify-between gap-4"><div className="flex items-start gap-3"><span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600"><Globe2 size={20} /></span><div><div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-semibold">Busca real com Tavily</h2><span className={`rounded px-2 py-0.5 text-[9px] font-semibold ${connected ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>{busy ? "Verificando…" : connected ? "Credencial validada" : connection?.connection_status === "temporary_failure" ? "Verificação indisponível" : connection?.configured ? "Busca pausada" : "Aguardando chave"}</span></div><p className="mt-1 text-[11px] leading-relaxed text-slate-500">{connected ? `${connection.credits_remaining?.toLocaleString("pt-BR")} créditos disponíveis · plano ${connection.plan}` : (connection?.configured ? "Chave salva. A verificação do saldo é independente da coleta nas lojas." : "Plano gratuito: 1.000 créditos por mês, sem cartão. É necessário criar uma conta e obter sua chave.")}</p><a href="https://docs.tavily.com/documentation/api-credits" target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-[10px] text-blue-600 hover:underline">Limites e condições do provedor<ExternalLink size={10} /></a></div></div><div className="flex gap-2">{connection?.configured && <button onClick={() => void verify()} disabled={busy} className="rounded-lg border border-slate-200 px-3 py-2 text-[11px] text-slate-600 disabled:opacity-50">{busy ? "Verificando…" : "Consultar saldo"}</button>}<button onClick={() => { setEditing(value => !value); setKey(""); setError(""); }} disabled={busy} className="rounded-lg bg-blue-600 px-4 py-2.5 text-[11px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50">{editing ? "Fechar configuração" : connection?.configured ? "Trocar chave" : "Conectar busca gratuita"}</button></div></div>{editing && <form onSubmit={connect} className="mt-5 space-y-3 border-t border-slate-100 pt-4"><p className="text-xs leading-relaxed text-slate-500">Crie sua conta no <a href="https://app.tavily.com" target="_blank" rel="noreferrer" className="font-semibold text-blue-600 underline">painel da Tavily</a>, mantenha o plano gratuito sem pay-as-you-go e copie a chave para o campo abaixo.</p><div className="flex flex-col gap-3 sm:flex-row sm:items-end"><label className="min-w-0 flex-1 text-[11px] font-medium text-slate-600">Chave de API Tavily<input type="password" required minLength={12} maxLength={256} autoComplete="off" spellCheck={false} disabled={busy} value={key} onChange={event => setKey(event.target.value)} placeholder="tvly-…" className="mt-1.5 w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 font-mono text-sm text-slate-900 outline-none focus:border-blue-500" /></label><button disabled={busy} className="flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-3 text-xs font-semibold text-white disabled:opacity-50">{busy && <LoaderCircle size={13} className="animate-spin" />}{busy ? "Validando…" : "Validar e conectar"}</button></div><p className="text-[10px] leading-relaxed text-slate-400">A chave fica no backend e não é devolvida pela API. A integração usa busca básica, consulta o saldo e pausa quando os créditos gratuitos terminam.</p></form>}{connection?.last_verified_at && <p className="mt-3 text-[11px] text-slate-500">Última verificação: {new Date(connection.last_verified_at).toLocaleString("pt-BR")}{connection.balance_is_historical ? ` · saldo histórico: ${connection.credits_remaining} créditos (não confirmado agora)` : " · não garante acesso às lojas"}</p>}{connection?.configured && !connected && <p className="mt-3 text-xs text-amber-700">{connection.message}</p>}{error && <p role="alert" className="mt-3 text-xs text-rose-600">{error}</p>}</section>;
}
function SupplierContacts() {
  const [contacts, setContacts] = useState<{ name: string; domain: string; authorized: boolean }[]>([]);
  const [info, setInfo] = useState<{ groq_configured: boolean; telegram_configured: boolean; webhook_secret_configured: boolean; webhook_url: string | null; webhook_error: string | null; sandbox_configured: boolean; sandbox_error: string | null } | null>(null);
  const [name, setName] = useState(""); const [domain, setDomain] = useState(""); const [webhook, setWebhook] = useState("");
  const [invite, setInvite] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    const values = await Promise.all([requestJson("/suppliers/contacts"), requestJson("/integrations/agent")]);
    setContacts(values[0] as typeof contacts); setInfo(values[1] as typeof info);
  }, []);
  useEffect(() => { let mounted = true; const controller = new AbortController(); void Promise.all([requestJson("/suppliers/contacts", { signal: controller.signal }), requestJson("/integrations/agent", { signal: controller.signal })]).then(([rows, status]) => { if (mounted) { setContacts(rows as typeof contacts); setInfo(status as typeof info); } }).catch((cause) => { if (mounted) setError(cause instanceof Error ? cause.message : "A API atual não disponibiliza diagnóstico de integrações e contatos."); }); return () => { mounted = false; controller.abort(); }; }, []);
  async function submit(event: FormEvent, action: "invite" | "webhook") {
    event.preventDefault(); if (busy) return; setBusy(true); setError("");
    try {
      const result = await requestJson(action === "invite" ? "/suppliers/invite" : "/integrations/telegram/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Nexo-Settings": "1" }, body: JSON.stringify(action === "invite" ? { name, domain: domain.trim().toLowerCase() } : { url: webhook }) }) as { url?: string };
      if (action === "invite") setInvite(result.url || "");
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível configurar."); }
    finally { setBusy(false); }
  }
  const field = "w-full rounded-lg border border-slate-200 px-3 py-2 text-xs outline-none focus:border-blue-500";
  return <details className="rounded-2xl border border-blue-100 bg-white p-5"><summary className="cursor-pointer text-sm font-semibold text-slate-800">Canais de negociação · {contacts.filter(c => c.authorized).length} contatos autorizados</summary><div className="mt-4 space-y-4">
    <p className="text-xs text-slate-500">Groq: {info?.groq_configured ? "chave configurada" : "não configurado"} · Telegram: {info?.telegram_configured ? "token configurado" : "não configurado"} · Webhook: {info?.webhook_url ? "registrado" : "pendente"}</p>
    <p className="text-xs text-violet-700">Sandbox: {info?.sandbox_configured ? "chat pessoal configurado no backend" : "defina MY_TELEGRAM_CHAT_ID no .env com o ID da sua conversa pessoal"}. Abra o bot e toque em Iniciar antes do teste.</p>{info?.webhook_error && <p className="text-xs text-amber-700">{info.webhook_error}</p>}
    {info && !info.webhook_secret_configured && <p className="text-xs text-amber-700">Configure TELEGRAM_WEBHOOK_SECRET no backend antes de registrar o webhook.</p>}
    <form onSubmit={e => void submit(e, "webhook")} className="flex flex-col gap-2 sm:flex-row"><label className="min-w-0 flex-1 text-xs text-slate-500">URL pública HTTPS do webhook<input type="url" required value={webhook} onChange={e => setWebhook(e.target.value)} placeholder="https://seu-backend/webhook/telegram" className={field} /></label><button disabled={busy} className="self-end rounded-lg bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700 disabled:opacity-50">Registrar webhook</button></form>
    <p className="text-xs leading-relaxed text-slate-500">Cadastre o contato comercial da loja e envie o convite ao responsável. Ele deve abrir o bot e tocar em Iniciar. A associação é feita pelo domínio; a seleção do fornecedor continua automática.</p>
    <form onSubmit={e => void submit(e, "invite")} className="grid gap-2 sm:grid-cols-3"><label className="text-xs text-slate-500">Nome do fornecedor<input required minLength={2} maxLength={300} value={name} onChange={e => setName(e.target.value)} className={field} /></label><label className="text-xs text-slate-500">Domínio da loja<input required value={domain} onChange={e => setDomain(e.target.value)} placeholder="loja.com.br" className={field} /></label><button disabled={busy} className="self-end rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">Criar convite individual</button></form>
    {safeUrl(invite) && <p className="break-all rounded-lg bg-blue-50 p-3 text-xs text-blue-800">Convite válido por 24h, para o responsável pela loja: <a href={safeUrl(invite)} target="_blank" rel="noreferrer" className="underline">{invite}</a></p>}
    {error && <p role="alert" className="text-xs text-rose-600">{error}</p>}
    <ul className="space-y-2 text-xs text-slate-600">{contacts.map(contact => <li key={contact.domain}>{contact.name} · {contact.domain} · {contact.authorized ? "Autorizado" : "Aguardando /start"}</li>)}</ul>
    <button onClick={() => void refresh().catch(() => setError("Não foi possível atualizar os canais."))} className="text-xs font-semibold text-blue-600">Atualizar contatos e conexão</button>
  </div></details>;
}

export default function SettingsPage() {
  return <main className="min-h-screen bg-slate-50 px-5 py-8 text-slate-900 [color-scheme:light]"><div className="mx-auto max-w-4xl space-y-6"><Link href="/" className="text-sm font-semibold text-blue-700">← Voltar ao dashboard</Link><header className="rounded-2xl bg-gradient-to-r from-blue-600 to-blue-400 p-6 text-white"><h1 className="text-2xl font-semibold">Conexões e contatos</h1><p className="mt-2 text-sm text-blue-100">Configure a pesquisa de mercado e os canais de negociação.</p></header><SearchIntegration /><SupplierContacts /></div></main>;
}
