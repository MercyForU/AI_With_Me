'use client';

import React, { useEffect } from 'react';
import { accentGradient } from '@/lib/types';
import { assetUrl } from '@/lib/base';
import { useApp } from '@/lib/store';
import { IconCheck, IconClose, IconInfo, IconSettings } from './icons';

/**
 * 设置入口：只放在三个主 tab 页面的头部右上角，跟着布局走，不做浮层。
 * PC 上左侧栏已有入口，这里隐藏，避免出现两个设置按钮。
 */
export function SettingsButton({ className = '' }: { className?: string }) {
  const { openSettings } = useApp();
  return (
    <button
      onClick={openSettings}
      aria-label="设置"
      title="设置"
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-tint/[0.03] text-fg-dim transition hover:border-line-strong hover:text-fg active:scale-95 lg:hidden ${className}`}
    >
      <IconSettings size={17} />
    </button>
  );
}

export function Avatar({
  emoji,
  accent,
  size = 44,
  online,
  ring,
  className = '',
  src,
}: {
  emoji: string;
  accent?: string | null;
  size?: number;
  online?: boolean;
  ring?: boolean;
  className?: string;
  src?: string | null;
}) {
  return (
    <div
      className={`relative shrink-0 select-none overflow-hidden rounded-full ${
        ring ? 'ring-2 ring-tint/10' : ''
      } ${className}`}
      style={{
        width: size,
        height: size,
        background: src ? 'rgb(var(--raise))' : accentGradient(accent),
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: Math.round(size * 0.46),
        lineHeight: 1,
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18)',
      }}
    >
      {src ? (
        <img src={assetUrl(src)} alt="" className="h-full w-full object-cover" draggable={false} />
      ) : (
        <span style={{ transform: 'translateY(0.5px)' }}>{emoji}</span>
      )}
      {online ? (
        <span
          className="absolute bottom-0 right-0 rounded-full border-2 border-ink bg-ok"
          style={{ width: Math.max(9, size * 0.26), height: Math.max(9, size * 0.26) }}
        />
      ) : null}
    </div>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span
      className="inline-block animate-spin rounded-full border-2 border-line-strong border-t-brand-soft"
      style={{ width: size, height: size }}
    />
  );
}

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 'max-w-md',
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-overlay p-0 backdrop-blur-sm sm:items-center sm:p-6"
      onClick={onClose}
      role="presentation"
    >
      <div
        className={`w-full ${width} animate-pop-in rounded-t-3xl border border-line bg-card p-6 shadow-panel sm:rounded-3xl`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {(title || subtitle) && (
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              {title ? <h3 className="text-lg font-semibold text-fg">{title}</h3> : null}
              {subtitle ? <p className="mt-1 text-[13px] leading-relaxed text-fg-dim">{subtitle}</p> : null}
            </div>
            <button
              onClick={onClose}
              className="-mr-1 -mt-1 rounded-full p-2 text-fg-dimmer transition hover:bg-tint/5 hover:text-fg"
              aria-label="关闭"
            >
              <IconClose size={18} />
            </button>
          </div>
        )}
        <div>{children}</div>
        {footer ? <div className="mt-6">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Toasts({
  toasts,
  onDismiss,
}: {
  toasts: { id: number; text: string; tone: 'ok' | 'err' }[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[60] flex flex-col items-center gap-2 px-4 lg:bottom-8 lg:right-8 lg:left-auto lg:items-end">
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => onDismiss(t.id)}
          className="pointer-events-auto flex animate-fade-up items-center gap-2 rounded-full border border-line bg-raise/95 px-4 py-2.5 text-[13px] text-fg shadow-panel backdrop-blur"
        >
          <span className={t.tone === 'err' ? 'text-danger' : 'text-ok'}>
            {t.tone === 'err' ? <IconInfo size={15} /> : <IconCheck size={15} />}
          </span>
          {t.text}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  desc,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  desc?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      {icon ? (
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-line bg-tint/[0.03] text-fg-dim">
          {icon}
        </div>
      ) : null}
      <p className="text-sm font-medium text-fg">{title}</p>
      {desc ? <p className="max-w-xs text-[13px] leading-relaxed text-fg-dimmer">{desc}</p> : null}
      {action}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline justify-between gap-3 text-[12px] font-medium text-fg-dim">
        <span className="shrink-0">{label}</span>
        {hint ? (
          <span className="text-right text-[11px] font-normal leading-snug text-fg-dimmer">{hint}</span>
        ) : null}
      </span>
      {children}
    </label>
  );
}

export function Section({
  title,
  extra,
  children,
}: {
  title: string;
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="text-[12px] font-semibold uppercase tracking-wider text-fg-dimmer">{title}</h4>
        {extra}
      </div>
      {children}
    </section>
  );
}

export function Row({
  label,
  value,
  className = '',
}: {
  label: string;
  value: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-center justify-between gap-4 py-2 text-[13px] ${className}`}>
      <span className="shrink-0 text-fg-dim">{label}</span>
      <span className="truncate text-right font-medium text-fg">{value}</span>
    </div>
  );
}
