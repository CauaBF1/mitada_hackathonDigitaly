"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { Globe2, LoaderCircle, X } from "lucide-react";
import { requestJson, type PurchaseRequest } from "./contracts";

export default function LiveDemoModal({ open, mode, close, created }: { open: boolean; mode: "live" | "sandbox"; close: () => void; created: (id: string) => Promise<void> }) {
  const ref = useRef<HTMLDialogElement>(null); const [item, setItem] = useState(""); const [quantity, setQuantity] = useState(1); const [location, setLocation] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const identity = useRef({ fingerprint: "", key: "" });
  useEffect(() => {
    const element = ref.current;
    if (!open) { element?.close(); return; }
    element?.showModal(); element?.querySelector("input")?.focus(); setError("");
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = overflow; element?.close(); };
  }, [open]);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    if (item.trim().length < 3) { setError("Descreva o item com pelo menos 3 caracteres."); return; }
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000000 || !/(?<!\d)\d{5}-?\d{3}(?!\d)/.test(location) || /(?<!\d)00000-?000(?!\d)/.test(location)) { setError("Informe uma quantidade inteira e um CEP com oito dígitos."); return; }
    const fingerprint = JSON.stringify({ item: item.trim(), mode, qty: quantity, delivery_location: location.trim() });
    if (identity.current.fingerprint !== fingerprint) identity.current = { fingerprint, key: crypto.randomUUID() };
    setBusy(true); setError("");
    try { const row = await requestJson("/request", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": identity.current.key }, body: fingerprint }) as PurchaseRequest; if (typeof row?.id !== "string") throw new Error("Resposta de criação inválida."); await created(row.id); setItem(""); setQuantity(1); setLocation(""); identity.current = { fingerprint: "", key: "" }; close(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível criar a solicitação."); } finally { setBusy(false); }
  }
  const input = "mt-2 w-full rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-sm text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100";
  return <dialog ref={ref} aria-labelledby="request-title" onCancel={event => { if (busy) event.preventDefault(); else close(); }} className="w-[calc(100%-2rem)] max-w-lg rounded-2xl border-0 bg-white p-0 text-slate-900 shadow-2xl"><div className="flex items-center justify-between border-b border-slate-100 px-6 py-5"><div><p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-blue-600">Pesquisa real de fornecedores</p><h2 id="request-title" className="text-lg font-semibold">{mode === "sandbox" ? "Teste ao vivo no Telegram" : "Nova solicitação"}</h2></div><button onClick={close} disabled={busy} aria-label="Fechar formulário" className="rounded-lg p-2 text-slate-400 hover:bg-slate-100"><X size={18} /></button></div><form onSubmit={submit} className="space-y-5 p-6"><label className="block text-xs font-medium text-slate-600">Nome do item<input autoFocus required minLength={3} maxLength={300} disabled={busy} value={item} onChange={event => setItem(event.target.value)} className={input} placeholder="Ex.: Monitor Dell 27, modelo P2725H" /></label><div className="grid gap-4 sm:grid-cols-[110px_1fr]"><label className="block text-xs text-slate-600">Quantidade<input type="number" step={1} min={1} max={1000000} required disabled={busy} value={quantity} onChange={event => setQuantity(Number(event.target.value))} className={input} /></label><label className="block text-xs text-slate-600">Local de entrega / CEP<input required maxLength={200} minLength={2} disabled={busy} value={location} onChange={event => setLocation(event.target.value)} placeholder="CEP 01001-000, SP" className={input} /></label></div><p className="rounded-xl bg-blue-50 p-4 text-xs leading-relaxed text-blue-800">{mode === "sandbox" ? "SANDBOX: usamos um preço real da web e enviamos a negociação somente ao seu Telegram pessoal. Você representa o fornecedor. Economias do teste não entram nos indicadores reais." : "A IA encontra fornecedores, compara ofertas equivalentes, verifica a reputação e negocia pelo Telegram com contatos autorizados. A meta considera a quantidade e o frete para o destino informado."} Sites podem bloquear consultas; nesses casos, a falha será exibida sem substituir dados.</p>{error && <p role="alert" className="text-xs text-rose-600">{error}</p>}<button disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">{busy ? <LoaderCircle size={16} className="animate-spin" /> : <Globe2 size={16} />}{busy ? "Enviando…" : mode === "sandbox" ? "Iniciar demonstração ao vivo" : "Pesquisar fornecedores reais"}</button></form></dialog>;
}
