'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '@/lib/store';
import { createRecognizer, speak, sttSupported } from '@/lib/speech';
import { assetUrl } from '@/lib/base';
import { accentGradient, type Character, type Message } from '@/lib/types';
import { Avatar, EmptyState, Modal, SettingsButton } from './ui';
import {
  IconBack,
  IconChat,
  IconCheck,
  IconChevronDown,
  IconDownload,
  IconGame,
  IconInfo,
  IconMemory,
  IconMic,
  IconPlus,
  IconRefresh,
  IconSend,
  IconSparkle,
  IconSpeaker,
  IconStop,
} from './icons';
import GameHub from './GameHub';
import ImageViewer from './ImageViewer';

function timeLabel(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function shouldShowTime(prev: Message | undefined, cur: Message) {
  if (!prev) return true;
  return new Date(cur.created_at).getTime() - new Date(prev.created_at).getTime() > 5 * 60 * 1000;
}

/** 画图标记只给服务端看，任何展示前都要摘掉 */
function stripDrawMarker(text: string): string {
  return String(text || '')
    .replace(/\[\[\s*(?:img|image|picture|图片|画|图)\s*[:：][\s\S]*?\]\]/gi, '')
    .replace(/【\s*(?:img|image|图片|画|图)\s*[:：][^】]*】/gi, '')
    .trim();
}

export default function ChatView() {
  const {
    characters,
    active,
    activeId,
    selectCharacter,
    messages,
    memories,
    games,
    streaming,
    streamingText,
    pendingReply,
    sendMessage,
    stopStreaming,
    models,
    exportCharacter,
    askExportChat,
    addMemory,
    loadingChar,
    currentModelOption,
    setCurrentModel,
    setCharacterModel,
    modelOptionFor,
    openSettings,
    user,
    memoryStats,
    resetContext,
    notify,
    setChatDetailOpen,
  } = useApp();

  const [draft, setDraft] = useState('');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [gameOpen, setGameOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [viewerSrc, setViewerSrc] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [archived, setArchived] = useState(0);
  const [listening, setListening] = useState(false);
  const [modelQuery, setModelQuery] = useState('');
  const [memoryDraft, setMemoryDraft] = useState('');
  const scrollerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const activeModel = modelOptionFor(activeId);
  const showChatOnMobile = Boolean(mobileOpen && active);
  const list = messages[activeId ?? -1] ?? [];
  const memList = memories[activeId ?? -1] ?? [];
  const gameList = games[activeId ?? -1] ?? [];

  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  const jumpToBottom = useCallback(() => {
    atBottomRef.current = true;
    setAtBottom(true);
    scrollToBottom('smooth');
  }, [scrollToBottom]);

  // 自动跟随：只在本来就贴底时滚，往上翻历史时别打断
  useEffect(() => {
    if (!atBottomRef.current) return;
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: streaming ? 'auto' : 'smooth' });
  }, [list.length, streamingText, streaming, activeId]);

  // 记录当前是不是在底部（留 80px 容差）
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      const near = gap < 80;
      atBottomRef.current = near;
      setAtBottom(near);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, [activeId, showChatOnMobile]);

  // 键盘弹出会把可视区压矮，贴底的话要继续贴住
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      if (!atBottomRef.current) return;
      const el = scrollerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    };
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, []);

  // 进对话、移动端切到详情时，先落到最新一条
  useEffect(() => {
    if (!showChatOnMobile && activeId === null) return;
    const t = window.setTimeout(() => {
      atBottomRef.current = true;
      setAtBottom(true);
      scrollToBottom('auto');
    }, 60);
    return () => window.clearTimeout(t);
  }, [activeId, showChatOnMobile, scrollToBottom]);

  // 让外层知道「移动端正停在对话里」，好把底部 tab 收起来
  useEffect(() => {
    setChatDetailOpen(Boolean(mobileOpen && active));
  }, [mobileOpen, active, setChatDetailOpen]);
  useEffect(() => () => setChatDetailOpen(false), [setChatDetailOpen]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const next = el.scrollHeight;
    // 面板初始为隐藏时 scrollHeight 为 0，此时保持 auto，避免把输入框压成 0 高
    if (next > 0) el.style.height = `${Math.min(Math.max(next, 24), 132)}px`;
  }, [draft, mobileOpen]);

  useEffect(() => {
    if (!active?.id) {
      setArchived(0);
      return;
    }
    let alive = true;
    void memoryStats(active.id).then((r) => {
      if (alive && r) setArchived(r.chunks);
    });
    return () => {
      alive = false;
    };
  }, [active?.id, list.length, memoryStats]);

  // 语音输入：用浏览器自带识别，说完把文字并进草稿，不自动发送
  const recogRef = useRef<ReturnType<typeof createRecognizer>>(null);
  const toggleMic = useCallback(() => {
    if (listening) {
      recogRef.current?.stop();
      return;
    }
    if (!sttSupported()) {
      notify(
        location.protocol === 'http:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1'
          ? '浏览器只允许在 localhost 或 HTTPS 下录音。局域网 IP 访问时用不了语音输入，可以先用打字。'
          : '这个浏览器不支持语音识别，换 Chrome / Edge 试试。',
        'err',
      );
      return;
    }
    const r = createRecognizer('zh-CN');
    if (!r) return;
    let base = draft;
    r.onresult = (e) => {
      let text = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        text += e.results[i][0].transcript;
      }
      if (text) setDraft((base ? base + ' ' : '') + text);
    };
    r.onerror = (e) => {
      setListening(false);
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        notify('没有麦克风权限，或浏览器语音服务不可用', 'err');
      } else if (e.error !== 'aborted' && e.error !== 'no-speech') {
        notify(`语音识别失败：${e.error}`, 'err');
      }
    };
    r.onend = () => setListening(false);
    recogRef.current = r;
    try {
      r.start();
      setListening(true);
      base = draft;
    } catch {
      setListening(false);
      notify('麦克风启动失败', 'err');
    }
  }, [draft, listening, notify]);

  const grouped = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    const list = q ? models.filter((m) => m.name.toLowerCase().includes(q)) : models;
    const map = new Map<string, typeof models>();
    for (const m of list) {
      const bucket = map.get(m.providerLabel) ?? [];
      bucket.push(m);
      map.set(m.providerLabel, bucket);
    }
    return [...map.entries()];
  }, [models, modelQuery]);

  const levelProgress = active ? Math.min(100, Math.round((active.affinity % 8) * 12.5)) : 0;

  async function submit() {
    const text = draft.trim();
    if (!text || streaming) return;
    setDraft('');
    await sendMessage(text);
  }

  if (characters.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex h-[60px] shrink-0 items-center justify-between gap-2 border-b border-line px-5">
          <h2 className="text-[19px] font-bold tracking-tight text-fg">聊天</h2>
          <SettingsButton />
        </header>
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={<IconChat size={22} />}
            title="还没有角色"
            desc="去「角色」创建一个，或者导入一张角色卡开始。"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      {/* 会话列表 */}
      <div
        className={`${
          showChatOnMobile ? 'hidden' : 'flex'
        } w-full flex-col border-r border-line bg-surface/30 lg:flex lg:w-[288px] lg:shrink-0`}
      >
        <div className="flex items-center justify-between gap-2 px-5 pb-3 pt-5">
          <h2 className="text-[19px] font-bold tracking-tight text-fg">聊天</h2>
          <div className="flex shrink-0 items-center gap-2">
            <span className="chip">{characters.length} 个角色</span>
            <SettingsButton />
          </div>
        </div>
        <div className="no-scrollbar flex-1 overflow-y-auto px-2.5 pb-4">
          {characters.map((c) => {
            const last = messages[c.id]?.at(-1);
            const selected = c.id === activeId;
            return (
              <button
                key={c.id}
                onClick={() => {
                  selectCharacter(c.id);
                  setMobileOpen(true);
                }}
                className={`mb-1 flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition ${
                  selected ? 'bg-tint/[0.07]' : 'hover:bg-tint/[0.04]'
                }`}
              >
                <Avatar emoji={c.emoji} accent={c.accent} src={c.avatar_url} size={44} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="truncate text-[14px] font-semibold text-fg">{c.name}</p>
                    <span className="shrink-0 rounded-full bg-brand/15 px-1.5 py-0.5 text-[9.5px] font-medium text-brand-soft">
                      Lv.{c.relationship_level}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-[12px] text-fg-dimmer">
                    {last ? `${last.role === 'user' ? '你：' : ''}${last.content}` : c.tagline || '还没有聊过'}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 对话区 */}
      {active ? (
        <div
          className={`${showChatOnMobile ? 'flex' : 'hidden'} min-w-0 flex-1 flex-col lg:flex`}
        >
          <header className="relative flex h-[60px] shrink-0 items-center gap-3 border-b border-line px-3 lg:px-5">
            <button
              onClick={() => setMobileOpen(false)}
              className="-ml-1 rounded-full p-1.5 text-fg-dim lg:hidden"
              aria-label="返回"
            >
              <IconBack size={20} />
            </button>
            <Avatar emoji={active.emoji} accent={active.accent} src={active.avatar_url} size={38} />
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 truncate text-[15px] font-semibold text-fg">
                {active.name}
                <span className="rounded-full border border-line bg-tint/[0.04] px-1.5 py-[1px] text-[9.5px] font-normal text-fg-dimmer">
                  Lv.{active.relationship_level} 关系
                </span>
              </p>
              <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11.5px] text-fg-dimmer">
                <button
                  onClick={() => setModelMenuOpen((v) => !v)}
                  title="切换模型"
                  className="inline-flex min-w-0 items-center gap-1 rounded-full border border-line bg-tint/[0.05] px-2 py-[2px] text-[11px] text-fg-dim transition hover:border-line-strong hover:text-fg"
                >
                  <span className="max-w-[150px] truncate">
                    {activeModel ? activeModel.name : '未配置模型'}
                  </span>
                  <span className="shrink-0 opacity-70">▾</span>
                </button>
                <span className="shrink-0 truncate">
                  {streaming || pendingReply ? '正在输入…' : `手记 ${memList.length} 条`}
                </span>
              </div>
            </div>
            <button
              onClick={() => setClearOpen(true)}
              disabled={streaming}
              className="rounded-full border border-line p-2 text-fg-dim transition hover:border-line-strong hover:text-fg disabled:opacity-40"
              title="清空上下文"
              aria-label="清空上下文"
            >
              <IconRefresh size={17} />
            </button>
            <button
              onClick={() => setGameOpen(true)}
              className="rounded-full border border-line p-2 text-fg-dim transition hover:border-line-strong hover:text-fg"
              title="约一局小游戏"
            >
              <IconGame size={17} />
            </button>
            <button
              onClick={() => setShowInfo((v) => !v)}
              className="rounded-full border border-line p-2 text-fg-dim transition hover:border-line-strong hover:text-fg xl:hidden"
              title="角色信息"
            >
              <IconInfo size={17} />
            </button>
            {modelMenuOpen ? (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setModelMenuOpen(false)} />
                <div className="absolute left-3 top-[62px] z-30 w-[280px] overflow-hidden rounded-xl border border-line bg-card shadow-panel lg:left-5">
                  {models.length > 8 ? (
                    <div className="border-b border-line p-1.5">
                      <input
                        value={modelQuery}
                        onChange={(e) => setModelQuery(e.target.value)}
                        placeholder={`搜索 ${models.length} 个模型`}
                        className="w-full rounded-lg bg-tint/[0.05] px-2.5 py-1.5 text-[12px] text-fg outline-none placeholder:text-fg-dimmer"
                      />
                    </div>
                  ) : null}
                  <div className="max-h-[300px] overflow-y-auto p-1.5">
                    {active?.model_id ? (
                      <button
                        onClick={() => {
                          setModelMenuOpen(false);
                          if (activeId) void setCharacterModel(activeId, null, null);
                        }}
                        className="mb-1 flex w-full items-center gap-1.5 rounded-lg border border-dashed border-line px-2 py-1.5 text-left text-[11px] text-fg-dim transition hover:bg-tint/5"
                      >
                        <IconRefresh size={11} />
                        跟随默认（{currentModelOption?.name || '未设置'}）
                      </button>
                    ) : null}
                    {models.length === 0 ? (
                      <div className="p-2">
                        <p className="text-[11.5px] leading-relaxed text-fg-dim">还没有可用模型。</p>
                        <button
                          onClick={() => {
                            setModelMenuOpen(false);
                            openSettings();
                          }}
                          className="btn-primary mt-2 w-full py-1.5 text-[12px]"
                        >
                          去配置供应商
                        </button>
                      </div>
                    ) : grouped.length === 0 ? (
                      <p className="px-2 py-3 text-center text-[11.5px] text-fg-dimmer">没有匹配的模型</p>
                    ) : (
                      grouped.map(([label, list]) => (
                        <div key={label} className="mb-1">
                          <p className="px-2 py-1 text-[10px] uppercase tracking-wider text-fg-dimmer">{label}</p>
                          {list.map((m) => {
                            const on = activeModel?.key === m.key;
                            return (
                              <button
                                key={m.key}
                                onClick={() => {
                                  setModelMenuOpen(false);
                                  if (!activeId) return;
                                  void setCharacterModel(activeId, m.providerId, m.id);
                                }}
                                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] transition ${
                                  on ? 'bg-brand/10 text-brand-soft' : 'text-fg hover:bg-tint/5'
                                }`}
                              >
                                <span className="min-w-0 flex-1 truncate">{m.name}</span>
                                {on ? <IconCheck size={13} /> : null}
                              </button>
                            );
                          })}
                        </div>
                      ))
                    )}
                  </div>
                  <button
                    onClick={() => {
                      setModelMenuOpen(false);
                      setModelQuery('');
                      openSettings();
                    }}
                    className="w-full border-t border-line px-3 py-2 text-left text-[11.5px] text-fg-dim transition hover:text-fg"
                  >
                    管理供应商…
                  </button>
                </div>
              </>
            ) : null}
          </header>

          <div className="relative flex min-h-0 flex-1 flex-col">
          <div ref={scrollerRef} className="flex-1 overflow-y-auto px-4 py-5 lg:px-6">
            <div className="mx-auto flex w-full max-w-[860px] flex-col gap-1 2xl:max-w-[960px]">
              {loadingChar && list.length === 0 ? (
                <div className="py-10 text-center text-[12.5px] text-fg-dimmer">正在载入对话…</div>
              ) : null}

              {list.map((m, i) => {
                const prev = list[i - 1];
                const isUser = m.role === 'user';
                const isGame = m.kind === 'game';
                const isImage = m.kind === 'image';
                // 画图标记是给服务端看的，不能出现在气泡里
                const shown = stripDrawMarker(m.content);
                return (
                  <div key={m.id}>
                    {shouldShowTime(prev, m) ? (
                      <div className="my-4 text-center text-[10.5px] text-fg-dimmer">
                        {timeLabel(m.created_at)}
                      </div>
                    ) : null}
                    {m.kind === 'system' ? (
                      <div className="my-5 flex items-center gap-3 text-[10.5px] text-fg-dimmer">
                        <span className="h-px flex-1 bg-line" />
                        <span className="flex shrink-0 items-center gap-1">
                          <IconRefresh size={11} />
                          上下文已清空
                        </span>
                        <span className="h-px flex-1 bg-line" />
                      </div>
                    ) : m.kind === 'error' ? (
                      <div className="my-2 rounded-xl border border-danger/30 bg-danger/[0.07] px-3 py-2.5 text-[12px] leading-relaxed text-danger">
                        <p className="mb-1 font-medium">回复失败</p>
                        <p className="whitespace-pre-wrap break-words text-[11.5px] opacity-90">{m.content}</p>
                      </div>
                    ) : isGame ? (
                      <div className="my-2 flex justify-center">
                        <span className="rounded-full border border-line bg-tint/[0.03] px-3 py-1.5 text-[11.5px] text-fg-dim">
                          🎮 {m.content.replace(/[（）]/g, '')}
                        </span>
                      </div>
                    ) : isImage ? (
                      (() => {
                        const att = m.attachments?.[0];
                        const status = att?.status || 'done';
                        // 只导了文字的聊天记录里，图片消息没有附件，退化成普通气泡
                        if (!att || (!att.url && status === 'done')) {
                          return (
                            <div className="flex items-end gap-2">
                              <Avatar
                                emoji={active.emoji}
                                accent={active.accent}
                                src={active.avatar_url}
                                size={28}
                              />
                              <div className="max-w-[78%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-md border border-line bg-raise/80 px-3.5 py-2.5 text-[14px] leading-[1.55] text-fg">
                                {shown}
                              </div>
                            </div>
                          );
                        }
                        // 还在画：先占个位，画好之后会被轮询替换成真图
                        if (status === 'pending') {
                          return (
                            <div className="flex items-end gap-2">
                              <Avatar
                                emoji={active.emoji}
                                accent={active.accent}
                                src={active.avatar_url}
                                size={28}
                              />
                              <div className="w-[200px] overflow-hidden rounded-2xl rounded-bl-md border border-dashed border-line bg-raise/40">
                                <div className="flex aspect-square flex-col items-center justify-center gap-2 text-fg-dimmer">
                                  <span className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-brand" />
                                  <span className="text-[11px]">在画了…</span>
                                </div>
                                <span className="block border-t border-line px-2.5 py-1.5 text-[10.5px] leading-snug text-fg-dimmer">
                                  画好会直接出现在这里
                                </span>
                              </div>
                            </div>
                          );
                        }
                        if (status === 'failed') {
                          return (
                            <div className="flex items-end gap-2">
                              <Avatar
                                emoji={active.emoji}
                                accent={active.accent}
                                src={active.avatar_url}
                                size={28}
                              />
                              <div className="max-w-[78%] rounded-2xl rounded-bl-md border border-danger/30 bg-danger/[0.06] px-3 py-2 text-[12px] leading-relaxed text-danger">
                                <p>这张没画出来</p>
                                <p className="mt-0.5 text-[10.5px] opacity-80">
                                  {att?.error || '生成失败了'}
                                </p>
                              </div>
                            </div>
                          );
                        }
                        return (
                          <div className="flex animate-fade-up items-end gap-2">
                            <Avatar
                              emoji={active.emoji}
                              accent={active.accent}
                              src={active.avatar_url}
                              size={28}
                            />
                            <div className="max-w-[78%] overflow-hidden rounded-2xl rounded-bl-md border border-line bg-raise/80">
                              {/* 点开进入看图模式 */}
                              <button
                                onClick={() => setViewerSrc(att?.url || '')}
                                className="block w-full cursor-zoom-in transition active:opacity-90"
                                title="点开看大图"
                              >
                                <img
                                  src={assetUrl(att?.url || '')}
                                  alt="生成的图片"
                                  className="block max-h-[360px] w-full object-contain"
                                  loading="lazy"
                                />
                              </button>
                              {shown ? (
                                <span className="block px-3 py-2 text-[11px] leading-snug text-fg-dimmer">
                                  {shown}
                                </span>
                              ) : null}
                            </div>
                          </div>
                        );
                      })()
                    ) : (
                      <div
                        className={`group flex animate-fade-up items-end gap-2 ${
                          isUser ? 'flex-row-reverse' : ''
                        }`}
                      >
                        {isUser ? (
                          <Avatar
                            emoji={(user.name || '我').slice(0, 1)}
                            accent="slate"
                            src={user.avatar}
                            size={28}
                          />
                        ) : (
                          <Avatar emoji={active.emoji} accent={active.accent} src={active.avatar_url} size={28} />
                        )}
                        <div
                          className={`max-w-[78%] whitespace-pre-wrap break-words px-3.5 py-2.5 text-[14px] leading-[1.55] ${
                            isUser
                              ? 'rounded-2xl rounded-br-md bg-gradient-to-br from-brand to-brand-blue text-white'
                              : 'rounded-2xl rounded-bl-md border border-line bg-raise/80 text-fg'
                          }`}
                        >
                          {shown}
                        </div>
                        {!isUser && shown ? (
                          <button
                            onClick={() => speak(shown)}
                            title="朗读这条"
                            aria-label="朗读这条"
                            className="mb-1 shrink-0 rounded-full p-1 text-fg-dimmer opacity-0 transition hover:text-fg group-hover:opacity-100 focus-visible:opacity-100"
                          >
                            <IconSpeaker size={13} />
                          </button>
                        ) : null}
                      </div>
                    )}
                  </div>
                );
              })}

              {streaming || pendingReply ? (
                <div className="flex items-end gap-2">
                  <Avatar emoji={active.emoji} accent={active.accent} src={active.avatar_url} size={28} />
                  <div className="max-w-[78%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-md border border-line bg-raise/80 px-3.5 py-2.5 text-[14px] leading-[1.55] text-fg">
                    {streamingText ? (
                      <span className="stream-caret">{stripDrawMarker(streamingText)}</span>
                    ) : (
                      <span className="inline-flex items-center py-0.5 text-fg-dimmer">
                        <span className="typing-dot" />
                        <span className="typing-dot" />
                        <span className="typing-dot" />
                      </span>
                    )}
                  </div>
                </div>
              ) : null}

              <div className="h-2" />
            </div>
          </div>

            {!atBottom && list.length > 0 ? (
              <button
                onClick={jumpToBottom}
                className="absolute bottom-3 right-4 z-10 flex items-center gap-1 rounded-full border border-line bg-card/95 px-3 py-1.5 text-[11.5px] text-fg-dim shadow-panel backdrop-blur transition hover:text-fg"
                title="回到最新"
                aria-label="回到最新消息"
              >
                <IconChevronDown size={13} />
                到底部
              </button>
            ) : null}
          </div>

          {/* 输入区 */}
          <div className="shrink-0 border-t border-line bg-surface/60 px-3 py-3 lg:px-6 lg:py-4">
            {!activeModel ? (
              <div className="mx-auto mb-2 flex w-full max-w-[860px] items-center gap-2 rounded-xl border border-warn/30 bg-warn/[0.08] px-3 py-2 2xl:max-w-[960px]">
                <p className="min-w-0 flex-1 text-[11.5px] leading-snug text-fg-dim">
                  还没有可用的模型，配置供应商之后才能对话
                </p>
                <button
                  onClick={openSettings}
                  className="shrink-0 rounded-full bg-warn/20 px-2.5 py-1 text-[11px] font-medium text-warn"
                >
                  去配置
                </button>
              </div>
            ) : null}
            <div className="mx-auto flex w-full max-w-[860px] items-end gap-2 2xl:max-w-[960px]">
              <div className="flex flex-1 items-end rounded-[22px] border border-line bg-raise/70 px-3 py-1.5 transition focus-within:border-brand/50">
                <textarea
                  ref={inputRef}
                  rows={1}
                  value={draft}
                  onFocus={() => {
                    // 等键盘动画结束再滚，否则滚的是旧的可视高度
                    window.setTimeout(() => {
                      atBottomRef.current = true;
                      setAtBottom(true);
                      scrollToBottom('smooth');
                    }, 320);
                  }}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void submit();
                    }
                  }}
                  placeholder={`和${active.name}说点什么…`}
                  className="max-h-[132px] flex-1 resize-none bg-transparent py-2 text-[14px] leading-[1.5] text-fg outline-none placeholder:text-fg-dimmer"
                />
                <button
                  onClick={toggleMic}
                  className={`mb-1 rounded-full p-2 transition ${
                    listening ? 'bg-danger/15 text-danger' : 'text-fg-dimmer hover:text-fg'
                  }`}
                  title={listening ? '停止录音' : '语音输入'}
                  aria-label="语音输入"
                >
                  <IconMic size={17} />
                </button>
                <button
                  onClick={() => setGameOpen(true)}
                  className="mb-1 rounded-full p-2 text-fg-dimmer transition hover:text-fg"
                  title="小游戏"
                >
                  <IconGame size={17} />
                </button>
              </div>
              {streaming ? (
                <button
                  onClick={stopStreaming}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line bg-tint/[0.06] text-fg"
                  title="停止生成"
                >
                  <IconStop size={16} />
                </button>
              ) : (
                <button
                  onClick={submit}
                  disabled={!draft.trim()}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand to-brand-blue text-white transition active:scale-95 disabled:opacity-35"
                  title="发送"
                >
                  <IconSend size={17} />
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {/* 角色快照（PC 大屏常驻 / 中小屏弹层） */}
      {active ? (
        <>
          <aside className="hidden w-[300px] shrink-0 flex-col border-l border-line bg-surface/30 xl:flex">
            <Snapshot
              character={active}
              memoryCount={memList.length}
              archivedCount={archived}
              gameCount={gameList.length}
              messageCount={list.length}
              progress={levelProgress}
              memories={memList}
              memoryDraft={memoryDraft}
              setMemoryDraft={setMemoryDraft}
              onAddMemory={() => {
                void addMemory(active.id, memoryDraft);
                setMemoryDraft('');
              }}
              onExport={() => void exportCharacter(active.id)}
              onExportChat={() => active && askExportChat(active.id)}
            />
          </aside>

          {showInfo ? (
            <div className="fixed inset-0 z-40 flex justify-end bg-overlay xl:hidden" onClick={() => setShowInfo(false)}>
              <div
                className="h-full w-[86%] max-w-[340px] overflow-y-auto border-l border-line bg-surface"
                onClick={(e) => e.stopPropagation()}
              >
                <Snapshot
                  character={active}
                  memoryCount={memList.length}
                  archivedCount={archived}
                  gameCount={gameList.length}
                  messageCount={list.length}
                  progress={levelProgress}
                  memories={memList}
                  memoryDraft={memoryDraft}
                  setMemoryDraft={setMemoryDraft}
                  onAddMemory={() => {
                    void addMemory(active.id, memoryDraft);
                    setMemoryDraft('');
                  }}
                  onExport={() => void exportCharacter(active.id)}
                  onExportChat={() => active && askExportChat(active.id)}
                />
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      <Modal
        open={clearOpen}
        onClose={() => setClearOpen(false)}
        title="清空上下文？"
        subtitle="之后的消息只带人设和长期记忆从头开始，界面上的聊天记录不会删除，随时能往上翻。"
      >
        <div className="flex gap-2">
          <button
            onClick={async () => {
              if (!active) return;
              setClearing(true);
              const ok = await resetContext(active.id);
              setClearing(false);
              if (ok) setClearOpen(false);
            }}
            disabled={clearing}
            className="flex-1 rounded-full bg-brand/90 py-2.5 text-[13px] font-semibold text-white disabled:opacity-60"
          >
            {clearing ? '处理中…' : '清空并重新开始'}
          </button>
          <button onClick={() => setClearOpen(false)} className="btn-ghost flex-1">
            取消
          </button>
        </div>
      </Modal>

      <GameHub open={gameOpen} character={active} onClose={() => setGameOpen(false)} />

      <ImageViewer src={viewerSrc} onClose={() => setViewerSrc(null)} />
    </div>
  );
}

function Snapshot({
  character,
  memoryCount,
  archivedCount,
  gameCount,
  messageCount,
  progress,
  memories,
  memoryDraft,
  setMemoryDraft,
  onAddMemory,
  onExport,
  onExportChat,
}: {
  character: Character;
  memoryCount: number;
  archivedCount: number;
  gameCount: number;
  messageCount: number;
  progress: number;
  memories: { id: number; content: string }[];
  memoryDraft: string;
  setMemoryDraft: (v: string) => void;
  onAddMemory: () => void;
  onExport: () => void;
  onExportChat: () => void;
}) {
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="card p-4">
        <div className="flex items-center gap-3">
          <Avatar emoji={character.emoji} accent={character.accent} src={character.avatar_url} size={48} />
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold text-fg">{character.name}</p>
            <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-relaxed text-fg-dimmer">
              {character.tagline || '还没有一句话人设'}
            </p>
          </div>
        </div>

        <div className="mt-4">
          <div className="flex items-center justify-between text-[11px] text-fg-dim">
            <span>关系阶段 Lv.{character.relationship_level}</span>
            <span className="text-fg-dimmer">距下一级 {100 - progress}%</span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-tint/[0.07]">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{ width: `${progress}%`, background: accentGradient(character.accent) }}
            />
          </div>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2 border-t border-line pt-3 text-center">
          {[
            [messageCount, '对话'],
            [gameCount, '游戏'],
            [memoryCount, '手记'],
          ].map(([v, l]) => (
            <div key={String(l)}>
              <p className="text-[15px] font-semibold text-fg">{v}</p>
              <p className="mt-0.5 text-[10px] text-fg-dimmer">{l}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="card p-4">
        <div className="mb-2 flex items-center gap-1.5">
          <IconMemory size={14} className="text-brand-soft" />
          <p className="text-[12px] font-semibold text-fg">她记得的事</p>
          <span className="ml-auto text-[10px] text-fg-dimmer">
            自动归档 {archivedCount} 块 · 手记 {memoryCount} 条
          </span>
        </div>
        <div className="space-y-1.5">
          {memories.length === 0 ? (
            <p className="py-2 text-[11.5px] leading-relaxed text-fg-dimmer">
              还没有手动记下的要点。聊过的内容会自动归档成记忆块，需要她务必记住的事可以写在这里。
            </p>
          ) : (
            memories.slice(0, 5).map((m) => (
              <p
                key={m.id}
                className="rounded-lg border border-line bg-tint/[0.02] px-2.5 py-2 text-[11.5px] leading-relaxed text-fg-dim"
              >
                {m.content}
              </p>
            ))
          )}
        </div>
        <div className="mt-2.5 flex gap-1.5">
          <input
            value={memoryDraft}
            onChange={(e) => setMemoryDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onAddMemory();
            }}
            placeholder="记一条她该记住的事"
            className="min-w-0 flex-1 rounded-lg border border-line bg-raise/60 px-2.5 py-2 text-[11.5px] text-fg outline-none placeholder:text-fg-dimmer focus:border-brand/50"
          />
          <button
            onClick={onAddMemory}
            disabled={!memoryDraft.trim()}
            className="shrink-0 rounded-lg border border-line px-2.5 text-fg-dim transition hover:text-fg disabled:opacity-40"
            title="添加记忆"
          >
            <IconPlus size={14} />
          </button>
        </div>
      </div>

      <div className="flex gap-2">
        <button onClick={onExport} className="btn-ghost flex-1 text-[12px]" title="人设 + 记忆">
          <IconDownload size={14} />
          导出角色卡
        </button>
        <button onClick={onExportChat} className="btn-ghost flex-1 text-[12px]" title="只导出聊天记录">
          <IconDownload size={14} />
          导出聊天记录
        </button>
      </div>

      <div className="rounded-xl border border-line bg-tint/[0.02] p-3">
        <div className="flex items-center gap-1.5 text-[11px] text-fg-dim">
          <IconSparkle size={12} className="text-brand-soft" />
          小游戏入口在输入框旁
        </div>
        <p className="mt-1 text-[10.5px] leading-relaxed text-fg-dimmer">
          玩过的局会记进共同经历，也会成为之后聊天的上下文。
        </p>
      </div>
    </div>
  );
}
