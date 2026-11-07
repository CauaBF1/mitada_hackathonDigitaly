"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { requestJson } from "./contracts";

interface ChatMessage { id: string; request_id: string; supplier_domain: string; sender_type: "AI" | "SUPPLIER"; text: string; timestamp: string; delivery_status: string }
export default function LiveChatModal({ requestId, sandbox, close }: { requestId: string | null; sandbox: boolean; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (requestId === null) { dialog.current?.close(); return; }
    dialog.current?.showModal(); setMessages([]); setError("");
    let disposed = false; let busy = false; let controller: AbortController | undefined;
    async function load() {
      if (busy || disposed) return;
      busy = true; controller = new AbortController();
      try {
        const value = await requestJson(`/chat/${requestId}`, { signal: controller.signal });
        if (!Array.isArray(value) || !value.every(row => typeof row.id === "string" && row.request_id === requestId && typeof row.supplier_domain === "string" && typeof row.timestamp === "string" && typeof row.text === "string" && ["AI", "SUPPLIER"].includes(row.sender_type))) throw new Error("Histórico incompatível.");
        if (!disposed) {
          const following = !scroll.current || scroll.current.scrollHeight - scroll.current.scrollTop - scroll.current.clientHeight < 100;
          setMessages([...new Map(value.map(row => [row.id, row])).values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id))); setError("");
          if (following) requestAnimationFrame(() => { if (!disposed && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; });
        }
      } catch (cause) { if (!disposed) setError(cause instanceof Error ? cause.message : "Histórico indisponível."); }
      finally { busy = false; }
    }
    void load(); const timer = setInterval(() => { if (!document.hidden) void load(); }, 3000);
    return () => { disposed = true; clearInterval(timer); controller?.abort(); };
  }, [requestId]);
  return <dialog ref={dialog} onCancel={close} aria-labelledby="chat-title" className="w-[calc(100%-2rem)] max-w-2xl rounded-2xl border-0 bg-white p-0 text-slate-900 shadow-2xl">
    <header className="flex items-center justify-between bg-gradient-to-r from-blue-600 to-blue-400 p-5 text-white"><div><h2 id="chat-title" className="font-semibold">{sandbox ? "SANDBOX" : "Negociação"} #{requestId} · Telegram</h2><p className="mt-1 text-xs text-blue-100">Roberto × fornecedores · atualização a cada 3 segundos</p></div><button onClick={close} aria-label="Fechar conversa" className="rounded-lg p-2 hover:bg-white/10"><X size={18} /></button></header>
    {error && <p role="alert" className="p-3 text-xs text-amber-700">{error} As mensagens recebidas permanecem visíveis.</p>}
    <div ref={scroll} role="log" aria-label="Conversa com fornecedores" aria-live="polite" aria-relevant="additions" className="h-[55vh] space-y-4 overflow-y-auto bg-slate-50 p-5">
      {messages.map(message => <div key={message.id} className={`flex ${message.sender_type === "AI" ? "justify-start" : "justify-end"}`}><article className={`max-w-[88%] rounded-2xl px-4 py-3 ${message.sender_type === "AI" ? "rounded-tl-sm bg-blue-600 text-white" : "rounded-tr-sm bg-slate-200 text-slate-800"}`}><p className="mb-2 break-all text-[10px] font-semibold opacity-80">{message.sender_type === "AI" ? "Roberto → " : (sandbox ? "Você como fornecedor · " : "Fornecedor · ")}{message.supplier_domain}</p><p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{message.text}</p><p className="mt-2 text-[9px] opacity-70">{new Date(message.timestamp).toLocaleString("pt-BR")} · {({ sent: "Enviada", received: "Recebida", sending: "Enviando", unconfirmed: "Envio não confirmado" } as Record<string, string>)[message.delivery_status] || message.delivery_status}</p></article></div>)}
      {!messages.length && <p className="py-8 text-center text-sm text-slate-400">Ainda não há mensagens. O envio depende de preços comparáveis, reputação aprovada e contato autorizado.</p>}
    </div><footer className="border-t border-slate-100 p-3 text-center text-[10px] text-slate-400">{sandbox ? "Demonstração com mensagens reais · economia fora dos indicadores reais" : "Últimas 200 mensagens reais · esta janela acompanha a conversa"}</footer>
  </dialog>;
}
