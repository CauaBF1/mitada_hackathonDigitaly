'use client';

import { useRef, useState } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import { requestJson, type PurchaseRequest } from './contracts';

type Props = {
  id: string;
  product: string;
  canRepeat?: boolean;
  compact?: boolean;
  disabled?: boolean;
  onDeleted: (id: string) => void | Promise<void>;
  onRepeated: (row: PurchaseRequest) => void | Promise<void>;
};

/** Shared confirmation and mutation states across Kanban, drawer and history. */
export default function RequestActions({id, product, canRepeat = true, compact = false, disabled = false, onDeleted, onRepeated}: Props) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<'delete' | 'repeat' | null>(null);
  const [error, setError] = useState('');
  const pending = useRef(false);
  async function act(action: 'delete' | 'repeat') {
    if (pending.current || disabled) return;
    pending.current = true; setBusy(action); setError('');
    try {
      if (action === 'delete') {
        await requestJson(`/request/${id}`, {method: 'DELETE'});
        await onDeleted(id);
      } else {
        const row = await requestJson(`/request/${id}/repeat`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'}) as PurchaseRequest;
        if (!row?.id || row.id === id) throw new Error('Não foi possível identificar a nova solicitação. Atualize os dados antes de tentar novamente.');
        await onRepeated(row);
      }
      setConfirming(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível concluir a ação.'); }
    finally { pending.current = false; setBusy(null); }
  }
  const blocked = disabled || busy !== null;
  return <div onClick={event => event.stopPropagation()} className="space-y-3">
    <div className="flex flex-wrap items-center gap-2">
      {canRepeat && <button type="button" disabled={blocked || confirming} onClick={() => void act('repeat')} className={`inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 font-semibold text-white hover:bg-blue-700 disabled:opacity-50 ${compact ? 'px-3 py-2 text-[10px]' : 'px-4 py-2.5 text-xs'}`}><RotateCcw size={14} className={busy === 'repeat' ? 'animate-spin' : ''}/>{busy === 'repeat' ? 'Criando solicitação…' : 'Refazer compra'}</button>}
      <button type="button" disabled={blocked} onClick={() => {setConfirming(true); setError('');}} aria-label={`Excluir solicitação: ${product}`} title="Excluir solicitação" className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2.5 text-xs font-semibold text-slate-500 hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50"><Trash2 size={14}/>{!compact && 'Excluir solicitação'}</button>
    </div>
    {confirming && <div role="group" aria-label="Confirmar exclusão da solicitação" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
      <p className="font-semibold">Excluir esta solicitação?</p><p className="mt-2 break-words leading-relaxed">“{product}” e suas propostas, conversas e tarefas serão excluídas permanentemente. Esta ação não pode ser desfeita.</p>
      <div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={blocked} onClick={() => {setConfirming(false); setError('');}} className="rounded-lg border border-rose-200 bg-white px-3 py-2 font-semibold disabled:opacity-50">Cancelar</button><button type="button" disabled={blocked} onClick={() => void act('delete')} className="rounded-lg bg-rose-700 px-3 py-2 font-semibold text-white hover:bg-rose-800 disabled:opacity-50">{busy === 'delete' ? 'Excluindo…' : 'Confirmar exclusão'}</button></div>
    </div>}
    {error && <p role="alert" className="break-words text-xs leading-relaxed text-rose-700">{error}</p>}
  </div>;
}
