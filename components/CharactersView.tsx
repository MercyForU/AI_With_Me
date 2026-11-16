'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '@/lib/store';
import { ACCENT_KEYS, accentGradient, type Character, type CharacterDraft } from '@/lib/types';
import { Avatar, EmptyState, Field, Modal, Row, Section, SettingsButton } from './ui';
import {
  IconBack,
  IconDownload,
  IconMemory,
  IconPlus,
  IconSparkle,
  IconTrash,
  IconUpload,
  IconUser,
} from './icons';

const EMOJIS = ['🌙', '🔥', '🌿', '🐚', '☕️', '🦊', '🌊', '🎧', '📖', '🕯️', '🍂', '🪐'];

const EMPTY_DRAFT: CharacterDraft = {
  name: '',
  emoji: '🌙',
  accent: 'violet',
  tagline: '',
  personality: '',
  scenario: '',
  greeting: '',
  memory_note: '',
  model_id: null,
  model_label: null,
};

export default function CharactersView() {
  const {
    characters,
    activeId,
    active,
    selectCharacter,
    createCharacter,
    updateCharacter,
    deleteCharacter,
    memories,
    games,
    messages,
    models,
    exportCharacter,
    importCard,
    addMemory,
    removeMemory,
    currentModelOption,
    openSettings,
    openMemoryPanel,
    memoryStats,
    uploadAvatar,
  } = useApp();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Character | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Character | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [archived, setArchived] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const current = active;

  const memList = memories[current?.id ?? -1] ?? [];
  const gameList = games[current?.id ?? -1] ?? [];
  const msgList = messages[current?.id ?? -1] ?? [];

  const [personality, setPersonality] = useState('');
  const [tagline, setTagline] = useState('');
  const [scenario, setScenario] = useState('');
  const [memoryDraft, setMemoryDraft] = useState('');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!current) return;
    setPersonality(current.personality ?? '');
    setTagline(current.tagline ?? '');
    setScenario(current.scenario ?? '');
    setDirty(false);
  }, [current?.id, current?.personality, current?.tagline, current?.scenario, current]);

  // 归档块数：不设上限，只显示真实条数
  useEffect(() => {
    if (!current?.id) {
      setArchived(0);
      return;
    }
    let alive = true;
    void memoryStats(current.id).then((r) => {
      if (alive && r) setArchived(r.chunks);
    });
    return () => {
      alive = false;
    };
  }, [current?.id, memoryStats]);


  async function handleImport(file: File) {
    const text = await file.text();
    const created = await importCard(text);
    if (created) setMobileDetail(true);
  }

  function openCreate() {
    setEditing(null);
    setEditorOpen(true);
  }

  function openEdit(c: Character) {
    setEditing(c);
    setEditorOpen(true);
  }

  return (
    <div className="flex h-full min-h-0">
      {/* 列表 */}
      <div
        className={`${
          mobileDetail ? 'hidden' : 'flex'
        } w-full flex-col border-r border-line bg-surface/30 lg:flex lg:w-[380px] lg:shrink-0`}
      >
        <div className="flex items-center justify-between gap-2 px-5 pb-3 pt-5">
          <div className="min-w-0">
            <h2 className="truncate text-[19px] font-bold tracking-tight text-fg">我的角色</h2>
            <p className="mt-0.5 truncate text-[11.5px] text-fg-dimmer">人格、记忆、关系状态都在这里</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <SettingsButton />
            <button
              onClick={() => fileRef.current?.click()}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-line text-fg-dim transition hover:border-line-strong hover:text-fg"
              title="导入角色卡"
            >
              <IconUpload size={17} />
            </button>
            <button
              onClick={openCreate}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-brand to-brand-blue text-white transition active:scale-95"
              title="创建角色"
            >
              <IconPlus size={17} />
            </button>
          </div>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleImport(f);
            e.target.value = '';
          }}
        />

        <div className="no-scrollbar flex-1 overflow-y-auto px-3 pb-6">
          {characters.length === 0 ? (
            <EmptyState
              icon={<IconUser size={22} />}
              title="还没有角色"
              desc="创建一个属于你的角色，或者导入已有的角色卡。"
              action={
                <button onClick={openCreate} className="btn-primary mt-2">
                  <IconPlus size={16} /> 创建角色
                </button>
              }
            />
          ) : null}

          {characters.map((c) => {
            const selected = c.id === activeId;
            const mem = memories[c.id]?.length ?? 0;
            const g = games[c.id]?.length ?? 0;
            const m = messages[c.id]?.length ?? 0;
            return (
              <button
                key={c.id}
                onClick={() => {
                  selectCharacter(c.id);
                  setMobileDetail(true);
                }}
                className={`mb-2 w-full rounded-2xl border p-4 text-left transition ${
                  selected
                    ? 'border-brand/40 bg-tint/[0.06]'
                    : 'border-line bg-card/60 hover:border-line-strong'
                }`}
              >
                <div className="flex items-center gap-3">
                  <Avatar emoji={c.emoji} accent={c.accent} src={c.avatar_url} size={44} online />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className="truncate text-[14.5px] font-semibold text-fg">{c.name}</p>
                      {selected ? (
                        <span className="rounded-full bg-brand/15 px-1.5 py-0.5 text-[9px] font-medium text-brand-soft">
                          当前
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 line-clamp-1 text-[11.5px] text-fg-dimmer">
                      {c.tagline || '还没有一句话人设'}
                    </p>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <span className="chip">{currentModelOption?.name || '未配置模型'}</span>
                  <span className="chip">记忆 {mem}</span>
                  <span className="chip">Lv.{c.relationship_level} 关系</span>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-2.5 text-center">
                  {[
                    [m, '对话'],
                    [g, '游戏'],
                    [mem, '记忆'],
                  ].map(([v, l]) => (
                    <div key={String(l)}>
                      <p className="text-[13.5px] font-semibold text-fg">{v}</p>
                      <p className="text-[10px] text-fg-dimmer">{l}</p>
                    </div>
                  ))}
                </div>
              </button>
            );
          })}

          <button
            onClick={() => fileRef.current?.click()}
            className="mt-1 w-full rounded-2xl border border-dashed border-line py-5 text-center text-[12px] text-fg-dimmer transition hover:border-line-strong hover:text-fg-dim"
          >
            从文件导入角色卡（.json）
          </button>
        </div>
      </div>

      {/* 详情 */}
      <div
        className={`${
          mobileDetail ? 'flex' : 'hidden'
        } min-w-0 flex-1 flex-col lg:flex`}
      >
        {current ? (
          <>
            <header className="flex h-[60px] shrink-0 items-center gap-3 border-b border-line px-4">
              <button
                onClick={() => setMobileDetail(false)}
                className="-ml-1 rounded-full p-1.5 text-fg-dim lg:hidden"
                aria-label="返回"
              >
                <IconBack size={20} />
              </button>
              <Avatar emoji={current.emoji} accent={current.accent} src={current.avatar_url} size={34} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-semibold text-fg">{current.name}</p>
                <p className="truncate text-[11px] text-fg-dimmer">
                  {current.tagline || '还没有一句话人设'}
                </p>
              </div>
              <button onClick={() => openEdit(current)} className="btn-ghost h-9 px-3 text-[12px]">
                编辑资料
              </button>
            </header>

            <div className="flex-1 overflow-y-auto px-4 py-4 lg:px-6">
              <div className="mx-auto grid max-w-[900px] gap-3 lg:grid-cols-2">
                <Section
                  title="数据状态"
                  extra={<span className="chip">实时</span>}
                >
                  <Row label="归档记忆" value={`${archived} 块`} />
                  <Row label="手记" value={`${memList.length} 条`} />
                  <Row label="关系阶段" value={`Lv.${current.relationship_level}`} />
                  <Row label="共同经历" value={`${msgList.length} 条对话 · ${gameList.length} 局游戏`} />
                  <Row label="当前模型" value={currentModelOption?.name || '未配置'} />
                  <Row label="最近互动" value={lastActive(msgList)} />
                </Section>

                <Section
                  title="模型"
                  extra={
                    <button onClick={openSettings} className="text-[11.5px] font-medium text-brand-soft">
                      管理供应商
                    </button>
                  }
                >
                  <Row label="当前使用" value={currentModelOption?.name || '未配置'} />
                  <Row label="供应商" value={currentModelOption?.providerLabel || '—'} />
                  <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-fg-dimmer">
                    <IconSparkle size={12} className="mt-0.5 shrink-0 text-brand-soft" />
                    模型是全局设置，在聊天窗口顶部可随时切换；切换不影响人格与记忆。
                  </p>
                </Section>

                <Section
                  title="人格与场景"
                  extra={
                    dirty ? (
                      <button
                        onClick={async () => {
                          await updateCharacter(current.id, {
                            personality,
                            tagline,
                            scenario,
                          });
                          setDirty(false);
                        }}
                        className="text-[11.5px] font-medium text-brand-soft"
                      >
                        保存修改
                      </button>
                    ) : (
                      <span className="text-[10.5px] text-fg-dimmer">修改后仅影响之后的对话</span>
                    )
                  }
                >
                  <div className="space-y-3">
                    <Field label="一句话人设">
                      <input
                        className="field"
                        value={tagline}
                        maxLength={60}
                        onChange={(e) => {
                          setTagline(e.target.value);
                          setDirty(true);
                        }}
                        placeholder="温柔但有主见的陪伴者"
                      />
                    </Field>
                    <Field label="人格设定" hint={`${personality.length}/1200`}>
                      <textarea
                        className="field min-h-[110px] resize-y leading-relaxed"
                        value={personality}
                        maxLength={1200}
                        onChange={(e) => {
                          setPersonality(e.target.value);
                          setDirty(true);
                        }}
                        placeholder="说话风格、性格、底线、会怎么安慰人…"
                      />
                    </Field>
                    <Field label="背景与关系">
                      <textarea
                        className="field min-h-[70px] resize-y leading-relaxed"
                        value={scenario}
                        maxLength={600}
                        onChange={(e) => {
                          setScenario(e.target.value);
                          setDirty(true);
                        }}
                        placeholder="你们怎么认识的、现在是什么关系"
                      />
                    </Field>
                  </div>
                </Section>

                <Section
                  title="记忆管理"
                  extra={
                    <button
                      onClick={() => openMemoryPanel(current.id)}
                      className="text-[11.5px] font-medium text-brand-soft"
                    >
                      打开面板
                    </button>
                  }
                >
                  <button
                    onClick={() => openMemoryPanel(current.id)}
                    className="flex w-full items-center gap-3 rounded-xl border border-line bg-tint/[0.02] px-3 py-3 text-left transition hover:border-line-strong"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand/[0.12] text-brand-soft">
                      <IconMemory size={16} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium text-fg">
                        归档 {archived} 块 · 手记 {memList.length} 条
                      </span>
                      <span className="mt-0.5 block text-[11px] text-fg-dimmer">
                        查看原文、召回测试、逐条改写或删除
                      </span>
                    </span>
                    <span className="shrink-0 text-fg-dimmer">›</span>
                  </button>

                  <div className="mt-2.5 flex gap-1.5">
                    <input
                      value={memoryDraft}
                      onChange={(e) => setMemoryDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          void addMemory(current.id, memoryDraft);
                          setMemoryDraft('');
                        }
                      }}
                      placeholder="记一条手记，例如「他下周三有面试」"
                      className="field flex-1 py-2 text-[12.5px]"
                    />
                    <button
                      onClick={() => {
                        void addMemory(current.id, memoryDraft);
                        setMemoryDraft('');
                      }}
                      disabled={!memoryDraft.trim()}
                      className="shrink-0 rounded-xl border border-line px-3 text-fg-dim transition hover:text-fg disabled:opacity-40"
                      title="添加到手记"
                    >
                      <IconPlus size={15} />
                    </button>
                  </div>

                  {memList.length > 0 ? (
                    <div className="mt-2 max-h-[132px] space-y-1.5 overflow-y-auto pr-1">
                      {memList.slice(0, 6).map((m) => (
                        <div
                          key={m.id}
                          className="group flex items-start gap-2 rounded-lg border border-line bg-tint/[0.02] px-2.5 py-2"
                        >
                          <IconMemory size={13} className="mt-0.5 shrink-0 text-brand-soft/70" />
                          <p className="flex-1 text-[12px] leading-relaxed text-fg-dim">{m.content}</p>
                          <button
                            onClick={() => void removeMemory(m.id, current.id)}
                            className="shrink-0 text-fg-dimmer opacity-0 transition group-hover:opacity-100"
                            title="删除这条手记"
                          >
                            <IconTrash size={13} />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {current.memory_note ? (
                    <div className="mt-3 rounded-lg border border-brand/20 bg-brand/[0.06] px-2.5 py-2">
                      <p className="text-[10.5px] font-medium text-brand-soft">角色卡备注（随导出携带）</p>
                      <p className="mt-1 text-[11.5px] leading-relaxed text-fg-dim">
                        {current.memory_note}
                      </p>
                    </div>
                  ) : null}
                </Section>
              </div>

              <div className="mx-auto mt-4 flex max-w-[900px] flex-col gap-2 sm:flex-row">
                <button
                  onClick={() => void exportCharacter(current.id)}
                  className="btn-primary flex-1"
                >
                  <IconDownload size={16} />
                  导出角色卡
                </button>
                <button
                  onClick={() => setConfirmDelete(current)}
                  className="btn-ghost flex-1 text-danger hover:text-danger"
                >
                  <IconTrash size={15} />
                  删除角色
                </button>
              </div>
              <p className="mx-auto mt-3 max-w-[900px] text-center text-[11px] text-fg-dimmer">
                导出内容包含：人格 · 场景 · 记忆 · 聊天记录 · 游戏经历。导入到任何兼容环境都能还原。
              </p>
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center">
            <EmptyState
              icon={<IconUser size={22} />}
              title="选择一个角色"
              desc="左侧列表里点一个角色，查看她的数据状态。"
            />
          </div>
        )}
      </div>

      <CharacterEditor
        open={editorOpen}
        editing={editing}
        onClose={() => setEditorOpen(false)}
        onSubmit={async (draft) => {
          if (editing) {
            await updateCharacter(editing.id, {
              name: draft.name,
              emoji: draft.emoji,
              accent: draft.accent,
              avatar_url: draft.avatar_url ?? null,
              tagline: draft.tagline || null,
              personality: draft.personality || null,
              scenario: draft.scenario || null,
              greeting: draft.greeting || null,
              memory_note: draft.memory_note || null,
            });
            setEditorOpen(false);
            setMobileDetail(true);
          } else {
            const created = await createCharacter(draft);
            if (created) {
              setEditorOpen(false);
              setMobileDetail(true);
            }
          }
        }}
      />

      <Modal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title={`删除「${confirmDelete?.name ?? ''}」`}
        subtitle="角色的对话、记忆、动态与游戏经历会一起删除，无法恢复。建议先导出角色卡。"
      >
        <div className="flex gap-2">
          <button
            onClick={() => {
              if (confirmDelete) void deleteCharacter(confirmDelete.id);
              setConfirmDelete(null);
              setMobileDetail(false);
            }}
            className="flex-1 rounded-full bg-danger/90 py-2.5 text-[13px] font-semibold text-white"
          >
            确认删除
          </button>
          <button onClick={() => setConfirmDelete(null)} className="btn-ghost flex-1">
            取消
          </button>
        </div>
      </Modal>
    </div>
  );
}

function lastActive(list: { created_at: string }[]) {
  if (!list.length) return '还没有互动';
  const last = list[list.length - 1];
  const diff = Date.now() - new Date(last.created_at).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  return `${Math.floor(hour / 24)} 天前`;
}

function CharacterEditor({
  open,
  editing,
  onClose,
  onSubmit,
}: {
  open: boolean;
  editing: Character | null;
  onClose: () => void;
  onSubmit: (draft: CharacterDraft) => Promise<void>;
}) {
  const { uploadAvatar } = useApp();
  const [draft, setDraft] = useState<CharacterDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const avatarRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setDraft({
        name: editing.name,
        emoji: editing.emoji,
        accent: editing.accent,
        tagline: editing.tagline ?? '',
        personality: editing.personality ?? '',
        scenario: editing.scenario ?? '',
        greeting: editing.greeting ?? '',
        memory_note: editing.memory_note ?? '',
        model_id: editing.model_id,
        model_label: editing.model_label,
      });
    } else {
      setDraft(EMPTY_DRAFT);
    }
  }, [open, editing]);

  const valid = useMemo(() => draft.name.trim().length > 0, [draft.name]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? '编辑角色资料' : '创建角色'}
      subtitle={editing ? '只改资料，不会重写历史记忆' : '先给她一个名字和人格，其余可以随时再调'}
      width="max-w-lg"
    >
      <div className="max-h-[62vh] space-y-3.5 overflow-y-auto pr-1">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => avatarRef.current?.click()}
            className="group relative shrink-0 rounded-full"
            title="上传头像图片"
          >
            <Avatar emoji={draft.emoji} accent={draft.accent} src={draft.avatar_url} size={54} />
            <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50 text-[10px] font-medium text-white opacity-0 transition group-hover:opacity-100">
              {uploading ? '…' : '换图'}
            </span>
          </button>
          <div className="flex-1">
            <input
              className="field"
              value={draft.name}
              maxLength={20}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="角色名字，例如 小夜"
            />
            <div className="mt-1.5 flex items-center gap-2 text-[10.5px] text-fg-dimmer">
              <button
                type="button"
                onClick={() => avatarRef.current?.click()}
                className="transition hover:text-fg"
              >
                上传头像
              </button>
              {draft.avatar_url ? (
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, avatar_url: null })}
                  className="transition hover:text-danger"
                >
                  用回表情
                </button>
              ) : null}
            </div>
          </div>
          <input
            ref={avatarRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              setUploading(true);
              const url = await uploadAvatar(file);
              setUploading(false);
              if (url) setDraft((prev) => ({ ...prev, avatar_url: url }));
            }}
          />
        </div>

        <div>
          <p className="mb-1.5 text-[12px] font-medium text-fg-dim">
            形象 <span className="font-normal text-fg-dimmer">（没上传图片时显示）</span>
          </p>
          <div className="grid grid-cols-6 gap-1.5">
            {EMOJIS.map((e) => (
              <button
                key={e}
                onClick={() => setDraft({ ...draft, emoji: e })}
                className={`flex h-9 w-full items-center justify-center rounded-xl border text-[17px] transition ${
                  draft.emoji === e
                    ? 'border-brand/60 bg-brand/15'
                    : 'border-line bg-tint/[0.02] hover:border-line-strong'
                }`}
              >
                {e}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-1.5 text-[12px] font-medium text-fg-dim">主色</p>
          <div className="flex gap-2">
            {ACCENT_KEYS.map((k) => (
              <button
                key={k}
                onClick={() => setDraft({ ...draft, accent: k })}
                className={`h-8 w-8 rounded-full border-2 transition ${
                  draft.accent === k ? 'border-fg/60' : 'border-transparent opacity-70'
                }`}
                style={{ background: accentGradient(k) }}
                aria-label={k}
              />
            ))}
          </div>
        </div>

        <Field label="一句话人设" hint={`${draft.tagline.length}/60`}>
          <input
            className="field"
            value={draft.tagline}
            maxLength={60}
            onChange={(e) => setDraft({ ...draft, tagline: e.target.value })}
            placeholder="毒舌但可靠的游戏搭子"
          />
        </Field>

        <Field label="人格设定" hint="决定她怎么说话、怎么反应">
          <textarea
            className="field min-h-[96px] resize-y leading-relaxed"
            value={draft.personality}
            maxLength={1200}
            onChange={(e) => setDraft({ ...draft, personality: e.target.value })}
            placeholder="说话直接，偶尔毒舌，但关键时刻可靠…"
          />
        </Field>

        <Field label="背景与关系">
          <textarea
            className="field min-h-[64px] resize-y leading-relaxed"
            value={draft.scenario}
            maxLength={600}
            onChange={(e) => setDraft({ ...draft, scenario: e.target.value })}
            placeholder="你们是打游戏认识的搭子"
          />
        </Field>

        <Field label="开场白" hint="创建后作为第一条消息">
          <input
            className="field"
            value={draft.greeting}
            maxLength={200}
            onChange={(e) => setDraft({ ...draft, greeting: e.target.value })}
            placeholder="哟，来了？"
          />
        </Field>

        <Field label="随角色卡携带的备注" hint="可选">
          <textarea
            className="field min-h-[56px] resize-y leading-relaxed"
            value={draft.memory_note}
            maxLength={300}
            onChange={(e) => setDraft({ ...draft, memory_note: e.target.value })}
            placeholder="导出的角色卡里会带上这段说明"
          />
        </Field>
      </div>

      <div className="mt-5 flex gap-2">
        <button onClick={onClose} className="btn-ghost flex-1">
          取消
        </button>
        <button
          disabled={!valid || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onSubmit(draft);
            } finally {
              setBusy(false);
            }
          }}
          className="btn-primary flex-1"
        >
          {editing ? '保存' : '创建角色'}
        </button>
      </div>
    </Modal>
  );
}
