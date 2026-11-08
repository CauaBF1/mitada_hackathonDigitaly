"use client";

import { useEffect, useMemo, useState } from "react";
import { Bot, Clock3, RefreshCw, TrendingDown } from "lucide-react";
import { CartesianGrid, Line, LineChart, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { brl, requestJson, type PriceHistoryPoint, type PriceHistoryResponse, type PurchaseRequest } from "../../../contracts";

const verdicts = {
  BUY_NOW: { title: "Momento Ideal para Compra", style: "border-emerald-200 bg-emerald-50 text-emerald-800", dot: "bg-emerald-500" },
  WAIT: { title: "Avaliar Aguardar", style: "border-amber-200 bg-amber-50 text-amber-800", dot: "bg-amber-500" },
  MONITOR: { title: "Monitorar Mercado", style: "border-sky-200 bg-sky-50 text-sky-800", dot: "bg-sky-500" },
};
const dateLabel = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", timeZone: "UTC" });

function dailyCurve(history: PriceHistoryPoint[]) {
  const days = new Map<string, Map<string, number[]>>();
  for (const point of history) {
    const suppliers = days.get(point.date) ?? new Map<string, number[]>();
    const supplier = point.supplier.trim().toLowerCase();
    suppliers.set(supplier, [...(suppliers.get(supplier) ?? []), Number(point.price)]);
    days.set(point.date, suppliers);
  }
  return [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, suppliers]) => {
    const prices = [...suppliers.values()].map(values => values.reduce((a, b) => a + b, 0) / values.length);
    return { date, price: prices.reduce((a, b) => a + b, 0) / prices.length };
  });
}

export default function PriceTimingSection({ requests, defaultRequestId }: { requests: PurchaseRequest[]; defaultRequestId?: string }) {
  const [selectedId, setSelectedId] = useState(defaultRequestId ?? "");
  const [days, setDays] = useState<30 | 60 | 90>(60);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<PriceHistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = requests.find(row => row.id === selectedId) ?? requests[0];
  const requestId = request?.id;

  useEffect(() => {
    if (!requestId) return;
    const controller = new AbortController();
    setLoading(true); setError(""); setData(null);
    void requestJson(`/procurement/${encodeURIComponent(requestId)}/price-history?days=${days}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setData(result as PriceHistoryResponse); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Histórico indisponível."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [requestId, days, revision]);

  const curve = useMemo(() => dailyCurve(data?.history ?? []), [data]);
  const chartData = data && data.selected_price && !curve.some(point => point.date === data.selected_date)
    ? [...curve, { date: data.selected_date, price: null }] : curve;
  const analysis = data?.analysis;
  const simulation = data?.data_source === "simulation";
  const verdict = analysis ? verdicts[analysis.verdict] : null;
  const chosenLabel = data?.price_source === "selected" ? "Opção escolhida" : data?.price_source === "negotiated" ? "Preço negociado" : "Referência atual";
  const delta = Number(analysis?.savings_vs_historical_avg_pct ?? 0);
  const domainValues = [...curve.map(point => point.price), Number(data?.selected_price), Number(analysis?.lowest_historical_price)].filter(value => value > 0);
  const min = Math.min(...domainValues), max = Math.max(...domainValues);
  const padding = Math.max((max-min)*0.15, max*0.03);

  return <section aria-labelledby="price-timing-title" className="min-w-0 rounded-3xl border border-slate-200 bg-white p-5 sm:p-7">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="flex items-center gap-2 text-xs font-semibold text-[#415AFF]"><Clock3 size={16} />Inteligência temporal</p><h2 id="price-timing-title" className="mt-2 text-xl font-bold">Histórico Temporal de Preços &amp; Timing de Compra</h2><p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-500">Veja a evolução do preço unitário e compare o valor atual com o período observado.</p></div>
      <button type="button" onClick={() => setRevision(value => value+1)} disabled={loading || !requestId} className="inline-flex items-center gap-2 rounded-xl border border-blue-100 px-4 py-2 text-xs font-semibold text-[#415AFF] disabled:opacity-50"><RefreshCw size={14} className={loading ? "animate-spin" : ""} />Atualizar análise</button>
    </div>
    {!request && <p className="mt-6 rounded-xl bg-slate-50 p-5 text-sm text-slate-500">Crie uma solicitação e colete um preço para começar a acompanhar o histórico.</p>}
    {request && <>
      <div className="mt-6 flex flex-wrap items-end gap-4">
        <label className="min-w-0 flex-1 text-xs font-semibold text-slate-600">Item para análise temporal<select value={request.id} onChange={event => setSelectedId(event.target.value)} className="mt-2 block w-full min-w-0 rounded-xl border border-slate-200 bg-white p-3 text-sm">{requests.map(row => <option key={row.id} value={row.id}>{row.item} · {row.qty} unidades</option>)}</select></label>
        <div role="group" aria-label="Período do histórico" className="flex gap-1 rounded-xl bg-slate-100 p-1">{([30, 60, 90] as const).map(period => <button key={period} type="button" aria-pressed={days === period} onClick={() => setDays(period)} className={`rounded-lg px-3 py-2 text-xs font-semibold ${days === period ? 'bg-white text-[#415AFF] shadow-sm' : 'text-slate-500'}`}>{period} dias</button>)}</div>
      </div>
      {loading && <div role="status" className="mt-6 flex min-h-64 items-center justify-center gap-3 rounded-2xl bg-slate-50 p-8 text-sm text-slate-500"><RefreshCw size={18} className="animate-spin" />Consultando histórico e análise de timing…</div>}
      {error && <p role="alert" className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{error} Use “Atualizar análise” para tentar novamente.</p>}
      {data && <>
        <div className={`mt-5 rounded-xl border p-4 text-xs leading-relaxed ${simulation ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-sky-100 bg-sky-50 text-slate-600'}`}><strong>{simulation ? 'Simulação preliminar · dados ilustrativos. ' : data.data_source === 'persisted' ? 'Histórico real de cotações. ' : 'Aguardando cotações. '}</strong>{data.message}{data.price_source === "reference" && ' Ainda não há opção escolhida: o marcador usa a cotação mais recente como referência.'}</div>
        {!analysis && <p className="mt-6 p-5 text-sm text-slate-500">Assim que houver um preço, a prévia temporal ficará disponível. Depois, atualize a análise para acompanhar os novos registros.</p>}
        {analysis && verdict && <div className="mt-6 grid min-w-0 gap-6 2xl:grid-cols-[minmax(0,1.7fr)_minmax(300px,1fr)]">
          <div className="min-w-0 rounded-2xl border border-slate-100 p-3 sm:p-5">
            <div className="flex flex-wrap justify-between gap-2"><h3 className="text-sm font-semibold">{simulation ? 'Curva ilustrativa de preços' : 'Evolução dos preços de mercado'}</h3><span className="text-xs text-slate-400">BRL / unidade · {days} dias</span></div>
            <div className="mt-4 h-[310px] w-full min-w-0" role="img" aria-label={`Histórico ${simulation ? 'simulado' : 'real'} de preços. Média: ${brl(data.historical_average)}. Mínima: ${brl(analysis.lowest_historical_price)}. ${chosenLabel}: ${brl(data.selected_price)}.`}>
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <LineChart data={chartData} margin={{ top: 36, right: 18, bottom: 10, left: 0 }} accessibilityLayer>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                  <XAxis dataKey="date" tickFormatter={dateLabel} minTickGap={35} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis width={65} domain={[Math.max(0, min-padding), max+padding]} tickFormatter={value => Number(value).toLocaleString("pt-BR", { maximumFractionDigits: 0 })} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                  <Tooltip labelFormatter={value => dateLabel(String(value))} formatter={value => [brl(Number(value).toFixed(2)), simulation ? 'Média diária simulada' : 'Média diária de mercado']} contentStyle={{ borderRadius: 12, fontSize: 12 }} />
                  <ReferenceLine y={Number(data.historical_average)} stroke="#64748b" strokeDasharray="7 5" />
                  <ReferenceLine y={Number(analysis.lowest_historical_price)} stroke="#10B981" strokeDasharray="2 4" />
                  <Line type="linear" dataKey="price" stroke="#019EFD" strokeWidth={3} dot={false} activeDot={{ r: 5 }} isAnimationActive={false} />
                  <ReferenceDot x={data.selected_date} y={Number(data.selected_price)} r={7} fill="#415AFF" stroke="white" strokeWidth={3} ifOverflow="extendDomain" label={{ value: chosenLabel, position: 'left', fill: '#415AFF', fontSize: 10, offset: 14 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-2 text-[11px] text-slate-500"><span className="text-sky-600">━ Preços {simulation ? 'simulados' : 'observados'}</span><span>┄ Média: {brl(data.historical_average)}</span><span className="text-emerald-600">┈ Mínima: {brl(analysis.lowest_historical_price)}</span><span className="text-[#415AFF]">● {chosenLabel}: {brl(data.selected_price)}</span></div>
            <details className="mt-5 text-xs text-slate-500"><summary className="cursor-pointer font-semibold">Consultar registros reais ({data.real_observation_count})</summary>{!data.observed_history.length ? <p className="mt-3">Nenhuma observação real neste período.</p> : <div className="mt-3 max-h-52 overflow-auto"><table className="w-full text-left"><caption className="mb-2 text-left">Preços unitários persistidos, separados da simulação.</caption><thead><tr><th className="p-2">Data</th><th className="p-2">Fornecedor</th><th className="p-2 text-right">Preço</th></tr></thead><tbody>{data.observed_history.map((point, index) => <tr key={`${point.date}-${index}`} className="border-t border-slate-100"><td className="whitespace-nowrap p-2">{dateLabel(point.date)}</td><td className="p-2">{point.supplier}</td><td className="whitespace-nowrap p-2 text-right">{brl(point.price)}</td></tr>)}</tbody></table></div>}</details>
          </div>
          <article className="min-w-0 rounded-2xl bg-[#111827] p-5 text-white sm:p-6">
            <div className="flex items-center gap-2 text-xs font-semibold text-sky-300"><Bot size={18} />PriceTimingAgent</div>
            <div className={`mt-4 inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-bold ${verdict.style}`}><span className={`h-2 w-2 rounded-full ${verdict.dot}`} />{verdict.title}</div>
            <p className="mt-3 text-xs text-slate-400">{simulation ? 'Recomendação suspensa · simulação' : `Tendência ${analysis.trend === 'RISING' ? 'de alta' : analysis.trend === 'FALLING' ? 'de queda' : 'estável'} · confiança ${analysis.confidence_score}%`}</p>
            <h3 className="mt-6 text-xs text-slate-400">Posição no Histórico {simulation ? '(simulado)' : ''}</h3>
            <p className="mt-2 text-2xl font-bold">Percentil {analysis.current_price_percentile}</p>
            <div role="meter" aria-label="Percentil do preço atual" aria-valuemin={0} aria-valuemax={100} aria-valuenow={analysis.current_price_percentile} className="mt-3 h-2 overflow-hidden rounded-full bg-slate-700"><div className="h-full rounded-full bg-gradient-to-r from-[#10B981] to-[#019EFD]" style={{ width: `${analysis.current_price_percentile}%` }} /></div>
            <p className="mt-2 text-[11px] text-slate-400">0 = menor posição · 100 = maior posição</p>
            <p className="mt-4 flex items-start gap-2 text-sm text-sky-200"><TrendingDown size={18} className="mt-0.5 shrink-0" /><span>{Math.abs(delta).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}% {delta >= 0 ? 'abaixo' : 'acima'} da média {simulation ? 'simulada' : 'histórica'} de {days} dias.</span></p>
            <dl className="mt-5 grid grid-cols-2 gap-3 border-t border-slate-700 pt-5"><div><dt className="text-[11px] text-slate-400">Menor preço {simulation ? 'simulado' : 'visto'}</dt><dd className="mt-1 text-base font-bold text-emerald-300">{brl(analysis.lowest_historical_price)}</dd></div><div><dt className="text-[11px] text-slate-400">{chosenLabel}</dt><dd className="mt-1 text-base font-bold">{brl(data.selected_price)}</dd></div></dl>
            <div className="mt-5 rounded-xl border border-slate-700 bg-slate-800 p-4"><p className="mb-2 flex items-center gap-2 text-xs font-semibold text-sky-300"><Bot size={15} />{data.analysis_source === 'llm' ? 'Justificativa do agente' : simulation ? 'Análise preliminar' : 'Leitura estatística · IA indisponível'}</p><p className="text-xs leading-relaxed text-slate-300">{analysis.timing_justification}</p></div>
          </article>
        </div>}
      </>}
    </>}
  </section>;
}
