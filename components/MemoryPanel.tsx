'use client';

import { useCallback, useEffect, useState } from 'react';
import { useApp } from '@/lib/store';
import type { MemoryChunkItem, MemoryStats } from '@/lib/types';
import { EmptyState, Spinner } from './ui';
import { IconClose, IconEdit, IconMemory, IconPlus, IconTrash } from './icons';

const SOURCE_LABEL: Record<string, string> = {
  chat: '自动归档',
  manual: '我写的',
  model: '她记的',
  game: '一起玩的',
};

function dayLabel(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 记忆管理面板：查看 / 召回 / 编辑 / 删除 / 补写。
 * 从角色页或设置页打开，全局只挂一个（App.tsx 里渲染）。
 */
export default function MemoryPanel() {
  const {
    memoryPanel,
    closeMemoryPanel,
    characters,
    listMemoryChunks,
    updateMemoryChunk,
    createMemoryChunk,
    deleteMemoryChunk,
    memoryStats,
  } = useApp();

  const characterId = memoryPanel.characterId;
  const character = characters.find((c) => c.id === characterId) || null;

  const [items, setItems] = useState<MemoryChunkItem[]>([]);
  const [total, setTotal] = useState(0);
  const [mode, setMode] = useState<'recent' | 'recall'>('recent');
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [q, setQ] = useState('');
  const [addText, setAddText] = useState('');
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const load = useCallback(
    async (query: string, offset = 0) => {
      if (!characterId) return;
      setLoading(true);
      const r = await listMemoryChunks(characterId, { q: query, limit: 20, offset });
      setItems((prev) => (offset > 0 ? [...prev, ...r.items] : r.items));
      setTotal(r.total);
      setMode(r.mode === 'recall' ? 'recall' : 'recent');
      setEditingId(null);
      setExpandedId(null);
      setConfirmId(null);
      setLoading(false);
    },
    [characterId, listMemoryChunks],
  );

  useEffect(() => {
    if (!memoryPanel.open || !characterId) return;
    setQ('');
    setAddText('');
    void load('');
    void memoryStats(characterId).then((r) => r && setStats(r));
  }, [memoryPanel.open, characterId, load, memoryStats]);

  useEffect(() => {
    if (!memoryPanel.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMemoryPanel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [memoryPanel.open, closeMemoryPanel]);

  if (!memoryPanel.open) return null;

  async function save(id: string) {
    const text = editDraft.trim();
    if (!text) return;
    setSaving(true);
    const ok = await updateMemoryChunk(id, text);
    setSaving(false);
    if (!ok) return;
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, content: text } : it)));
    setEditingId(null);
    if (characterId) void memoryStats(characterId).then((r) => r && setStats(r));
  }

  async function add() {
    const text = addText.trim();
    if (!text || !characterId) return;
    setAdding(true);
    const ok = await createMemoryChunk(characterId, text);
    setAdding(false);
    if (!ok) return;
    setAddText('');
    void load('');
    if (characterId) void memoryStats(characterId).then((r) => r && setStats(r));
  }

  async function remove(id: string) {
    const ok = await deleteMemoryChunk(id);
    if (!ok) return;
    setItems((prev) => prev.filter((it) => it.id !== id));
    setTotal((t) => Math.max(0, t - 1));
    setConfirmId(null);
    if (characterId) void memoryStats(characterId).then((r) => r && setStats(r));
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-overlay backdrop-blur-sm sm:items-center sm:p-6"
      onClick={closeMemoryPanel}
      role="presentation"
    >
      <div
        className="flex h-full w-full flex-col border-line bg-surface sm:h-auto sm:max-h-[86vh] sm:max-w-[720px] sm:rounded-3xl sm:border sm:shadow-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="记忆管理"
      >
        {/* 头部 */}
        <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand/[0.12] text-brand-soft">
            <IconMemory size={17} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-semibold text-fg">记忆管理</p>
            <p className="truncate text-[11px] text-fg-dimmer">
              {character ? `${character.name} · ` : ''}
              归档 {stats?.chunks ?? total} 块 · {stats?.tokens ?? 0} token
              {stats?.pending ? ` · 待归档 ${stats.pending} 条` : ''}
            </p>
          </div>
          <button
            onClick={closeMemoryPanel}
            className="rounded-full p-2 text-fg-dimmer transition hover:bg-tint/5 hover:text-fg"
            aria-label="关闭"
          >
            <IconClose size={18} />
          </button>
        </div>

        {/* 搜索 + 添加 */}
        <div className="shrink-0 space-y-2 border-b border-line px-4 py-3">
          <div className="flex gap-1.5">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void load(q);
              }}
              placeholder="搜一句试试能召回什么，例如「面试」"
              className="field py-2 text-[12.5px]"
            />
            <button
              onClick={() => void load(q)}
              disabled={loading}
              className="btn-ghost shrink-0 px-3 text-[12px]"
            >
              {q.trim() ? '召回' : '刷新'}
            </button>
          </div>
          <div className="flex gap-1.5">
            <input
              value={addText}
              onChange={(e) => setAddText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void add();
              }}
              placeholder="手动记一条，例如「他下周三有面试」"
              maxLength={2000}
              className="field py-2 text-[12.5px]"
            />
            <button
              onClick={() => void add()}
              disabled={adding || !addText.trim()}
              className="shrink-0 rounded-xl bg-brand/15 px-3 text-brand-soft transition disabled:opacity-40"
              title="添加记忆"
            >
              <IconPlus size={15} />
            </button>
          </div>
          <div className="flex items-center justify-between text-[10.5px] text-fg-dimmer">
            <span>
              {mode === 'recall' ? `召回 ${items.length} 条` : `最近 ${items.length} 条 · 共 ${total} 条`}
            </span>
            <span>点内容可展开原文</span>
          </div>
        </div>

        {/* 列表 */}
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3">
          {loading && items.length === 0 ? (
            <div className="flex justify-center py-10">
              <Spinner size={18} />
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={<IconMemory size={20} />}
              title={mode === 'recall' ? '没有召回任何记忆' : '还没有归档的记忆'}
              desc={
                mode === 'recall'
                  ? '换个说法试试，或者点「刷新」看最近的记忆。'
                  : '聊够 20 多条之后，滑出窗口的对话会自动总结成记忆。'
              }
            />
          ) : (
            items.map((it) => {
              const editing = editingId === it.id;
              const expanded = expandedId === it.id;
              return (
                <div
                  key={it.id}
                  className={`rounded-xl border p-3 transition ${
                    editing ? 'border-brand/40 bg-brand/[0.05]' : 'border-line bg-tint/[0.02]'
                  }`}
                >
                  <div className="flex items-center gap-2 text-[10.5px] text-fg-dimmer">
                    <span className="rounded-full bg-tint/[0.06] px-1.5 py-0.5">
                      {SOURCE_LABEL[it.source || 'chat'] || '记忆'}
                    </span>
                    <span>{dayLabel(it.createdAt)}</span>
                    {it.score !== undefined && it.vec !== null && it.vec !== undefined ? (
                      <span className="text-brand-soft/70">相关 {Math.round((it.vec || 0) * 100)}%</span>
                    ) : null}
                    <div className="ml-auto flex items-center gap-1">
                      {it.raw ? (
                        <button
                          onClick={() => setExpandedId(expanded ? null : it.id)}
                          className="rounded-md px-1.5 py-0.5 text-[10.5px] text-fg-dim transition hover:text-fg"
                        >
                          {expanded ? '收起' : '原文'}
                        </button>
                      ) : null}
                      <button
                        onClick={() => {
                          setEditingId(editing ? null : it.id);
                          setEditDraft(it.content);
                        }}
                        className="rounded-md p-1 text-fg-dimmer transition hover:text-brand-soft"
                        title="编辑"
                      >
                        <IconEdit size={13} />
                      </button>
                      <button
                        onClick={() => setConfirmId(confirmId === it.id ? null : it.id)}
                        className="rounded-md p-1 text-fg-dimmer transition hover:text-danger"
                        title="删除"
                      >
                        <IconTrash size={13} />
                      </button>
                    </div>
                  </div>

                  {editing ? (
                    <div className="mt-2">
                      <textarea
                        autoFocus
                        value={editDraft}
                        maxLength={2000}
                        onChange={(e) => setEditDraft(e.target.value)}
                        className="field min-h-[92px] resize-y text-[12.5px] leading-relaxed"
                      />
                      <div className="mt-2 flex items-center gap-1.5">
                        <button
                          onClick={() => void save(it.id)}
                          disabled={saving || !editDraft.trim()}
                          className="rounded-lg bg-brand/20 px-3 py-1 text-[11.5px] font-medium text-brand-soft disabled:opacity-40"
                        >
                          {saving ? '保存中…' : '保存'}
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          className="rounded-lg border border-line px-3 py-1 text-[11.5px] text-fg-dim"
                        >
                          取消
                        </button>
                        <span className="ml-auto tabular-nums text-[10px] text-fg-dimmer">
                          {editDraft.length}/2000
                        </span>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-1.5 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-fg">
                      {it.content}
                    </p>
                  )}

                  {expanded && it.raw ? (
                    <pre className="mt-2 max-h-[220px] overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-ink/40 p-2.5 font-mono text-[11px] leading-relaxed text-fg-dim">
                      {it.raw}
                    </pre>
                  ) : null}

                  {confirmId === it.id ? (
                    <div className="mt-2 flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/[0.06] px-2.5 py-2">
                      <p className="flex-1 text-[11px] text-danger">删掉这条？删了就找不回来了</p>
                      <button
                        onClick={() => void remove(it.id)}
                        className="rounded-md bg-danger/85 px-2.5 py-1 text-[11px] font-medium text-white"
                      >
                        删除
                      </button>
                      <button
                        onClick={() => setConfirmId(null)}
                        className="rounded-md border border-line px-2.5 py-1 text-[11px] text-fg-dim"
                      >
                        取消
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })
          )}

          {mode === 'recent' && total > items.length ? (
            <button
              onClick={() => void load('', items.length)}
              disabled={loading}
              className="w-full rounded-xl border border-dashed border-line py-2.5 text-[11.5px] text-fg-dim transition hover:border-line-strong hover:text-fg disabled:opacity-50"
            >
              {loading ? '加载中…' : `加载更多（还有 ${total - items.length} 条）`}
            </button>
          ) : null}
        </div>

        <p className="shrink-0 border-t border-line px-4 py-2.5 text-[10.5px] leading-relaxed text-fg-dimmer">
          改完会重新算向量，之后的对话按新内容召回；原文是归档前的聊天记录，只读。
        </p>
      </div>
    </div>
  );
}
