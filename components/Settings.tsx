'use client';

import { useEffect, useRef, useState } from 'react';
import { assetUrl } from '@/lib/base';
import { api, errorMessage } from '@/lib/api';
import { isNativeApp } from '@/lib/base';
import { useApp } from '@/lib/store';
import type { MemoryStats, Provider, ProviderKind } from '@/lib/types';
import { ThemeSwitch } from './ThemeProvider';
import { Field, Modal, Spinner } from './ui';
import {
  IconCheck,
  IconDownload,
  IconPlus,
  IconServer,
  IconMemory,
  IconSparkle,
  IconTrash,
  IconUpload,
} from './icons';

const HINT = {
  openai: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:7b' },
} as const;

type Form = {
  id: number | null;
  label: string;
  kind: ProviderKind;
  type: 'openai' | 'ollama';
  baseUrl: string;
  apiKey: string;
  model: string;
  supportsTools: boolean;
  supportsVision: boolean;
};

const EMPTY_FORM: Form = {
  id: null,
  label: '',
  kind: 'chat',
  type: 'openai',
  baseUrl: '',
  apiKey: '',
  model: '',
  supportsTools: false,
  supportsVision: false,
};

export default function Settings() {
  const {
    settingsOpen,
    closeSettings,
    user,
    dbPath,
    providers,
    current,
    saveName,
    saveAvatar,
    uploadAvatar,
    active,
    embedding,
    saveEmbedSource,
    memoryStats,
    openMemoryPanel,
    rebuild,
    startRebuild,
    createProvider,
    updateProvider,
    deleteProvider,
    testProvider,
    exportAll,
    importAll,
    exportCharacter,
    exportChat,
    signOut,
    notify,
    openSettings,
  } = useApp();

  const [name, setName] = useState(user.name);
  const [form, setForm] = useState<Form | null>(null);
  const [testing, setTesting] = useState<number | null>(null);
  const [results, setResults] = useState<Record<number, { ok: boolean; text: string }>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const avatarRef = useRef<HTMLInputElement>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [kindTab, setKindTab] = useState<'chat' | 'embedding' | 'image' | 'tts'>('chat');
  const [mem, setMem] = useState<MemoryStats | null>(null);
  useEffect(() => {
    if (!settingsOpen || !active) return;
    let alive = true;
    void memoryStats(active.id).then((r) => {
      if (alive && r) setMem(r);
    });
    return () => {
      alive = false;
    };
  }, [settingsOpen, active, memoryStats]);

  useEffect(() => {
    void openSettings;
  }, [openSettings]);

  function startAdd() {
    setForm({ ...EMPTY_FORM, kind: kindTab });
  }

  function startEdit(p: Provider) {
    setForm({
      id: p.id,
      label: p.label,
      kind: p.kind || 'chat',
      type: p.type,
      baseUrl: p.baseUrl,
      apiKey: '',
      model: p.preferredModel || p.models[0] || '',
      supportsTools: p.supportsTools,
      supportsVision: p.supportsVision,
    });
  }

  async function runTest(p: Provider) {
    setTesting(p.id);
    const r = await testProvider(p.id);
    setResults((prev) => ({ ...prev, [p.id]: r }));
    setTesting(null);
  }

  return (
    <>
    <Modal
      open={settingsOpen && !form}
      onClose={closeSettings}
      title="设置"
      subtitle="全部保存在本机，不会上传"
      width="max-w-lg"
    >
      <div className="max-h-[64vh] space-y-5 overflow-y-auto pr-1">
        {/* 外观 */}
        <section>
          <h4 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-fg-dimmer">外观</h4>
          <ThemeSwitch />
        </section>

        {/* 称呼与头像 */}
        <section>
          <h4 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-fg-dimmer">
            称呼与头像
          </h4>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => avatarRef.current?.click()}
              title="上传头像"
              className="group relative h-11 w-11 shrink-0 overflow-hidden rounded-full bg-tint/[0.08]"
            >
              {user.avatar ? (
                <img src={assetUrl(user.avatar)} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="flex h-full w-full items-center justify-center text-[14px] font-semibold text-fg">
                  {(name || '我').slice(0, 1)}
                </span>
              )}
              <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-[9px] text-white opacity-0 transition group-hover:opacity-100">
                {uploadingAvatar ? '…' : '换图'}
              </span>
            </button>
            <input
              className="field"
              value={name}
              maxLength={20}
              onChange={(e) => setName(e.target.value)}
              placeholder="怎么称呼你"
            />
            <button
              onClick={async () => {
                await saveName(name.trim() || '我');
                notify('已保存');
              }}
              disabled={name.trim() === user.name}
              className="btn-ghost shrink-0 px-3 text-[12px]"
            >
              保存
            </button>
          </div>
          <div className="mt-1.5 flex items-center gap-2 text-[10.5px] text-fg-dimmer">
            <button onClick={() => avatarRef.current?.click()} className="transition hover:text-fg">
              上传头像
            </button>
            {user.avatar ? (
              <button
                onClick={async () => {
                  await saveAvatar('');
                  notify('已恢复默认头像');
                }}
                className="transition hover:text-danger"
              >
                用默认头像
              </button>
            ) : null}
            <span className="text-fg-dimmer/70">不传就用名字首字</span>
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
              setUploadingAvatar(true);
              const url = await uploadAvatar(file);
              if (url) await saveAvatar(url);
              setUploadingAvatar(false);
              if (url) notify('头像已更新');
            }}
          />
        </section>

        {/* 模型供应商 */}
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-[12px] font-semibold uppercase tracking-wider text-fg-dimmer">模型供应商</h4>
            <button
              onClick={startAdd}
              className="flex items-center gap-1 text-[11.5px] font-medium text-brand-soft"
            >
              <IconPlus size={13} />
              添加
            </button>
          </div>

          <div className="mb-2 grid grid-cols-4 gap-1 rounded-full border border-line bg-tint/[0.03] p-1">
            {([
              ['chat', '对话'],
              ['embedding', '嵌入'],
              ['image', '生图'],
              ['tts', '语音'],
            ] as const).map(([k, label]) => (
              <button
                key={k}
                onClick={() => {
                  setKindTab(k);
                  setForm(null);
                }}
                className={`rounded-full py-1.5 text-[11.5px] font-medium transition ${
                  kindTab === k ? 'bg-surface text-fg ring-1 ring-line' : 'text-fg-dimmer hover:text-fg-dim'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {kindTab === 'embedding' ? (
            <div className="mb-2 space-y-1.5 rounded-xl border border-line bg-tint/[0.02] p-3">
              <p className="text-[11px] text-fg-dimmer">记忆检索用的向量模型</p>
              <button
                onClick={() => void saveEmbedSource('builtin')}
                className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-[12px] transition ${
                  (embedding?.source || 'builtin') === 'builtin'
                    ? 'border-brand/50 bg-brand/[0.07] text-fg'
                    : 'border-line text-fg-dim hover:border-line-strong'
                }`}
              >
                <span className="min-w-0 flex-1 truncate">内置 bge-small-zh-v1.5（INT8，本地）</span>
                {(embedding?.source || 'builtin') === 'builtin' ? <IconCheck size={13} /> : null}
              </button>
              <p className="text-[10.5px] leading-relaxed text-fg-dimmer">
                512 维，CLS 池化，约 24MB。也可以在下面添加自定义嵌入供应商。
              </p>
            </div>
          ) : null}

          {kindTab === 'image' || kindTab === 'tts' ? (
            <div className="mb-2 rounded-xl border border-line bg-tint/[0.02] px-3 py-2.5 text-[11px] leading-relaxed text-fg-dimmer">
              {kindTab === 'image'
                ? '生图供应商（OpenAI 兼容的 /v1/images/generations）。配好之后，角色想给你看画面时会自己画一张发过来；画失败会降级成一句话，不会把标记露出来。'
                : '朗读和语音输入目前用系统自带能力，不需要在这里配置。等接入云端语音服务时再用这个分类。'}
            </div>
          ) : null}

          {kindTab === 'chat' && current ? (
            <div className="mb-2 flex items-center gap-2 rounded-xl border border-brand/25 bg-brand/[0.07] px-3 py-2">
              <IconSparkle size={13} className="shrink-0 text-brand-soft" />
              <p className="min-w-0 flex-1 truncate text-[11.5px] text-fg">
                当前使用 <span className="font-medium">{current.providerLabel}</span> · {current.model}
              </p>
              <span className="shrink-0 text-[10px] text-fg-dimmer">在聊天窗口切换</span>
            </div>
          ) : kindTab === 'chat' ? (
            <div className="mb-2 rounded-xl border border-warn/30 bg-warn/[0.07] px-3 py-2 text-[11.5px] text-fg-dim">
              还没有可用的模型。添加一个供应商后，聊天才能用。
            </div>
          ) : null}

          <div className="space-y-2">
            {providers.filter((p) => (p.kind || 'chat') === kindTab).map((p) => {
              const r = results[p.id];
              return (
                <div key={p.id} className="rounded-xl border border-line bg-tint/[0.02] p-3">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-fg">
                        {p.label}
                        <span className="rounded bg-tint/[0.06] px-1.5 py-[1px] text-[9.5px] font-normal text-fg-dimmer">
                          {p.type === 'ollama' ? 'Ollama' : 'OpenAI 兼容'}
                        </span>
                        {current?.providerId === p.id ? (
                          <span className="rounded bg-brand/15 px-1.5 py-[1px] text-[9.5px] text-brand-soft">
                            使用中
                          </span>
                        ) : null}
                      </p>
                      <p className="mt-1 truncate font-mono text-[10.5px] text-fg-dimmer">{p.baseUrl}</p>
                      <p className="mt-1 text-[10.5px] text-fg-dimmer">
                        {p.models.length ? `${p.models.length} 个模型` : '还没有模型列表'}
                        {p.type === 'openai' && !p.hasKey ? ' · 缺 API Key' : ''}
                      </p>
                      {(p.kind === 'embedding' || p.kind === 'image') && p.models.length > 1 ? (
                        <div className="mt-1.5 flex items-center gap-1.5">
                          <span className="shrink-0 text-[10px] text-fg-dimmer">使用</span>
                          <select
                            className="min-w-0 flex-1 rounded-lg border border-line bg-tint/[0.03] px-1.5 py-1 text-[10.5px] text-fg-dim outline-none"
                            value={p.preferredModel || p.models[0]}
                            onChange={async (e) => {
                              const m = e.target.value;
                              if (m === (p.preferredModel || p.models[0])) return;
                              await updateProvider(p.id, { model: m });
                              notify(
                                p.kind === 'image'
                                  ? `生图模型改为 ${m}`
                                  : `嵌入模型改为 ${m}，历史记忆会在后台重建`,
                              );
                            }}
                          >
                            {p.models.map((m) => (
                              <option key={m} value={m}>
                                {m}
                              </option>
                            ))}
                          </select>
                        </div>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        onClick={() => void runTest(p)}
                        disabled={testing === p.id}
                        className="rounded-lg border border-line px-2 py-1 text-[10.5px] text-fg-dim transition hover:text-fg"
                      >
                        {testing === p.id ? <Spinner size={11} /> : '测试'}
                      </button>
                      <button
                        onClick={() => startEdit(p)}
                        className="rounded-lg border border-line px-2 py-1 text-[10.5px] text-fg-dim transition hover:text-fg"
                      >
                        编辑
                      </button>
                      <button
                        onClick={async () => {
                          await deleteProvider(p.id);
                          notify('已删除供应商');
                        }}
                        className="rounded-lg border border-line p-2 text-fg-dim transition hover:text-danger"
                        title="删除"
                      >
                        <IconTrash size={14} />
                      </button>
                    </div>
                  </div>
                  {r ? (
                    <p className={`mt-2 flex items-center gap-1 text-[10.5px] ${r.ok ? 'text-ok' : 'text-danger'}`}>
                      {r.ok ? <IconCheck size={11} /> : null}
                      {r.text}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>

        {/* 对话记忆 */}
        <section>
          <h4 className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-fg-dimmer">
            <IconSparkle size={12} />
            对话记忆
          </h4>
          <div className="rounded-xl border border-line bg-tint/[0.02] p-3">
            <div className="flex items-center justify-between text-[11.5px] text-fg-dim">
              <span>
                已归档 <span className="font-medium text-fg">{mem?.chunks ?? '—'}</span> 块
                <span className="text-fg-dimmer"> · {mem?.tokens ?? 0} token</span>
              </span>
              <span className="text-[10.5px] text-fg-dimmer">
                待归档 {mem?.pending ?? 0} 条
              </span>
            </div>
            <p className="mt-1.5 text-[10.5px] leading-relaxed text-fg-dimmer">
              记忆常驻开启：滑出最近 {mem?.window ?? 16} 条窗口的对话，攒够 6 条会先用当前模型
              总结成记忆再入库。当前角色：{active?.name || '未选择'}。
            </p>

            {rebuild?.status === 'running' ? (
              <div className="mt-2.5 rounded-lg border border-brand/25 bg-brand/[0.05] px-2.5 py-2">
                <div className="flex items-center justify-between text-[10.5px] text-fg-dim">
                  <span>正在优化历史记忆…</span>
                  <span className="tabular-nums text-fg-dimmer">
                    {rebuild.done} / {rebuild.total}
                  </span>
                </div>
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-tint/[0.08]">
                  <div
                    className="h-full rounded-full bg-brand transition-[width] duration-500"
                    style={{
                      width: `${rebuild.total ? Math.min(100, Math.round((rebuild.done / rebuild.total) * 100)) : 0}%`,
                    }}
                  />
                </div>
                <p className="mt-1.5 text-[10px] leading-relaxed text-fg-dimmer">
                  新消息已经用新模型入库，可以照常聊天；旧记忆重建完成前，关键词检索仍然可用。
                </p>
              </div>
            ) : null}

            {rebuild?.status === 'error' ? (
              <div className="mt-2.5 rounded-lg border border-danger/30 bg-danger/[0.06] px-2.5 py-2">
                <p className="text-[10.5px] leading-relaxed text-danger">
                  重建中断：{rebuild.error || '未知原因'}
                </p>
                <button
                  onClick={() => void startRebuild()}
                  className="mt-1 text-[10.5px] font-medium text-fg-dim underline-offset-2 hover:underline"
                >
                  重试
                </button>
              </div>
            ) : null}

            {rebuild && rebuild.status !== 'running' && rebuild.pending > 0 ? (
              <button
                onClick={() => void startRebuild()}
                className="mt-2 text-[10.5px] text-fg-dim transition hover:text-fg"
              >
                {rebuild.pending} 块还没换用当前模型 · 立即重建
              </button>
            ) : null}

            <button
              onClick={() => openMemoryPanel(active?.id)}
              disabled={!active}
              className="mt-2.5 flex w-full items-center gap-2.5 rounded-xl border border-line bg-tint/[0.03] px-3 py-2.5 text-left transition hover:border-line-strong disabled:opacity-50"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand/[0.12] text-brand-soft">
                <IconMemory size={15} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] font-medium text-fg">打开记忆管理</span>
                <span className="mt-0.5 block text-[10.5px] text-fg-dimmer">
                  查看原文 · 召回测试 · 逐条改写或删除
                </span>
              </span>
              <span className="shrink-0 text-fg-dimmer">›</span>
            </button>
          </div>
        </section>

        {/* 数据 */}
        <section>
          <h4 className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-fg-dimmer">
            <IconServer size={12} />
            数据
          </h4>
          <div className="rounded-xl border border-line bg-tint/[0.02] p-3">
            <p className="text-[11px] text-fg-dimmer">数据库文件</p>
            <p className="mt-1 break-all font-mono text-[11px] leading-relaxed text-fg-dim">
              {dbPath || 'data/app.db'}
            </p>
            <p className="mt-2 text-[11px] leading-relaxed text-fg-dimmer">
              复制这个文件就等于备份全部数据；删掉它等于重置一切。
            </p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-fg-dimmer">
              头像存在 data/uploads/，API Key 用 data/.secret 加密。换电脑时这两样要一起拷。
            </p>
          </div>

          <div className="mt-2 flex gap-2">
            <button onClick={() => void exportAll()} className="btn-ghost h-9 flex-1 text-[12px]">
              <IconDownload size={14} />
              导出完整备份
            </button>
            <button onClick={() => fileRef.current?.click()} className="btn-ghost h-9 flex-1 text-[12px]">
              <IconUpload size={14} />
              导入文件
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importAll(f);
                e.target.value = '';
              }}
            />
          </div>

          <div className="mt-2 rounded-lg border border-line bg-tint/[0.02] px-2.5 py-2">
            <p className="text-[10.5px] leading-relaxed text-fg-dimmer">
              导入会自己认文件类型：
              <span className="text-fg-dim">角色卡</span>（人设 + 记忆，创建新角色）、
              <span className="text-fg-dim">聊天记录</span>（合并到当前角色）、
              <span className="text-fg-dim">完整备份</span>（还原所有角色）。
            </p>
          </div>

          <div className="mt-2 flex gap-2">
            <button
              onClick={() => active && void exportCharacter(active.id)}
              disabled={!active}
              className="btn-ghost h-9 flex-1 text-[12px] disabled:opacity-50"
            >
              <IconDownload size={14} />
              导出角色卡
            </button>
            <button
              onClick={() => active && void exportChat(active.id)}
              disabled={!active}
              className="btn-ghost h-9 flex-1 text-[12px] disabled:opacity-50"
            >
              <IconDownload size={14} />
              导出聊天记录
            </button>
          </div>
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-fg-dimmer">
            角色卡只带人设和记忆；聊天记录是单独一份 .json，可以单独备份或搬到别的角色上。
          </p>
        </section>

        {isNativeApp() ? null : (
          <section className="border-t border-line pt-4">
            <button
              onClick={() => {
                closeSettings();
                void signOut();
              }}
              className="btn-ghost h-9 w-full text-[12px] text-danger hover:text-danger"
            >
              退出登录
            </button>
          </section>
        )}
      </div>

      <div className="mt-5 flex gap-2">
        <button onClick={closeSettings} className="btn-ghost flex-1">
          关闭
        </button>
      </div>

    </Modal>

    <ProviderForm
      form={form}
      onClose={() => setForm(null)}
      onDone={(message, ok) => {
        setForm(null);
        notify(message, ok ? 'ok' : 'err');
      }}
    />
    </>
  );
}

function ProviderForm({
  form,
  onClose,
  onDone,
}: {
  form: Form | null;
  onClose: () => void;
  onDone: (message: string, ok: boolean) => void;
}) {
  const { createProvider, updateProvider, testProvider } = useApp();
  const [local, setLocal] = useState<Form>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<{ ok: boolean; status: number; body: string } | null>(null);

  useEffect(() => {
    if (form) {
      setLocal(form);
      setProbe(null);
    }
  }, [form]);

  const open = !!form;
  const isEdit = !!local.id;

  async function submit() {
    setBusy(true);
    try {
      if (isEdit) {
        await updateProvider(local.id as number, {
          label: local.label,
          type: local.type,
          baseUrl: local.baseUrl,
          apiKey: local.apiKey.trim() ? local.apiKey : '__KEEP__',
          model: local.model.trim() || undefined,
          supportsTools: local.supportsTools,
          supportsVision: local.supportsVision,
        });
        const r = await testProvider(local.id as number);
        onDone(r.ok ? '已保存并连通' : `已保存，但连接未通过：${r.text}`, r.ok);
      } else {
        await createProvider({
          label: local.label,
          kind: local.kind,
          type: local.type,
          baseUrl: local.baseUrl,
          apiKey: local.apiKey,
          model: local.model.trim() || undefined,
          supportsTools: local.supportsTools,
          supportsVision: local.supportsVision,
        });
        onDone('供应商已保存，模型已拉取', true);
      }
    } catch (e) {
      onDone(errorMessage(e, '保存失败'), false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? '编辑供应商' : '添加供应商'}
      subtitle="API Key 会加密存在本机数据库里"
      width="max-w-md"
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Field label="名称">
            <input
              className="field py-2 text-[12.5px]"
              value={local.label}
              maxLength={40}
              onChange={(e) => setLocal({ ...local, label: e.target.value })}
              placeholder="留空自动命名"
            />
          </Field>
          <Field label="类型">
            <select
              className="field py-2 text-[12.5px]"
              value={local.type}
              onChange={(e) => {
                const type = e.target.value as 'openai' | 'ollama';
                setLocal({
                  ...local,
                  type,
                  baseUrl:
                    !local.baseUrl || local.baseUrl === HINT[local.type].baseUrl
                      ? HINT[type].baseUrl
                      : local.baseUrl,
                  model: local.model,
                });
              }}
            >
              <option value="openai">OpenAI 兼容</option>
              <option value="ollama">本地 Ollama</option>
            </select>
          </Field>
        </div>

        <Field label="接口地址" hint="填到 /v1 为止">
          <input
            className="field py-2 text-[12.5px]"
            value={local.baseUrl}
            onChange={(e) => setLocal({ ...local, baseUrl: e.target.value })}
            placeholder={HINT[local.type].baseUrl}
            spellCheck={false}
          />
        </Field>

        {local.type === 'openai' ? (
          <Field label="API Key" hint={isEdit ? '留空则不修改' : '必填'}>
            <input
              className="field py-2 text-[12.5px]"
              type="password"
              value={local.apiKey}
              onChange={(e) => setLocal({ ...local, apiKey: e.target.value })}
              placeholder={isEdit ? '••••••（留空不修改）' : 'sk-...'}
              spellCheck={false}
            />
          </Field>
        ) : null}

        <Field label="模型名" hint="留空自动拉取模型列表">
          <input
            className="field py-2 text-[12.5px]"
            value={local.model}
            onChange={(e) => setLocal({ ...local, model: e.target.value })}
            placeholder=""
            spellCheck={false}
          />
        </Field>

        {local.kind === 'chat' ? (
          <div className="space-y-1.5 rounded-xl border border-line bg-tint/[0.02] px-3 py-2.5">
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                checked={local.supportsTools}
                onChange={(e) => setLocal({ ...local, supportsTools: e.target.checked })}
                className="mt-0.5 accent-[rgb(var(--brand))]"
              />
              <span className="text-[11.5px] leading-snug text-fg-dim">
                支持工具调用
                <span className="block text-[10.5px] text-fg-dimmer">
                  勾了才走原生 function calling（角色能主动画图）。不确定就别勾，会自动退回标记协议，一样能用。
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                checked={local.supportsVision}
                onChange={(e) => setLocal({ ...local, supportsVision: e.target.checked })}
                className="mt-0.5 accent-[rgb(var(--brand))]"
              />
              <span className="text-[11.5px] leading-snug text-fg-dim">
                支持看图
                <span className="block text-[10.5px] text-fg-dimmer">
                  这个模型能理解图片。纯文本模型不用勾。
                </span>
              </span>
            </label>
          </div>
        ) : null}
      </div>

      {isEdit && local.kind === 'chat' ? (
        <div className="mt-3 rounded-xl border border-line bg-tint/[0.02] p-2.5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] leading-snug text-fg-dim">
              发一句「你好」给上游，看它到底返回什么
            </p>
            <button
              onClick={async () => {
                setProbing(true);
                try {
                  const r = await api<{ ok: boolean; status: number; body: string }>(
                    `/api/providers/${local.id}/chat-test`,
                    { method: 'POST', body: { model: local.model } },
                  );
                  setProbe(r);
                } catch (e) {
                  setProbe({ ok: false, status: 0, body: errorMessage(e, '请求失败') });
                } finally {
                  setProbing(false);
                }
              }}
              disabled={probing}
              className="shrink-0 rounded-lg border border-line px-2.5 py-1 text-[11px] text-fg-dim transition hover:text-fg"
            >
              {probing ? '…' : '测试对话'}
            </button>
          </div>
          {probe ? (
            <div className="mt-2">
              <p className={`text-[10.5px] ${probe.ok ? 'text-ok' : 'text-danger'}`}>
                HTTP {probe.status || '—'} {probe.ok ? '成功' : '失败'}
              </p>
              <pre className="mt-1 max-h-[120px] overflow-auto whitespace-pre-wrap break-all rounded-lg bg-tint/[0.04] p-2 text-[10.5px] leading-relaxed text-fg-dim">
                {probe.body}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}


      <div className="mt-5 flex gap-2">
        <button onClick={onClose} className="btn-ghost flex-1">
          取消
        </button>
        <button onClick={submit} disabled={busy} className="btn-primary flex-1">
          {busy ? <Spinner size={15} /> : null}
          {isEdit ? '保存并测试' : '保存'}
        </button>
      </div>
    </Modal>
  );
}
