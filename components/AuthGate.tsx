'use client';

import { useState } from 'react';
import { useApp } from '@/lib/store';
import { errorMessage } from '@/lib/api';
import { isNativeApp } from '@/lib/base';
import { IconBolt, IconKey, IconLock, IconServer } from './icons';
import { Spinner } from './ui';

export default function AuthGate() {
  const { needsSetup, login, setup, user } = useApp();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const isSetup = needsSetup;
  const native = isNativeApp();

  async function submit() {
    setError('');
    if (password.trim().length < 4) {
      setError('密码至少 4 位');
      return;
    }
    if (isSetup && password !== confirm) {
      setError('两次输入的密码不一致');
      return;
    }
    setBusy(true);
    try {
      if (isSetup) await setup(password, name.trim() || '我');
      else await login(password);
    } catch (e) {
      setError(errorMessage(e, isSetup ? '设置失败' : '密码不对'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden px-5 py-10">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-[-180px] h-[420px] w-[620px] -translate-x-1/2 rounded-full bg-brand/15 blur-[130px]" />
        <div className="absolute bottom-[-200px] right-[-80px] h-[380px] w-[380px] rounded-full bg-brand-blue/10 blur-[120px]" />
      </div>

      <div className="relative flex w-full max-w-[1040px] flex-col items-center gap-12 lg:flex-row lg:items-center lg:gap-16">
        {/* 左：门禁卡片 */}
        <div className="w-full max-w-[400px] shrink-0">
          <div className="flex items-center gap-3 lg:hidden">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-brand to-brand-blue text-xl font-bold text-white shadow-glow">
              暧
            </div>
            <div>
              <p className="text-[17px] font-semibold text-fg">暧</p>
              <p className="text-[12px] text-fg-dimmer">
                {native ? '手机版 · 数据只在这台手机' : '本机版 · 数据不出这台电脑'}
              </p>
            </div>
          </div>

          <div className="mt-6 rounded-3xl border border-line bg-surface/80 p-7 shadow-panel backdrop-blur-sm lg:mt-0">
            <div className="mb-5 flex items-center gap-2 text-[11px] text-fg-dimmer">
              <span className="inline-flex items-center gap-1 rounded-full border border-line bg-tint/[0.03] px-2.5 py-1">
                <IconServer size={11} /> {native ? '离线可用' : '本机服务'}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full border border-line bg-tint/[0.03] px-2.5 py-1">
                <IconLock size={11} /> 仅本机可读
              </span>
            </div>

            <h2 className="text-[23px] font-bold tracking-tight text-fg">
              {isSetup ? '第一次启动' : `欢迎，${user.name && user.name !== '我' ? user.name : '你'}`}
            </h2>
            <p className="mt-2 text-[12.5px] leading-relaxed text-fg-dim">
              {isSetup
                ? '先告诉我怎么称呼你，再设一个至少 4 位的密码。之后每次打开都要输一次。'
                : '输入密码继续。密码只校验在这台设备上，不会上传。'}
            </p>

            <div className="mt-6 space-y-3">
              {isSetup ? (
                <input
                  className="field"
                  value={name}
                  maxLength={20}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="怎么称呼你，例如 阿泽"
                />
              ) : null}

              <input
                className="field"
                type="password"
                value={password}
                onChange={(e) => {
                  setError('');
                  setPassword(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isSetup) void submit();
                }}
                placeholder={isSetup ? '设置访问密码（至少 4 位）' : '访问密码'}
                autoFocus
              />

              {isSetup ? (
                <input
                  className="field"
                  type="password"
                  value={confirm}
                  onChange={(e) => {
                    setError('');
                    setConfirm(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submit();
                  }}
                  placeholder="再输一次确认"
                />
              ) : null}
            </div>

            {error ? <p className="mt-3 text-[12px] leading-relaxed text-danger">{error}</p> : null}

            <button onClick={submit} disabled={busy || !password} className="btn-primary mt-5 w-full py-3">
              {busy ? <Spinner size={16} /> : <IconKey size={16} />}
              {isSetup ? '设置并进入' : '进入'}
            </button>

            <p className="mt-4 text-center text-[11px] leading-relaxed text-fg-dimmer">
              {native
                ? '忘记密码只能重装应用，角色和聊天记录会一起没。'
                : '忘记密码？删掉 data/app.db 会重置一切（数据也会一起没）。'}
            </p>
          </div>
        </div>
        {/* 右：产品主张 */}
        <div className="hidden flex-1 lg:block">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-brand to-brand-blue text-lg font-bold text-white shadow-glow">
              暧
            </div>
            <span className="text-sm font-semibold tracking-wide text-fg-dim">AI 陪伴平台 · 本机版</span>
          </div>

          <h1 className="mt-9 text-[40px] font-bold leading-[1.18] tracking-tight text-fg">
            跑在你自己电脑上，
            <br />
            <span className="bg-gradient-to-r from-brand-soft to-brand-blue bg-clip-text text-transparent">
              数据不出这台机器。
            </span>
          </h1>
          <p className="mt-5 max-w-[460px] text-[14.5px] leading-relaxed text-fg-dim">
            没有云端账号，没有平台托管。角色、记忆、聊天记录都存在本机的一个 SQLite 文件里，
            手机连同一个局域网也能用。
          </p>

          <div className="mt-9 space-y-4">
            {[
              ['数据在 data/app.db', '一个文件就是全部，复制走就能带走'],
              ['模型自己选', 'OpenAI 兼容接口或本地 Ollama，Key 加密存本机'],
              ['双端同一份数据', '电脑开着服务，手机浏览器直接连'],
            ].map(([title, desc]) => (
              <div key={title} className="flex gap-3">
                <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-brand/15 text-brand-soft">
                  <IconBolt size={14} />
                </div>
                <div>
                  <p className="text-[13.5px] font-medium text-fg">{title}</p>
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-fg-dimmer">{desc}</p>
                </div>
              </div>
            ))}
          </div>

          <p className="mt-9 text-[11.5px] text-fg-dimmer">
            不向未成年人提供虚拟伴侣服务 · AI 生成内容均会标识
          </p>
        </div>

      </div>
    </div>
  );
}
