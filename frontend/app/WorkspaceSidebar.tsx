import Link from 'next/link';
import { Activity, Command, History, Layers3, Settings } from 'lucide-react';

export default function WorkspaceSidebar({ active, total }: { active: 'overview' | 'history'; total?: number }) {
  const link = 'flex items-center gap-3 rounded-xl px-3 py-3 hover:bg-slate-50';
  return <aside aria-label="Workspace" className="fixed inset-y-0 left-0 z-20 hidden w-[218px] flex-col border-r border-slate-200/80 bg-white px-5 py-7 xl:flex">
    <Link href="/" className="flex items-center gap-2.5 px-2 text-[28px] font-bold tracking-[-0.07em]"><span className="flex size-8 items-center justify-center rounded-lg bg-blue-600 text-white"><Command size={19} /></span>nexo<span className="text-blue-600">.</span></Link>
    <p className="mb-10 ml-12 mt-1 text-[8px] font-semibold uppercase tracking-[0.2em] text-slate-400">Procurement intelligence</p>
    <p className="mb-3 px-3 text-[9px] font-semibold uppercase tracking-[0.15em] text-slate-400">Workspace</p>
    <nav aria-label="Navegação do workspace" className="space-y-1 text-xs">
      <Link href="/" aria-current={active === 'overview' ? 'page' : undefined} className={`${link} ${active === 'overview' ? 'bg-blue-50 font-semibold text-blue-700' : 'text-slate-500'}`}><Layers3 size={17} />Visão geral</Link>
      <Link href="/#kanban" className={`${link} text-slate-500`}><Activity size={17} />Solicitações{total !== undefined && <span className="ml-auto rounded bg-slate-100 px-1.5 py-0.5 text-[10px]">{total}</span>}</Link>
      <Link href="/history" aria-current={active === 'history' ? 'page' : undefined} className={`${link} ${active === 'history' ? 'bg-blue-50 font-semibold text-blue-700' : 'text-slate-500'}`}><History size={17} />Histórico</Link>
      <Link href="/settings" className={`${link} text-slate-500`}><Settings size={17} />Conexões e contatos</Link>
    </nav>
    <div className="mt-auto rounded-xl border border-blue-100 bg-gradient-to-br from-blue-50 to-white p-4"><span className="mb-2 inline-flex rounded bg-blue-100 px-1.5 py-0.5 text-[8px] font-bold tracking-wider text-blue-700">DADOS REAIS</span><p className="text-xs font-semibold">Cada preço tem uma fonte.</p><p className="mt-2 text-[10px] leading-relaxed text-slate-500">Registros de pesquisa, propostas e conversas disponíveis para conferência.</p></div>
    <div className="mt-5 flex items-center gap-2 px-2"><span className="flex size-8 items-center justify-center rounded-full bg-slate-100 text-[10px] font-semibold text-slate-600">CP</span><div><p className="text-[10px] font-semibold">Equipe de compras</p><p className="text-[9px] text-slate-400">Workspace local</p></div></div>
  </aside>;
}
