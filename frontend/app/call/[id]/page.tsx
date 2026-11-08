"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Vapi from "@vapi-ai/web";
import {
  Phone,
  PhoneOff,
  Mic,
  Volume2,
  MessageSquare,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Package,
  MapPin,
  Layers,
  User,
} from "lucide-react";

type CallSessionData = {
  id: string;
  request_id: string;
  product: string;
  qty: number;
  destination: string;
  status: string;
  quote_completion_state?: string;
  target_price?: string;
  supplier_id?: string;
  supplier_name?: string;
  vapi_public_key?: string | null;
  assistant_id?: string | null;
};

type TranscriptTurn = {
  id: string;
  sender_type: "AI" | "SUPPLIER";
  content: string;
  timestamp: string;
};

export default function SupplierWebCallPage() {
  const params = useParams();
  const id = typeof params?.id === "string" ? params.id : Array.isArray(params?.id) ? params.id[0] : "";

  const [session, setSession] = useState<CallSessionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [supplierName, setSupplierName] = useState("Fornecedor Voz");
  const [supplierId, setSupplierId] = useState("fornecedor-voz");

  const [callState, setCallState] = useState<
    "idle" | "connecting" | "active" | "ended" | "fallback_sent" | "completed"
  >("idle");
  const [audioMode, setAudioMode] = useState<"listening" | "speaking" | "idle">("idle");
  const [volumeLevel, setVolumeLevel] = useState(0);
  const [livePartial, setLivePartial] = useState<{ role: "AI" | "SUPPLIER"; text: string } | null>(null);
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [extractedQuote, setExtractedQuote] = useState<Record<string, any> | null>(null);
  const [statusBanner, setStatusBanner] = useState<{ type: "info" | "success" | "warning" | "error"; text: string } | null>(null);

  const vapiRef = useRef<Vapi | null>(null);
  const callIdRef = useRef<string>(`webcall-${id || "session"}-${Date.now()}`);
  const transcriptRef = useRef<TranscriptTurn[]>([]);
  const extractedQuoteRef = useRef<Record<string, any> | null>(null);
  const endReportedRef = useRef<boolean>(false);
  const logContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    transcriptRef.current = transcript;
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [transcript, livePartial]);

  useEffect(() => {
    extractedQuoteRef.current = extractedQuote;
  }, [extractedQuote]);

  useEffect(() => {
    if (!id) return;
    let active = true;
    setLoading(true);
    fetch(`/api/call-session/${id}`, { cache: "no-store" })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.detail || body?.message || "Solicitação não encontrada.");
        return body as CallSessionData;
      })
      .then((data) => {
        if (!active) return;
        setSession(data);
        if (data.supplier_name) setSupplierName(data.supplier_name);
        if (data.supplier_id) setSupplierId(data.supplier_id);
        if (data.quote_completion_state === "concluida" || data.status === "concluida") {
          setCallState("completed");
          setStatusBanner({
            type: "success",
            text: "Esta cotação já foi concluída e registrada no Kanban da Nexo.",
          });
        }
      })
      .catch((err: unknown) => {
        if (!active) return;
        setLoadError(err instanceof Error ? err.message : "Erro ao carregar dados da chamada.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [id]);

  const notifyCallEnd = useCallback(
    async (opts: {
      status: "failed" | "completed" | "ended" | "hangup";
      quote_completed: boolean;
      reason?: string;
      quoteOverride?: Record<string, any> | null;
    }) => {
      if (!id || endReportedRef.current) return;
      endReportedRef.current = true;
      const quotePayload = opts.quoteOverride ?? extractedQuoteRef.current ?? undefined;
      try {
        const res = await fetch(`/api/call-session/${id}/end`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            call_id: callIdRef.current,
            status: opts.status,
            quote_completed: opts.quote_completed,
            supplier_id: supplierId || "fornecedor-voz",
            supplier_name: supplierName || "Fornecedor Voz",
            quote: quotePayload,
            transcript: transcriptRef.current,
            reason: opts.reason,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (data?.quote_completed || data?.request?.quote_completion_state === "concluida") {
          setCallState("completed");
          setStatusBanner({
            type: "success",
            text: "Cotação por voz confirmada e registrada automaticamente no Kanban e no Histórico!",
          });
        } else {
          setCallState("fallback_sent");
          setStatusBanner({
            type: "warning",
            text: "Acionamos o envio por mensagem (Telegram e WhatsApp) para você concluir ou enviar os dados faltantes por texto.",
          });
        }
      } catch {
        setCallState("fallback_sent");
        setStatusBanner({
          type: "error",
          text: "A chamada foi encerrada. Caso prefira, responda diretamente pelo Telegram ou WhatsApp.",
        });
      }
    },
    [id, supplierId, supplierName]
  );

  useEffect(() => {
    return () => {
      try {
        vapiRef.current?.stop();
      } catch {}
    };
  }, []);

  const handleStartCall = async () => {
    if (!session || !id) return;
    endReportedRef.current = false;
    callIdRef.current = `webcall-${id}-${Date.now()}`;
    setCallState("connecting");
    setStatusBanner({
      type: "info",
      text: "Solicitando permissão do microfone e conectando áudio Full-Duplex...",
    });

    try {
      if (typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
      }
    } catch {
      setStatusBanner({
        type: "error",
        text: "Permissão do microfone negada. Acionando fallback automático para Telegram e WhatsApp...",
      });
      await notifyCallEnd({ status: "failed", quote_completed: false, reason: "mic-denied" });
      return;
    }

    const publicKey =
      process.env.NEXT_PUBLIC_VAPI_PUBLIC_KEY ||
      session.vapi_public_key ||
      "";
    const assistantId =
      process.env.NEXT_PUBLIC_VAPI_ASSISTANT_ID ||
      session.assistant_id ||
      "";

    if (!publicKey || !assistantId) {
      setStatusBanner({
        type: "error",
        text: "Chave pública ou Assistant ID da Vapi ausente. Acionando fallback automático para Telegram e WhatsApp...",
      });
      await notifyCallEnd({ status: "failed", quote_completed: false, reason: "missing-vapi-config" });
      return;
    }

    try {
      if (vapiRef.current) {
        try {
          vapiRef.current.stop();
        } catch {}
      }

      const vapi = new Vapi(publicKey);
      vapiRef.current = vapi;

      vapi.on("call-start", () => {
        setCallState("active");
        setAudioMode("listening");
        setStatusBanner({
          type: "info",
          text: "Ligação Full-Duplex ativa. Pode falar normalmente com o comprador da Nexo.",
        });
      });

      vapi.on("speech-start", () => {
        setAudioMode("speaking");
      });

      vapi.on("speech-end", () => {
        setAudioMode("listening");
      });

      vapi.on("volume-level", (level: number) => {
        setVolumeLevel(typeof level === "number" ? Math.min(1, Math.max(0, level)) : 0);
      });

      vapi.on("message", (msg: any) => {
        if (!msg || typeof msg !== "object") return;

        if (msg.type === "transcript" && typeof msg.transcript === "string") {
          const role: "AI" | "SUPPLIER" = msg.role === "assistant" || msg.role === "bot" ? "AI" : "SUPPLIER";
          const text = msg.transcript.trim();
          if (!text) return;
          if (msg.transcriptType === "partial") {
            setLivePartial({ role, text });
          } else {
            setLivePartial(null);
            setTranscript((prev) => [
              ...prev,
              {
                id: `${Date.now()}-${ prev.length }`,
                sender_type: role,
                content: text,
                timestamp: new Date().toISOString(),
              },
            ]);
          }
        }

        if (msg.type === "tool-calls" || msg.type === "function-call") {
          const calls = Array.isArray(msg.toolCallList)
            ? msg.toolCallList
            : Array.isArray(msg.toolWithToolCallList)
              ? msg.toolWithToolCallList.map((x: any) => x?.toolCall).filter(Boolean)
              : msg.functionCall
                ? [{ function: msg.functionCall }]
                : [];
          for (const tool of calls) {
            const fn = tool?.function;
            if (fn?.name === "submit_procurement_quote" && fn.arguments != null) {
              try {
                const parsed = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments;
                if (parsed && typeof parsed === "object") {
                  setExtractedQuote(parsed);
                  extractedQuoteRef.current = parsed;
                }
              } catch {}
            }
          }
        }
      });

      vapi.on("error", (err: any) => {
        console.error("Vapi WebRTC error:", err);
        setAudioMode("idle");
        void notifyCallEnd({
          status: "failed",
          quote_completed: false,
          reason: err?.message || "webrtc-error",
        });
      });

      vapi.on("call-end", () => {
        setAudioMode("idle");
        setLivePartial(null);
        const q = extractedQuoteRef.current;
        const isCompleted = Boolean(q && q.supplier_confirmed === true && q.final_price);
        void notifyCallEnd({
          status: isCompleted ? "completed" : "ended",
          quote_completed: isCompleted,
          quoteOverride: q,
        });
      });

      const product = session.product;
      const qty = session.qty;
      const destination = session.destination;
      const target_price = session.target_price || "0.00";

      const assistantOverrides = {
        metadata: {
          request_id: id,
          supplier_id: supplierId || "fornecedor-voz",
          supplier_name: supplierName || "Fornecedor Voz",
        },
        variableValues: {
          purchase_context: JSON.stringify({
            request_id: id,
            item: product,
            requested_qty: qty,
            destination,
            target_price,
            currency: "BRL",
          }),
        },
        firstMessage: `Olá! Sou o assistente de compras da Nexo. Estou ligando sobre a cotação de ${product}, quantidade de ${qty} unidades para entrega no CEP ${destination}. Você tem disponibilidade desse item e poderia me informar o preço unitário, frete, taxas e prazo de entrega?`,
      };

      const callInfo: any = await vapi.start(assistantId, assistantOverrides);
      if (callInfo?.id && typeof callInfo.id === "string") {
        callIdRef.current = callInfo.id;
      }
    } catch (err: any) {
      console.error("Failed to start Vapi call:", err);
      setAudioMode("idle");
      await notifyCallEnd({
        status: "failed",
        quote_completed: false,
        reason: err?.message || "call-start-error",
      });
    }
  };

  const handleEndCall = async () => {
    try {
      vapiRef.current?.stop();
    } catch {}
    setAudioMode("idle");
    const q = extractedQuoteRef.current;
    const isCompleted = Boolean(q && q.supplier_confirmed === true && q.final_price);
    await notifyCallEnd({
      status: isCompleted ? "completed" : "hangup",
      quote_completed: isCompleted,
      quoteOverride: q,
    });
  };

  const handleCannotTalkNow = async () => {
    try {
      vapiRef.current?.stop();
    } catch {}
    setAudioMode("idle");
    endReportedRef.current = false;
    await notifyCallEnd({
      status: "failed",
      quote_completed: false,
      reason: "supplier-declined-voice",
    });
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
        <div className="flex items-center gap-3 text-slate-300">
          <Loader2 className="w-6 h-6 animate-spin text-emerald-400" />
          <span>Carregando sessão de ligação Nexo...</span>
        </div>
      </div>
    );
  }

  if (loadError || !session) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-slate-900 border border-red-500/30 rounded-2xl p-6 text-center space-y-4">
          <AlertTriangle className="w-10 h-10 text-red-400 mx-auto" />
          <h1 className="text-lg font-semibold">Sessão de chamada indisponível</h1>
          <p className="text-sm text-slate-400">{loadError || "Solicitação não encontrada."}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-4 md:p-8">
      <div className="max-w-2xl w-full bg-slate-900/90 border border-slate-800 rounded-3xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="bg-gradient-to-r from-slate-900 via-emerald-950/40 to-slate-900 border-b border-slate-800 p-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <span className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-1 rounded-full">
                <Phone className="w-3.5 h-3.5" /> Ligação de Voz Nexo • Full-Duplex WebRTC
              </span>
              <h1 className="text-xl md:text-2xl font-bold mt-2 text-white">
                Cotação de Compras — {session.product}
              </h1>
            </div>
            <div className="text-right">
              <span className="text-xs text-slate-400 block">Status da Solicitação</span>
              <span className="text-sm font-semibold text-slate-200 capitalize">{session.status}</span>
            </div>
          </div>

          {/* Request Summary Pills */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-5">
            <div className="bg-slate-950/60 border border-slate-800/80 rounded-xl p-3 flex items-center gap-3">
              <Package className="w-5 h-5 text-emerald-400 shrink-0" />
              <div className="min-w-0">
                <div className="text-xs text-slate-400">Produto</div>
                <div className="text-sm font-medium text-slate-100 truncate">{session.product}</div>
              </div>
            </div>
            <div className="bg-slate-950/60 border border-slate-800/80 rounded-xl p-3 flex items-center gap-3">
              <Layers className="w-5 h-5 text-sky-400 shrink-0" />
              <div>
                <div className="text-xs text-slate-400">Quantidade</div>
                <div className="text-sm font-medium text-slate-100">{session.qty} unidades</div>
              </div>
            </div>
            <div className="bg-slate-950/60 border border-slate-800/80 rounded-xl p-3 flex items-center gap-3">
              <MapPin className="w-5 h-5 text-amber-400 shrink-0" />
              <div>
                <div className="text-xs text-slate-400">Destino (CEP)</div>
                <div className="text-sm font-medium text-slate-100">{session.destination}</div>
              </div>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="p-6 space-y-6">
          {/* Supplier Identification */}
          {callState === "idle" && (
            <div className="bg-slate-950/50 border border-slate-800 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex items-center gap-2 text-sm text-slate-300 shrink-0">
                <User className="w-4 h-4 text-slate-400" />
                <span>Sua identificação (Fornecedor):</span>
              </div>
              <input
                type="text"
                value={supplierName}
                onChange={(e) => setSupplierName(e.target.value)}
                placeholder="Nome da empresa / fornecedor"
                className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
              />
            </div>
          )}

          {/* Full-Duplex Visual Audio Indicator */}
          <div className="bg-slate-950 border border-slate-800 rounded-2xl p-6 flex flex-col items-center justify-center text-center space-y-4">
            <div className="relative flex items-center justify-center">
              {callState === "active" && (
                <div
                  className={`absolute rounded-full transition-all duration-150 ${
                    audioMode === "speaking"
                      ? "bg-emerald-500/25 w-28 h-28 animate-ping"
                      : "bg-sky-500/20 w-24 h-24 animate-pulse"
                  }`}
                  style={{
                    transform: `scale(${1 + volumeLevel * 0.45})`,
                  }}
                />
              )}
              <div
                className={`relative z-10 w-20 h-20 rounded-full flex items-center justify-center border-2 transition-colors ${
                  callState === "active"
                    ? audioMode === "speaking"
                      ? "bg-emerald-500/20 border-emerald-400 text-emerald-300"
                      : "bg-sky-500/20 border-sky-400 text-sky-300"
                    : callState === "connecting"
                      ? "bg-amber-500/20 border-amber-400 text-amber-300"
                      : callState === "completed"
                        ? "bg-emerald-500/20 border-emerald-400 text-emerald-300"
                        : "bg-slate-900 border-slate-700 text-slate-400"
                }`}
              >
                {callState === "connecting" ? (
                  <Loader2 className="w-9 h-9 animate-spin" />
                ) : callState === "active" ? (
                  audioMode === "speaking" ? (
                    <Volume2 className="w-9 h-9" />
                  ) : (
                    <Mic className="w-9 h-9" />
                  )
                ) : callState === "completed" ? (
                  <CheckCircle2 className="w-9 h-9" />
                ) : (
                  <Phone className="w-9 h-9" />
                )}
              </div>
            </div>

            <div className="space-y-1">
              <div className="text-base font-semibold text-white">
                {callState === "idle" && "Pronto para iniciar a ligação de voz"}
                {callState === "connecting" && "Conectando canal de voz Full-Duplex..."}
                {callState === "active" &&
                  (audioMode === "speaking"
                    ? "🔊 Assistente Nexo falando..."
                    : "🎙️ Ouvindo você (Full-Duplex ativo)...")}
                {callState === "completed" && "✅ Cotação concluída e registrada!"}
                {callState === "fallback_sent" && "💬 Continuidade enviada para Telegram e WhatsApp"}
                {callState === "ended" && "Ligação encerrada"}
              </div>
              <p className="text-xs text-slate-400 max-w-md">
                {callState === "active"
                  ? "Informe preço unitário, frete, taxas adicionais, prazo de entrega em dias e estoque disponível."
                  : "Converse em tempo real pelo navegador ou celular sem custo de telefonia."}
              </p>
            </div>
          </div>

          {/* Status Banner */}
          {statusBanner && (
            <div
              className={`rounded-2xl p-4 border text-sm flex items-start gap-3 ${
                statusBanner.type === "success"
                  ? "bg-emerald-950/40 border-emerald-500/40 text-emerald-200"
                  : statusBanner.type === "warning"
                    ? "bg-amber-950/40 border-amber-500/40 text-amber-200"
                    : statusBanner.type === "error"
                      ? "bg-red-950/40 border-red-500/40 text-red-200"
                      : "bg-sky-950/40 border-sky-500/40 text-sky-200"
              }`}
            >
              {statusBanner.type === "success" ? (
                <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5 text-emerald-400" />
              ) : (
                <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5 text-amber-400" />
              )}
              <span>{statusBanner.text}</span>
            </div>
          )}

          {/* Live Transcript Box */}
          <div className="bg-slate-950 border border-slate-800 rounded-2xl p-4">
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3 flex items-center justify-between">
              <span>Transcrição em Tempo Real</span>
              {callState === "active" && (
                <span className="inline-flex items-center gap-1.5 text-emerald-400">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" /> Ao vivo
                </span>
              )}
            </div>
            <div
              ref={logContainerRef}
              className="h-48 overflow-y-auto space-y-2.5 pr-1 text-sm"
            >
              {transcript.length === 0 && !livePartial ? (
                <div className="h-full flex items-center justify-center text-slate-500 text-xs">
                  A transcrição da conversa aparecerá aqui assim que a ligação começar.
                </div>
              ) : (
                <>
                  {transcript.map((turn) => (
                    <div
                      key={turn.id}
                      className={`flex flex-col ${
                        turn.sender_type === "AI" ? "items-start" : "items-end"
                      }`}
                    >
                      <span className="text-[11px] text-slate-400 mb-0.5 px-1">
                        {turn.sender_type === "AI" ? "Comprador Nexo (IA)" : supplierName}
                      </span>
                      <div
                        className={`rounded-2xl px-3.5 py-2 max-w-[85%] ${
                          turn.sender_type === "AI"
                            ? "bg-slate-800 text-slate-100"
                            : "bg-emerald-600/25 border border-emerald-500/30 text-emerald-100"
                        }`}
                      >
                        {turn.content}
                      </div>
                    </div>
                  ))}
                  {livePartial && (
                    <div
                      className={`flex flex-col opacity-75 ${
                        livePartial.role === "AI" ? "items-start" : "items-end"
                      }`}
                    >
                      <span className="text-[11px] text-slate-400 mb-0.5 px-1">
                        {livePartial.role === "AI" ? "Comprador Nexo (IA)" : supplierName}
                      </span>
                      <div className="rounded-2xl px-3.5 py-2 max-w-[85%] bg-slate-900 border border-slate-700 text-slate-300 italic">
                        {livePartial.text}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-col sm:flex-row gap-3 pt-2">
            {callState !== "active" && callState !== "connecting" ? (
              <button
                type="button"
                onClick={handleStartCall}
                className="flex-1 inline-flex items-center justify-center gap-2.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold py-3.5 px-6 rounded-2xl transition shadow-lg shadow-emerald-500/20 cursor-pointer"
              >
                <Phone className="w-5 h-5" />
                Atender / Iniciar Ligação
              </button>
            ) : (
              <button
                type="button"
                onClick={handleEndCall}
                className="flex-1 inline-flex items-center justify-center gap-2.5 bg-red-500 hover:bg-red-400 text-white font-semibold py-3.5 px-6 rounded-2xl transition shadow-lg shadow-red-500/20 cursor-pointer"
              >
                <PhoneOff className="w-5 h-5" />
                Encerrar Ligação
              </button>
            )}

            <button
              type="button"
              onClick={handleCannotTalkNow}
              className="flex-1 inline-flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 font-medium py-3.5 px-5 rounded-2xl transition text-sm cursor-pointer"
            >
              <MessageSquare className="w-4 h-4 text-sky-400" />
              Não consigo falar agora / Responder por mensagem
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
