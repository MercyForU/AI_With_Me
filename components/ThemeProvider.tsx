'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { IconMonitor, IconMoon, IconSun } from './icons';

export type ThemeMode = 'light' | 'dark' | 'system';
type Resolved = 'light' | 'dark';

const STORAGE_KEY = 'nuan-theme';

type ThemeCtx = {
  mode: ThemeMode;
  resolved: Resolved;
  setMode: (mode: ThemeMode) => void;
};

const Ctx = createContext<ThemeCtx | null>(null);

export function useTheme(): ThemeCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}

function systemTheme(): Resolved {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readMode(): ThemeMode {
  if (typeof window === 'undefined') return 'system';
  const saved = window.localStorage.getItem(STORAGE_KEY);
  return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
}

function apply(mode: ThemeMode): Resolved {
  const resolved: Resolved = mode === 'system' ? systemTheme() : mode;
  document.documentElement.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#08080d' : '#f6f9f7');
  return resolved;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('system');
  const [resolved, setResolved] = useState<Resolved>('dark');

  useEffect(() => {
    const initial = readMode();
    setModeState(initial);
    setResolved(apply(initial));
  }, []);

  // 跟随系统时，监听系统主题变化
  useEffect(() => {
    if (mode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setResolved(apply('system'));
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [mode]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* 隐私模式下忽略 */
    }
    setResolved(apply(next));
  }, []);

  const value = useMemo(() => ({ mode, resolved, setMode }), [mode, resolved, setMode]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const OPTIONS: { key: ThemeMode; label: string; icon: typeof IconSun }[] = [
  { key: 'light', label: '浅色', icon: IconSun },
  { key: 'dark', label: '深色', icon: IconMoon },
  { key: 'system', label: '随系统', icon: IconMonitor },
];

export function ThemeSwitch({ compact = false }: { compact?: boolean }) {
  const { mode, setMode } = useTheme();

  return (
    <div
      className={`grid grid-cols-3 gap-1 rounded-full border border-line bg-tint/[0.03] p-1 ${
        compact ? 'w-full' : 'w-full'
      }`}
      role="group"
      aria-label="外观主题"
    >
      {OPTIONS.map(({ key, label, icon: Icon }) => {
        const on = mode === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => setMode(key)}
            aria-pressed={on}
            className={`flex items-center justify-center gap-1.5 rounded-full py-1.5 text-[12px] font-medium transition ${
              on
                ? 'bg-surface text-fg shadow-sm ring-1 ring-line'
                : 'text-fg-dimmer hover:text-fg-dim'
            }`}
          >
            <Icon size={13} />
            {label}
          </button>
        );
      })}
    </div>
  );
}
