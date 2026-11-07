import Link from 'next/link';
import { ReactNode } from 'react';
import WorkspaceSidebar from '../WorkspaceSidebar';

export default function HistoryShell({ children }: { children:ReactNode }) {
  return <div className="min-h-screen bg-[#f5f7fb] text-slate-900 [color-scheme:light]">
    <a href="#history-content" className="sr-only z-50 rounded bg-white p-3 focus:not-sr-only focus:fixed focus:left-4 focus:top-4">Ir para o conteúdo</a>
    <WorkspaceSidebar active="history" />
    <div className="xl:ml-[218px]">
      <header className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-slate-200/80 bg-white px-5 py-3 sm:px-8"><div className="flex items-center gap-2 text-xs"><Link href="/" className="text-xl font-bold tracking-tight text-blue-600 xl:hidden">nexo.</Link><span className="text-slate-400">Workspace /</span><span className="font-medium">Histórico</span></div><nav aria-label="Atalhos do workspace" className="flex gap-4 text-xs text-slate-500"><Link href="/dashboard">Visão geral</Link><Link href="/history" aria-current="page" className="font-semibold text-blue-700">Histórico</Link><Link href="/settings">Conexões</Link></nav></header>
      <main id="history-content" className="mx-auto max-w-[1700px] space-y-6 p-4 sm:p-7 lg:p-8">{children}</main>
    </div>
  </div>;
}
