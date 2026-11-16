'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { api, ApiError, downloadJson, errorMessage, streamChat } from './api';
import {
  buildCardFile,
  buildChatFile,
  CHAT_SPEC,
  downloadJsonFile,
  parseJsonFile,
} from './characterFile';
import type {
  Character,
  CharacterDraft,
  CurrentModel,
  GameRecord,
  Memory,
  Message,
  ModelOption,
  Post,
  Provider,
  EmbeddingInfo,
  MemoryChunkItem,
  MemoryStats,
  RebuildState,
} from './types';

/** 连发合并的等待窗口：这段时间内继续发，算同一轮对话 */
const DEBOUNCE_MS = 2000;

type Toast = { id: number; text: string; tone: 'ok' | 'err' };

type Bootstrap = {
  name: string;
  avatar?: string;
  embedding?: EmbeddingInfo;
  rebuild?: RebuildState;
  characters: Character[];
  posts: Post[];
  providers: Provider[];
  current: CurrentModel;
  models: ModelOption[];
  dbPath: string;
};

export type AppContextValue = {
  ready: boolean;
  needsSetup: boolean;
  authed: boolean;
  user: { name: string; avatar: string };
  dbPath: string;

  characters: Character[];
  activeId: number | null;
  active: Character | null;
  messages: Record<number, Message[]>;
  memories: Record<number, Memory[]>;
  games: Record<number, GameRecord[]>;
  posts: Post[];

  providers: Provider[];
  current: CurrentModel;
  models: ModelOption[];
  currentModelOption: ModelOption | null;
  embedding: EmbeddingInfo | null;
  saveEmbedSource: (source: string) => Promise<void>;
  rebuild: RebuildState | null;
  startRebuild: () => Promise<void>;
  memoryStats: (characterId: number) => Promise<MemoryStats | null>;
  listMemoryChunks: (
    characterId: number,
    opts?: { q?: string; limit?: number; offset?: number },
  ) => Promise<{ items: MemoryChunkItem[]; total: number; mode: string }>;
  updateMemoryChunk: (id: string, content: string) => Promise<boolean>;
  createMemoryChunk: (characterId: number, content: string) => Promise<boolean>;
  deleteMemoryChunk: (id: string) => Promise<boolean>;

  /** 记忆管理面板（全局唯一，从角色页或设置页打开） */
  memoryPanel: { open: boolean; characterId: number | null };
  openMemoryPanel: (characterId?: number | null) => void;
  closeMemoryPanel: () => void;

  streaming: boolean;
  /** 消息已发出，正在等用户把话说完（防抖窗口内） */
  pendingReply: boolean;
  streamingText: string;
  loadingChar: boolean;
  toasts: Toast[];

  settingsOpen: boolean;
  openSettings: () => void;
  closeSettings: () => void;

  notify: (text: string, tone?: 'ok' | 'err') => void;
  dismissToast: (id: number) => void;

  login: (password: string) => Promise<void>;
  setup: (password: string, name: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  saveName: (name: string) => Promise<void>;
  saveAvatar: (avatar: string) => Promise<void>;

  setCurrentModel: (providerId: number, model: string) => Promise<void>;
  createProvider: (input: {
    label: string;
    kind?: string;
    type: 'openai' | 'ollama';
    baseUrl: string;
    apiKey?: string;
    model?: string;
    supportsVision?: boolean;
    supportsTools?: boolean;
  }) => Promise<void>;
  updateProvider: (id: number, patch: Record<string, unknown>) => Promise<void>;
  deleteProvider: (id: number) => Promise<void>;
  testProvider: (id: number) => Promise<{ ok: boolean; text: string }>;

  uploadAvatar: (file: File) => Promise<string | null>;

  selectCharacter: (id: number | null) => void;
  createCharacter: (draft: CharacterDraft) => Promise<Character | null>;
  updateCharacter: (id: number, patch: Partial<Character>) => Promise<void>;
  deleteCharacter: (id: number) => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  stopStreaming: () => void;
  /** 往当前角色的消息列表里补一条（游戏结束语等外部写入） */
  pushMessage: (msg: Message) => void;
  /** 清空上下文：之后的消息只带人设 + 召回记忆 + 新消息，历史记录不删 */
  resetContext: (characterId: number) => Promise<boolean>;
  addMemory: (characterId: number, content: string) => Promise<void>;
  removeMemory: (memoryId: number, characterId: number) => Promise<void>;
  createPost: (characterId: number) => Promise<void>;
  deletePost: (postId: number) => Promise<void>;
  toggleLike: (postId: number) => Promise<void>;
  exportCharacter: (id: number) => Promise<void>;
  /** 聊天记录单独导出 */
  exportChat: (id: number) => Promise<void>;
  importCard: (text: string) => Promise<Character | null>;
  exportAll: () => Promise<void>;
  importAll: (file: File) => Promise<void>;
};

export const AppCtx = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
}

type ProviderPayload = {
  providers: Provider[];
  current: CurrentModel;
  models: ModelOption[];
  embedding?: EmbeddingInfo;
  rebuild?: RebuildState | null;
};

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [name, setName] = useState('我');
  const [avatar, setAvatar] = useState('');
  const [dbPath, setDbPath] = useState('');

  const [characters, setCharacters] = useState<Character[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Record<number, Message[]>>({});
  const [memories, setMemories] = useState<Record<number, Memory[]>>({});
  const [games, setGames] = useState<Record<number, GameRecord[]>>({});
  const [posts, setPosts] = useState<Post[]>([]);

  const [providers, setProviders] = useState<Provider[]>([]);
  const [current, setCurrent] = useState<CurrentModel>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [embedding, setEmbedding] = useState<EmbeddingInfo | null>(null);
  const [rebuild, setRebuild] = useState<RebuildState | null>(null);

  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [loadingChar, setLoadingChar] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [memoryPanel, setMemoryPanel] = useState<{ open: boolean; characterId: number | null }>({
    open: false,
    characterId: null,
  });
  const abortRef = useRef<AbortController | null>(null);
  const streamingRef = useRef(false);
  // 连发合并：攒一小会儿再让模型回
  const pendingRef = useRef<{
    characterId: number;
    texts: string[];
    timer: ReturnType<typeof setTimeout> | 0;
  } | null>(null);
  const [pendingReply, setPendingReply] = useState(false);

  const notify = useCallback((text: string, tone: 'ok' | 'err' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, text, tone }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 2800);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  const applyProviderPayload = useCallback((data: Partial<ProviderPayload>) => {
    if (data.providers) setProviders(data.providers);
    if (data.models) setModels(data.models);
    if (data.current !== undefined) setCurrent(data.current);
    if (data.embedding) setEmbedding(data.embedding);
    if (data.rebuild) setRebuild(data.rebuild);
  }, []);

  const loadCharacterData = useCallback(
    async (id: number) => {
      setLoadingChar(true);
      try {
        const data = await api<{ messages: Message[]; memories: Memory[]; games: GameRecord[] }>(
          `/api/characters/${id}/data`,
        );
        setMessages((prev) => ({ ...prev, [id]: data.messages ?? [] }));
        setMemories((prev) => ({ ...prev, [id]: data.memories ?? [] }));
        setGames((prev) => ({ ...prev, [id]: data.games ?? [] }));
      } catch (e) {
        notify(errorMessage(e, '读取对话失败'), 'err');
      } finally {
        setLoadingChar(false);
      }
    },
    [notify],
  );

  const refresh = useCallback(async () => {
    try {
      const data = await api<Bootstrap>('/api/bootstrap');
      setName(data.name || '我');
      setAvatar(data.avatar || '');
      setDbPath(data.dbPath || '');
      setCharacters(data.characters ?? []);
      setPosts(data.posts ?? []);
      applyProviderPayload(data);
      if (data.embedding) setEmbedding(data.embedding);
      if (data.rebuild) setRebuild(data.rebuild);
      setActiveId((prev) => {
        const list = data.characters ?? [];
        if (prev && list.some((c) => c.id === prev)) return prev;
        return list[0]?.id ?? null;
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setAuthed(false);
        return;
      }
      notify(errorMessage(e, '加载失败'), 'err');
    }
  }, [applyProviderPayload, notify]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const status = await api<{ needsSetup: boolean; authed: boolean; name: string }>('/api/auth/status');
        if (!alive) return;
        setNeedsSetup(status.needsSetup);
        setAuthed(status.authed);
        setName(status.name || '我');
        if (status.authed) await refresh();
      } catch {
        if (alive) notify('连不上本机服务器，请确认服务还在运行', 'err');
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!activeId || messages[activeId]) return;
    void loadCharacterData(activeId);
  }, [activeId, messages, loadCharacterData]);

  const active = useMemo(
    () => characters.find((c) => c.id === activeId) ?? null,
    [characters, activeId],
  );

  const currentModelOption = useMemo(() => {
    if (!current) return models[0] ?? null;
    return (
      models.find((m) => m.providerId === current.providerId && m.id === current.model) ??
      models[0] ??
      null
    );
  }, [current, models]);

  const login = useCallback(
    async (password: string) => {
      await api('/api/auth/login', { method: 'POST', body: { password } });
      setAuthed(true);
      setNeedsSetup(false);
      await refresh();
    },
    [refresh],
  );

  const setup = useCallback(
    async (password: string, displayName: string) => {
      await api('/api/auth/setup', { method: 'POST', body: { password, name: displayName } });
      setAuthed(true);
      setNeedsSetup(false);
      await refresh();
    },
    [refresh],
  );

  const signOut = useCallback(async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      /* 忽略 */
    }
    setAuthed(false);
    setCharacters([]);
    setMessages({});
    setMemories({});
    setGames({});
    setPosts([]);
    setActiveId(null);
    setSettingsOpen(false);
  }, []);

  const saveName = useCallback(async (next: string) => {
    const data = await api<{ name: string; avatar: string }>('/api/settings', {
      method: 'PUT',
      body: { name: next },
    });
    setName(data.name);
    setAvatar(data.avatar || '');
  }, []);

  const saveAvatar = useCallback(async (next: string) => {
    const data = await api<{ name: string; avatar: string }>('/api/settings', {
      method: 'PUT',
      body: { avatar: next },
    });
    setName(data.name);
    setAvatar(data.avatar || '');
  }, []);

  const setCurrentModel = useCallback(
    async (providerId: number, model: string) => {
      const option = models.find((m) => m.providerId === providerId && m.id === model);
      // 先本地生效，避免网络慢时看起来「没反应」
      setCurrent({
        providerId,
        providerLabel: option?.providerLabel ?? '',
        model,
        hasModels: true,
      });
      try {
        const data = await api<ProviderPayload>('/api/current-model', {
          method: 'PUT',
          body: { providerId, model },
        });
        applyProviderPayload(data);
        const applied = data.current?.model;
        if (applied && applied !== model) {
          notify(`「${model}」不在该供应商的模型列表里，已回退到「${applied}」`, 'err');
        } else {
          notify(`已切换到 ${model}`);
        }
      } catch (e) {
        notify(errorMessage(e, '切换失败'), 'err');
        void refresh();
      }
    },
    [applyProviderPayload, models, notify, refresh],
  );

  const createProvider = useCallback(
    async (input: {
      label: string;
      kind?: string;
      type: 'openai' | 'ollama';
      baseUrl: string;
      apiKey?: string;
      model?: string;
      supportsVision?: boolean;
      supportsTools?: boolean;
    }) => {
      const data = await api<ProviderPayload & { provider: Provider }>('/api/providers', {
        method: 'POST',
        body: input,
      });
      applyProviderPayload(data);
    },
    [applyProviderPayload],
  );

  const updateProvider = useCallback(
    async (id: number, patch: Record<string, unknown>) => {
      const data = await api<ProviderPayload>(`/api/providers/${id}`, { method: 'PATCH', body: patch });
      applyProviderPayload(data);
    },
    [applyProviderPayload],
  );

  const deleteProvider = useCallback(
    async (id: number) => {
      const data = await api<ProviderPayload>(`/api/providers/${id}`, { method: 'DELETE' });
      applyProviderPayload(data);
    },
    [applyProviderPayload],
  );

  const testProvider = useCallback(
    async (id: number) => {
      try {
        const data = await api<ProviderPayload & { fetched?: string[]; error?: string }>(
          `/api/providers/${id}/test`,
          { method: 'POST' },
        );
        applyProviderPayload(data);
        if (data.error) return { ok: false, text: data.error };
        const count = data.fetched?.length ?? 0;
        return count
          ? { ok: true, text: `连接成功，拿到 ${count} 个模型` }
          : { ok: false, text: '连上了，但服务端没返回模型列表，请手动填模型名' };
      } catch (e) {
        return { ok: false, text: errorMessage(e, '连接失败') };
      }
    },
    [applyProviderPayload],
  );

  const pollRef = useRef(false);

  /** 后台重建的进度轮询：只在 running 时继续，不阻塞任何操作 */
  const pollRebuild = useCallback(async () => {
    if (pollRef.current) return;
    pollRef.current = true;
    try {
      for (let i = 0; i < 1200; i++) {
        let r: RebuildState | null = null;
        try {
          r = await api<RebuildState>('/api/memory/rebuild');
        } catch {
          break;
        }
        setRebuild(r);
        if (r.status !== 'running') {
          if (r.status === 'done') notify('历史记忆已全部换用新模型');
          break;
        }
        await new Promise((res) => setTimeout(res, 1500));
      }
    } finally {
      pollRef.current = false;
    }
  }, [notify]);

  useEffect(() => {
    if (authed && rebuild?.status === 'running') void pollRebuild();
  }, [authed, rebuild?.status, pollRebuild]);

  const saveEmbedSource = useCallback(
    async (source: string) => {
      const data = await api<{ embedding: EmbeddingInfo; rebuild: RebuildState | null }>(
        '/api/settings',
        { method: 'PUT', body: { embedSource: source } },
      );
      setEmbedding(data.embedding);
      if (data.rebuild) {
        setRebuild(data.rebuild);
        if (data.rebuild.status === 'running') {
          notify('已切换，历史记忆会在后台慢慢重建，期间照常聊天');
        } else {
          notify('嵌入模型已切换');
        }
      } else {
        notify('嵌入模型未变化');
      }
    },
    [notify, pollRebuild],
  );

  const startRebuild = useCallback(async () => {
    try {
      const r = await api<{ state: RebuildState }>('/api/memory/rebuild', { method: 'POST' });
      setRebuild(r.state);
      if (r.state.status === 'running') {
        notify(`开始重建，共 ${r.state.total} 块`);
      } else if (r.state.status === 'error') {
        notify(r.state.error || '重建失败', 'err');
      } else {
        notify('所有记忆都已是最新模型');
      }
    } catch (e) {
      notify(errorMessage(e, '重建失败'), 'err');
    }
  }, [notify, pollRebuild]);

  const memoryStats = useCallback(async (characterId: number) => {
    try {
      return await api<MemoryStats>(`/api/memory/status?characterId=${characterId}`);
    } catch {
      return null;
    }
  }, []);

  const listMemoryChunks = useCallback(
    async (characterId: number, opts: { q?: string; limit?: number; offset?: number } = {}) => {
      const q = (opts.q || '').trim();
      const limit = opts.limit ?? 20;
      const offset = opts.offset ?? 0;
      const params = new URLSearchParams({ characterId: String(characterId), limit: String(limit), offset: String(offset) });
      if (q) params.set('q', q);
      try {
        const r = await api<{ items: MemoryChunkItem[]; total: number; mode: string }>(
          `/api/memory/chunks?${params.toString()}`,
        );
        return { items: r.items || [], total: r.total ?? 0, mode: r.mode || 'recent' };
      } catch {
        return { items: [] as MemoryChunkItem[], total: 0, mode: 'recent' };
      }
    },
    [],
  );

  const updateMemoryChunk = useCallback(
    async (id: string, content: string) => {
      try {
        const r = await api<{ content: string; embedded: boolean }>(`/api/memory/chunks/${id}`, {
          method: 'PATCH',
          body: { content },
        });
        notify(r.embedded ? '这条记忆已改写，向量也重算好了' : '已改写，但向量没算成，先按关键词召回');
        return true;
      } catch (e) {
        notify(errorMessage(e, '改写失败'), 'err');
        return false;
      }
    },
    [notify],
  );

  const createMemoryChunk = useCallback(
    async (characterId: number, content: string) => {
      const text = content.trim();
      if (!text) return false;
      try {
        await api('/api/memory/chunks', { method: 'POST', body: { characterId, content: text } });
        notify('已记下');
        return true;
      } catch (e) {
        notify(errorMessage(e, '写入失败'), 'err');
        return false;
      }
    },
    [notify],
  );

  const deleteMemoryChunk = useCallback(
    async (id: string) => {
      try {
        await api(`/api/memory/chunks/${id}`, { method: 'DELETE' });
        notify('这条记忆已删除');
        return true;
      } catch (e) {
        notify(errorMessage(e, '删除失败'), 'err');
        return false;
      }
    },
    [notify],
  );

  const openMemoryPanel = useCallback(
    (characterId?: number | null) => {
      const id = characterId ?? activeId;
      if (!id) {
        notify('先选一个角色', 'err');
        return;
      }
      setMemoryPanel({ open: true, characterId: id });
    },
    [activeId, notify],
  );

  const closeMemoryPanel = useCallback(() => setMemoryPanel({ open: false, characterId: null }), []);

  const uploadAvatar = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/')) {
        notify('只能选图片文件', 'err');
        return null;
      }
      if (file.size > 3 * 1024 * 1024) {
        notify('图片不能超过 3MB', 'err');
        return null;
      }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('读取图片失败'));
        reader.readAsDataURL(file);
      });
      try {
        const data = await api<{ url: string }>('/api/uploads', { method: 'POST', body: { dataUrl } });
        return data.url;
      } catch (e) {
        notify(errorMessage(e, '上传失败'), 'err');
        return null;
      }
    },
    [notify],
  );

  const selectCharacter = useCallback((id: number | null) => setActiveId(id), []);

  const createCharacter = useCallback(
    async (draft: CharacterDraft) => {
      try {
        const data = await api<{ character: Character }>('/api/characters', {
          method: 'POST',
          body: draft,
        });
        const created = data.character;
        setCharacters((prev) => [...prev, created]);
        setMessages((prev) => ({ ...prev, [created.id]: [] }));
        setMemories((prev) => ({ ...prev, [created.id]: [] }));
        setGames((prev) => ({ ...prev, [created.id]: [] }));
        setActiveId(created.id);
        notify('角色已创建');
        return created;
      } catch (e) {
        notify(errorMessage(e, '创建角色失败'), 'err');
        return null;
      }
    },
    [notify],
  );

  const updateCharacter = useCallback(
    async (id: number, patch: Partial<Character>) => {
      try {
        const data = await api<{ character: Character }>(`/api/characters/${id}`, {
          method: 'PATCH',
          body: patch,
        });
        setCharacters((prev) => prev.map((c) => (c.id === id ? data.character : c)));
      } catch (e) {
        notify(errorMessage(e, '保存失败'), 'err');
      }
    },
    [notify],
  );

  const deleteCharacter = useCallback(
    async (id: number) => {
      try {
        await api(`/api/characters/${id}`, { method: 'DELETE' });
        setCharacters((prev) => prev.filter((c) => c.id !== id));
        setPosts((prev) => prev.filter((p) => p.character_id !== id));
        setActiveId((prev) => (prev === id ? null : prev));
        notify('角色已删除');
      } catch (e) {
        notify(errorMessage(e, '删除失败'), 'err');
      }
    },
    [notify],
  );

  const stopStreaming = useCallback(() => {
    // 还在攒的连发消息也一并取消
    const q = pendingRef.current;
    if (q && q.timer) clearTimeout(q.timer);
    pendingRef.current = null;
    setPendingReply(false);
    abortRef.current?.abort();
  }, []);

  const resetContext = useCallback(
    async (characterId: number) => {
      try {
        const r = await api<{ message: Message }>(`/api/characters/${characterId}/context`, { method: 'POST' });
        setMessages((prev) => ({
          ...prev,
          [characterId]: [...(prev[characterId] ?? []), r.message],
        }));
        notify('已清空上下文，下一条消息重新开始');
        return true;
      } catch (e) {
        notify(errorMessage(e, '清空失败'), 'err');
        return false;
      }
    },
    [notify],
  );

  /** 真正跑一轮回复：上下文已经在库里，不再插入用户消息 */
  const runReply = useCallback(
    async (characterId: number, text: string) => {
      if (streamingRef.current) return;
      streamingRef.current = true;
      setStreaming(true);
      setStreamingText('');

      const controller = new AbortController();
      abortRef.current = controller;
      let failed = '';

      const patch = (fn: (list: Message[]) => Message[]) =>
        setMessages((prev) => ({ ...prev, [characterId]: fn(prev[characterId] ?? []) }));

      try {
        await streamChat(
          { characterId, input: text, persistUser: false },
          {
            onDelta: (t) => setStreamingText((prev) => prev + t),
            onAssistant: (msg, meta) => {
              const saved = msg as Message;
              patch((list) => [...list, saved]);
              setStreamingText('');
              if (meta.level !== undefined && meta.affinity !== undefined) {
                setCharacters((prev) =>
                  prev.map((c) =>
                    c.id === characterId
                      ? { ...c, affinity: meta.affinity!, relationship_level: meta.level! }
                      : c,
                  ),
                );
              }
            },
            onImage: (msg) => patch((list) => [...list, msg as Message]),
            onError: (m) => {
              failed = m;
            },
          },
          controller.signal,
        );
      } catch (e) {
        if ((e as Error).name === 'AbortError') {
          notify('已停止生成');
        } else {
          failed = errorMessage(e, '回复失败，请重试');
        }
      } finally {
        if (failed && failed !== '已停止生成') {
          const errId = -Date.now() - 1;
          patch((list) => [
            ...list,
            {
              id: errId,
              character_id: characterId,
              role: 'assistant',
              content: failed,
              kind: 'error',
              created_at: new Date().toISOString(),
            },
          ]);
          notify('回复失败，详情见对话里', 'err');
        } else if (failed) {
          notify('已停止生成');
        }
        abortRef.current = null;
        streamingRef.current = false;
        setStreaming(false);
        setStreamingText('');
        setPendingReply(false);
      }
    },
    [notify],
  );

  /**
   * 发消息：每条立刻落库上屏，然后等 2 秒看还有没有下文。
   * 很多人的习惯是一条话拆成几段发，攒成一轮再回复才像真人对话。
   */
  const sendMessage = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || !active || streaming) return;

      if (!currentModelOption) {
        notify('还没有可用的模型，请先在设置里添加供应商', 'err');
        setSettingsOpen(true);
        return;
      }

      const characterId = active.id;
      const tempId = -Date.now();
      setMessages((prev) => ({
        ...prev,
        [characterId]: [
          ...(prev[characterId] ?? []),
          {
            id: tempId,
            character_id: characterId,
            role: 'user',
            content,
            kind: 'text',
            created_at: new Date().toISOString(),
          },
        ],
      }));

      try {
        const r = await api<{ message: Message }>(`/api/characters/${characterId}/messages`, {
          method: 'POST',
          body: { role: 'user', content, kind: 'text' },
        });
        setMessages((prev) => ({
          ...prev,
          [characterId]: (prev[characterId] ?? []).map((m) => (m.id === tempId ? r.message : m)),
        }));
      } catch (e) {
        setMessages((prev) => ({
          ...prev,
          [characterId]: (prev[characterId] ?? []).filter((m) => m.id !== tempId),
        }));
        notify(errorMessage(e, '发送失败'), 'err');
        return;
      }

      // 同一角色、DEBOUNCE_MS 内的连发算同一轮
      const prevQueue = pendingRef.current;
      const queue =
        prevQueue && prevQueue.characterId === characterId
          ? prevQueue
          : { characterId, texts: [] as string[], timer: 0 as unknown as ReturnType<typeof setTimeout> };
      queue.texts.push(content);
      if (queue.timer) clearTimeout(queue.timer);
      setPendingReply(true);
      queue.timer = setTimeout(() => {
        const joined = queue.texts.join('\n');
        queue.texts = [];
        queue.timer = 0 as unknown as ReturnType<typeof setTimeout>;
        pendingRef.current = null;
        void runReply(characterId, joined);
      }, DEBOUNCE_MS);
      pendingRef.current = queue;
    },
    [active, currentModelOption, notify, runReply, streaming],
  );

  const pushMessage = useCallback((msg: Message) => {
    setMessages((prev) => {
      const list = prev[msg.character_id] ?? [];
      if (list.some((m) => m.id === msg.id)) return prev;
      return { ...prev, [msg.character_id]: [...list, msg] };
    });
  }, []);

  const addMemory = useCallback(
    async (characterId: number, content: string) => {
      const text = content.trim();
      if (!text) return;
      try {
        const data = await api<{ memory: Memory }>(`/api/characters/${characterId}/memories`, {
          method: 'POST',
          body: { content: text },
        });
        setMemories((prev) => ({ ...prev, [characterId]: [data.memory, ...(prev[characterId] ?? [])] }));
        notify('已加入长期记忆');
      } catch (e) {
        notify(errorMessage(e, '添加记忆失败'), 'err');
      }
    },
    [notify],
  );

  const removeMemory = useCallback(
    async (memoryId: number, characterId: number) => {
      try {
        await api(`/api/memories/${memoryId}`, { method: 'DELETE' });
        setMemories((prev) => ({
          ...prev,
          [characterId]: (prev[characterId] ?? []).filter((m) => m.id !== memoryId),
        }));
      } catch (e) {
        notify(errorMessage(e, '删除记忆失败'), 'err');
      }
    },
    [notify],
  );

  const createPost = useCallback(
    async (characterId: number) => {
      const character = characters.find((c) => c.id === characterId);
      try {
        const data = await api<{ post: Post }>(`/api/characters/${characterId}/posts`, { method: 'POST' });
        setPosts((prev) => [data.post, ...prev]);
        notify(`${character?.name ?? '角色'} 发了一条动态`);
      } catch (e) {
        notify(errorMessage(e, '生成动态失败'), 'err');
      }
    },
    [characters, notify],
  );

  const deletePost = useCallback(
    async (postId: number) => {
      try {
        await api(`/api/posts/${postId}`, { method: 'DELETE' });
        setPosts((prev) => prev.filter((p) => p.id !== postId));
      } catch (e) {
        notify(errorMessage(e, '删除失败'), 'err');
      }
    },
    [notify],
  );

  const toggleLike = useCallback(
    async (postId: number) => {
      const before = posts.find((p) => p.id === postId);
      if (!before) return;
      const optimisticLiked = !before.liked;
      const optimisticLikes = Math.max(0, before.likes + (optimisticLiked ? 1 : -1));
      setPosts((prev) =>
        prev.map((p) => (p.id === postId ? { ...p, liked: optimisticLiked, likes: optimisticLikes } : p)),
      );
      try {
        const data = await api<{ liked: boolean; likes: number }>(`/api/posts/${postId}/like`, {
          method: 'POST',
        });
        setPosts((prev) =>
          prev.map((p) => (p.id === postId ? { ...p, liked: data.liked, likes: data.likes } : p)),
        );
      } catch (e) {
        setPosts((prev) => prev.map((p) => (p.id === postId ? before : p)));
        notify(errorMessage(e, '操作失败'), 'err');
      }
    },
    [notify, posts],
  );

  const exportCharacter = useCallback(
    async (id: number) => {
      const character = characters.find((c) => c.id === id);
      if (!character) return;
      try {
        const data = await api<{ memories: Memory[]; archive: MemoryChunkItem[] }>(
          `/api/characters/${id}/data`,
        );
        const file = buildCardFile(character, data.memories || [], data.archive || []);
        const how = await downloadJsonFile(file, character.name, 'character');
        notify(
          how === 'copied'
            ? '角色卡已复制到剪贴板（写文件失败）'
            : how === 'shared'
              ? `角色卡已生成：${file.memories.length + file.archive.length} 条记忆`
              : '已导出角色卡（人设 + 记忆）',
        );
      } catch (e) {
        notify(errorMessage(e, '导出失败'), 'err');
      }
    },
    [characters, notify],
  );

  /** 聊天记录单独导出，和角色卡互不干扰 */
  const exportChat = useCallback(
    async (id: number) => {
      const character = characters.find((c) => c.id === id);
      if (!character) return;
      try {
        const data = await api<{ messages: Message[] }>(`/api/characters/${id}/data`);
        const list = data.messages || [];
        if (!list.length) {
          notify('这个角色还没有聊天记录', 'err');
          return;
        }
        const file = buildChatFile(character, list);
        const how = await downloadJsonFile(file, character.name, 'chat');
        notify(
          how === 'copied'
            ? '聊天记录已复制到剪贴板（写文件失败）'
            : `聊天记录已导出，共 ${file.messages.length} 条`,
        );
      } catch (e) {
        notify(errorMessage(e, '导出失败'), 'err');
      }
    },
    [characters, notify],
  );

  const importCard = useCallback(
    async (text: string) => {
      let payload: Record<string, unknown>;
      try {
        payload = parseJsonFile(text);
      } catch (e) {
        notify(errorMessage(e, '文件无法解析'), 'err');
        return null;
      }
      if (payload.spec === CHAT_SPEC) {
        notify('这是聊天记录文件，不是角色卡', 'err');
        return null;
      }
      try {
        const res = await api<{ ids?: number[] }>('/api/import', { method: 'POST', body: payload });
        await refresh();
        const newId = res.ids?.[res.ids.length - 1] ?? null;
        if (newId) {
          setActiveId(newId);
          await loadCharacterData(newId);
        }
        notify('角色已导入（人设 + 记忆）');
        return characters.find((c) => c.id === newId) ?? null;
      } catch (e) {
        notify(errorMessage(e, '导入失败'), 'err');
        return null;
      }
    },
    [characters, loadCharacterData, notify, refresh],
  );

  const exportAll = useCallback(async () => {
    try {
      const data = await api<unknown>('/api/export');
      const stamp = new Date().toISOString().slice(0, 10);
      downloadJson(`nuan-backup-${stamp}.json`, data);
      notify('已导出完整备份');
    } catch (e) {
      notify(errorMessage(e, '导出失败'), 'err');
    }
  }, [notify]);

  const importAll = useCallback(
    async (file: File) => {
      try {
        const text = await file.text();
        const payload = parseJsonFile(text);

        // 聊天记录：合并到当前角色
        if (payload.spec === CHAT_SPEC) {
          if (!active) {
            notify('先选一个角色，再导入聊天记录', 'err');
            return;
          }
          const msgs = Array.isArray(payload.messages) ? payload.messages : [];
          if (!msgs.length) {
            notify('这个文件里没有聊天记录', 'err');
            return;
          }
          const res = await api<{ imported: number }>(`/api/import/chat/${active.id}`, {
            method: 'POST',
            body: { messages: msgs },
          });
          await loadCharacterData(active.id);
          notify(`已把 ${res.imported} 条聊天记录合并进「${active.name}」`);
          return;
        }

        const res = await api<{ imported: number; kind?: string }>('/api/import', {
          method: 'POST',
          body: payload,
        });
        await refresh();
        notify(
          res.kind === 'card' ? '角色已导入（人设 + 记忆）' : `已导入 ${res.imported} 个角色`,
        );
      } catch (e) {
        notify(errorMessage(e, '文件无法导入'), 'err');
      }
    },
    [active, loadCharacterData, notify, refresh],
  );

  const value: AppContextValue = {
    ready,
    needsSetup,
    authed,
    user: { name, avatar },
    dbPath,
    characters,
    activeId,
    active,
    messages,
    memories,
    games,
    posts,
    providers,
    current,
    models,
    currentModelOption,
    embedding,
    saveEmbedSource,
    rebuild,
    startRebuild,
    memoryStats,
    listMemoryChunks,
    updateMemoryChunk,
    createMemoryChunk,
    deleteMemoryChunk,
    memoryPanel,
    openMemoryPanel,
    closeMemoryPanel,
    streaming,
    pendingReply,
    streamingText,
    loadingChar,
    toasts,
    settingsOpen,
    openSettings,
    closeSettings,
    notify,
    dismissToast,
    login,
    setup,
    signOut,
    refresh,
    saveName,
    saveAvatar,
    setCurrentModel,
    createProvider,
    updateProvider,
    deleteProvider,
    testProvider,
    uploadAvatar,
    selectCharacter,
    createCharacter,
    updateCharacter,
    deleteCharacter,
    sendMessage,
    stopStreaming,
    resetContext,
    pushMessage,
    addMemory,
    removeMemory,
    createPost,
    deletePost,
    toggleLike,
    exportCharacter,
    exportChat,
    importCard,
    exportAll,
    importAll,
  };

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}
