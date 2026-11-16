'use client';

import { useState } from 'react';
import { useApp } from '@/lib/store';
import { Avatar, EmptyState, Modal, SettingsButton, Spinner } from './ui';
import { IconGlobe, IconHeart, IconPlus, IconSparkle, IconTrash } from './icons';

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

export default function CircleView() {
  const { posts, characters, createPost, toggleLike, deletePost } = useApp();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  const byId = new Map(characters.map((c) => [c.id, c]));

  async function trigger(characterId: number) {
    setBusyId(characterId);
    try {
      await createPost(characterId);
      setPickerOpen(false);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-[60px] shrink-0 items-center justify-between gap-2 border-b border-line px-5">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="text-[19px] font-bold tracking-tight text-fg">圈子</h2>
          <span className="chip">封闭测试</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={() => setPickerOpen(true)}
            disabled={characters.length === 0}
            className="btn-ghost h-9 px-3 text-[12.5px]"
          >
            <IconSparkle size={14} className="text-brand-soft" />
            让角色发动态
          </button>
          <SettingsButton />
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-5">
        <div className="mx-auto max-w-[620px]">
          <div className="mb-4 rounded-2xl border border-brand/20 bg-brand/[0.06] px-4 py-3">
            <p className="flex items-center gap-1.5 text-[12px] font-medium text-brand-soft">
              <IconGlobe size={13} />
              这里只有你自己的角色
            </p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-fg-dim">
              第一阶段不做开放广场。角色动态由你授权触发，不会自己发帖。开放圈子会在审核能力就绪后再推进。
            </p>
          </div>

          {posts.length === 0 ? (
            <EmptyState
              icon={<IconGlobe size={22} />}
              title="还没有动态"
              desc="点右上角「让角色发动态」，她会根据你们最近的对话写一条。"
              action={
                <button
                  onClick={() => setPickerOpen(true)}
                  disabled={characters.length === 0}
                  className="btn-primary mt-2"
                >
                  <IconSparkle size={15} />
                  让角色发一条
                </button>
              }
            />
          ) : null}

          {posts.map((p) => {
            const c = p.character_id ? byId.get(p.character_id) : undefined;
            return (
              <article key={p.id} className="card mb-3 p-4">
                <div className="flex items-center gap-2.5">
                  <Avatar emoji={c?.emoji ?? '🌙'} accent={c?.accent} src={c?.avatar_url} size={38} />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 text-[13.5px] font-semibold text-fg">
                      {c?.name ?? '角色'}
                      <span className="rounded bg-brand-blue/15 px-1.5 py-[1px] text-[9px] font-semibold text-brand-blue">
                        AI
                      </span>
                    </p>
                    <p className="text-[10.5px] text-fg-dimmer">{timeAgo(p.created_at)} · 来自角色动态</p>
                  </div>
                  <button
                    onClick={() => void deletePost(p.id)}
                    className="rounded-lg p-1.5 text-fg-dimmer transition hover:text-danger"
                    title="删除动态"
                  >
                    <IconTrash size={14} />
                  </button>
                </div>

                <p className="mt-3 whitespace-pre-wrap text-[13.5px] leading-[1.7] text-fg">
                  {p.content}
                </p>

                <div className="mt-3 flex items-center gap-4 border-t border-line pt-2.5">
                  <button
                    onClick={() => void toggleLike(p.id)}
                    className={`flex items-center gap-1.5 text-[12px] transition ${
                      p.liked ? 'text-danger' : 'text-fg-dim hover:text-fg'
                    }`}
                  >
                    <IconHeart size={15} filled={p.liked} />
                    {p.likes}
                  </button>
                  <span className="text-[11px] text-fg-dimmer">AI 生成内容</span>
                </div>
              </article>
            );
          })}
        </div>
      </div>

      {/* 移动端浮动按钮 */}
      <button
        onClick={() => setPickerOpen(true)}
        disabled={characters.length === 0}
        className="fixed bottom-[84px] right-5 z-30 flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-brand to-brand-blue text-white shadow-glow transition active:scale-95 disabled:opacity-40 lg:hidden"
        aria-label="让角色发动态"
      >
        <IconPlus size={22} />
      </button>

      <Modal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="让谁发一条动态？"
        subtitle="她会结合你们最近的对话来写，发出来之前不会自动发布。"
      >
        <div className="space-y-2">
          {characters.map((c) => (
            <button
              key={c.id}
              onClick={() => void trigger(c.id)}
              disabled={busyId !== null}
              className="flex w-full items-center gap-3 rounded-xl border border-line bg-tint/[0.02] px-3 py-2.5 text-left transition hover:border-line-strong disabled:opacity-60"
            >
              <Avatar emoji={c.emoji} accent={c.accent} src={c.avatar_url} size={36} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-fg">{c.name}</p>
                <p className="truncate text-[11px] text-fg-dimmer">{c.tagline || '还没有人设'}</p>
              </div>
              {busyId === c.id ? <Spinner size={15} /> : <IconSparkle size={15} className="text-brand-soft" />}
            </button>
          ))}
        </div>
      </Modal>
    </div>
  );
}
