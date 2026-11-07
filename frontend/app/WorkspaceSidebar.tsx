"use client";

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Activity, Command, History, Layers3, LogOut, Settings } from 'lucide-react';
import { safeUrl, type AuthUser } from './contracts';

function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'NX';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export function UserAvatar({ url, name, sizeClass, textClass }: { url: string | null | undefined; name: string; sizeClass: string; textClass: string }) {
  const src = safeUrl(url);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  if (src && !failed) {
    return <img src={src} alt={name || 'Avatar'} referrerPolicy="no-referrer" onError={() => setFailed(true)} className={`${sizeClass} shrink-0 rounded-full object-cover ring-1 ring-slate-200`} />;
  }
  return <span className={`flex ${sizeClass} shrink-0 items-center justify-center rounded-full bg-blue-50 font-bold text-blue-700 ${textClass}`}>{initialsFromName(name || 'Equipe de compras')}</span>;
}

export default function WorkspaceSidebar({ active, total, user, onLogout }: { active: 'overview' | 'history'; total?: number; user?: AuthUser | null; onLogout?: () => void }) {
  const link = 'flex items-center gap-3 rounded-xl px-3 py-3 hover:bg-slate-50';
  return <aside aria-label="Workspace" className="fixed inset-y-0 left-0 z-20 hidden w-[218px] flex-col border-r border-slate-200/80 bg-white px-5 py-7 xl:flex">
    <Link href="/" className="flex items-center gap-2.5 px-2 text-[28px] font-bold tracking-[-0.07em]"><span className="flex size-8 items-center justify-center rounded-lg bg-blue-600 text-white"><Command size={19} /></span>nexo<span className="text-blue-600">.</span></Link>
    <p className="mb-10 ml-12 mt-1 text-[8px] font-semibold uppercase tracking-[0.2em] text-slate-400">Procurement intelligence</p>
    <p className="mb-3 px-3 text-[9px] font-semibold uppercase tracking-[0.15em] text-slate-400">Workspace</p>
    <nav aria-label="Navegação do workspace" className="space-y-1 text-xs">
      <Link href="/dashboard" aria-current={active === 'overview' ? 'page' : undefined} className={`${link} ${active === 'overview' ? 'bg-blue-50 font-semibold text-blue-700' : 'text-slate-500'}`}><Layers3 size={17} />Visão geral</Link>
      <Link href="/dashboard#kanban" className={`${link} text-slate-500`}><Activity size={17} />Solicitações{total !== undefined && <span className="ml-auto rounded bg-slate-100 px-1.5 py-0.5 text-[10px]">{total}</span>}</Link>
      <Link href="/history" aria-current={active === 'history' ? 'page' : undefined} className={`${link} ${active === 'history' ? 'bg-blue-50 font-semibold text-blue-700' : 'text-slate-500'}`}><History size={17} />Histórico</Link>
      <Link href="/settings" className={`${link} text-slate-500`}><Settings size={17} />Conexões e contatos</Link>
    </nav>
    <div className="mt-auto rounded-xl border border-blue-100 bg-gradient-to-br from-blue-50 to-white p-4"><span className="mb-2 inline-flex rounded bg-blue-100 px-1.5 py-0.5 text-[8px] font-bold tracking-wider text-blue-700">DADOS REAIS</span><p className="text-xs font-semibold">Cada preço tem uma fonte.</p><p className="mt-2 text-[10px] leading-relaxed text-slate-500">Registros de pesquisa, propostas e conversas disponíveis para conferência.</p></div>
    <div className="mt-5 flex items-center justify-between gap-2 border-t border-slate-100 px-1 pt-4">
      <div className="flex min-w-0 items-center gap-2">
        <UserAvatar url={user?.avatar_url} name={user?.name || 'Equipe de compras'} sizeClass="size-8" textClass="text-[10px]" />
        <div className="min-w-0">
          <p className="truncate text-[10px] font-semibold text-slate-800">{user?.name || 'Equipe de compras'}</p>
          <p className="truncate text-[9px] text-slate-400">{user?.email || 'Workspace local'}</p>
        </div>
      </div>
      {onLogout && (
        <button onClick={onLogout} title="Sair da conta" aria-label="Sair" className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600">
          <LogOut size={14} />
        </button>
      )}
    </div>
  </aside>;
}
