'use client';

import { useState } from 'react';
import { assetUrl } from '@/lib/base';
import { AppProvider, useApp } from '@/lib/store';
import { ThemeProvider } from './ThemeProvider';
import AuthGate from './AuthGate';
import ChatView from './ChatView';
import CharactersView from './CharactersView';
import CircleView from './CircleView';
import Settings from './Settings';
import MemoryPanel from './MemoryPanel';
import { Toasts } from './ui';
import { IconChat, IconGlobe, IconSettings, IconUser } from './icons';

type Tab = 'chat' | 'characters' | 'circle';

const TABS: { key: Tab; label: string; icon: typeof IconChat }[] = [
  { key: 'chat', label: '聊天', icon: IconChat },
  { key: 'characters', label: '角色', icon: IconUser },
  { key: 'circle', label: '圈子', icon: IconGlobe },
];

export default function App() {
  return (
    <ThemeProvider>
      <AppProvider>
        <Root />
      </AppProvider>
    </ThemeProvider>
  );
}

function Root() {
  const { ready, authed, toasts, dismissToast } = useApp();
  if (!ready) {
    return (
      <div className="flex h-dvh items-center justify-center bg-ink">
        <div className="h-9 w-9 animate-spin rounded-full border-2 border-line border-t-brand" />
      </div>
    );
  }

  return (
    <>
      {authed ? <Shell /> : <AuthGate />}
      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}

export function Shell() {
  const { user, characters, openSettings, rebuild } = useApp();
  const [tab, setTab] = useState<Tab>('chat');

  const rebuilding = rebuild?.status === 'running';
  const pct = rebuild?.total
    ? Math.min(100, Math.round((rebuild.done / rebuild.total) * 100))
    : 0;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-ink lg:flex-row">
      {/* 后台重建进度：只有一条线，不挡任何操作 */}
      {rebuilding ? (
        <div
          className="pointer-events-none fixed inset-x-0 top-0 z-50 h-[2px] bg-tint/[0.07]"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="正在优化历史记忆"
        >
          <div
            className="h-full bg-gradient-to-r from-brand to-brand-blue transition-[width] duration-700"
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : null}
      {/* PC 侧边栏 */}
      <aside className="hidden w-[232px] shrink-0 flex-col border-r border-line bg-surface/50 lg:flex">
        <div className="flex items-center gap-2.5 px-5 pb-2 pt-6">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand to-brand-blue text-[15px] font-bold text-white shadow-glow">
            暧
          </div>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold tracking-tight text-fg">暧</p>
            <p className="truncate text-[11px] text-fg-dimmer">本机版 · 数据在自己电脑</p>
          </div>
        </div>

        <nav className="mt-5 space-y-1 px-3">
          {TABS.map(({ key, label, icon: Icon }) => {
            const activeTab = tab === key;
            return (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[13.5px] font-medium transition ${
                  activeTab ? 'bg-tint/[0.07] text-fg' : 'text-fg-dim hover:bg-tint/[0.03] hover:text-fg'
                }`}
              >
                <Icon size={18} className={activeTab ? 'text-brand-soft' : 'text-fg-dimmer'} />
                {label}
                {key === 'characters' && characters.length > 0 ? (
                  <span className="ml-auto rounded-full bg-tint/[0.06] px-1.5 py-0.5 text-[10px] text-fg-dimmer">
                    {characters.length}
                  </span>
                ) : null}
                {activeTab ? <span className="ml-auto h-1.5 w-1.5 rounded-full bg-brand-soft" /> : null}
              </button>
            );
          })}
        </nav>

        <div className="mx-3 mt-6 rounded-xl border border-line bg-tint/[0.02] p-3">
          <p className="text-[11px] font-medium text-fg-dim">数据所有权</p>
          <p className="mt-1 text-[11px] leading-relaxed text-fg-dimmer">
            全部数据在 data/app.db，复制文件即可备份，也可整包导出角色卡。
          </p>
        </div>

        <div className="mt-auto p-3">
          <div className="flex items-center gap-2.5 rounded-xl px-2 py-2">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-tint/[0.08] text-[12px] font-semibold text-fg">
              {user?.avatar ? (
                <img src={assetUrl(user.avatar)} alt="" className="h-full w-full object-cover" />
              ) : (
                (user?.name || '我').slice(0, 1)
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12.5px] font-medium text-fg">{user?.name || '我'}</p>
              <p className="truncate text-[10.5px] text-fg-dimmer">本机服务运行中</p>
            </div>
            <button
              onClick={openSettings}
              className="rounded-lg p-1.5 text-fg-dimmer transition hover:bg-tint/5 hover:text-fg"
              aria-label="设置"
              title="设置"
            >
              <IconSettings size={16} />
            </button>
          </div>
        </div>
      </aside>

      {/* 主内容 */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {tab === 'chat' ? <ChatView /> : null}
        {tab === 'characters' ? <CharactersView /> : null}
        {tab === 'circle' ? <CircleView /> : null}
      </main>

      {/* 移动端底部导航 */}
      <nav className="glass flex min-h-[64px] shrink-0 items-stretch border-t border-line pb-[env(safe-area-inset-bottom)] lg:hidden">
        {TABS.map(({ key, label, icon: Icon }) => {
          const activeTab = tab === key;
          return (
            <button
              key={key}
              onClick={() => setTab(key)}
              className="relative flex flex-1 flex-col items-center justify-center gap-1"
            >
              <Icon size={21} className={activeTab ? 'text-brand-soft' : 'text-fg-dimmer'} />
              <span className={`text-[10px] font-medium ${activeTab ? 'text-brand-soft' : 'text-fg-dimmer'}`}>
                {label}
              </span>
              {activeTab ? <span className="absolute top-0 h-[2px] w-8 rounded-full bg-brand-soft" /> : null}
            </button>
          );
        })}
      </nav>

      <Settings />
      <MemoryPanel />
    </div>
  );
}
