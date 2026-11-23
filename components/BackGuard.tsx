'use client';

import { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { useApp } from '@/lib/store';
import { Modal } from './ui';

/**
 * 安卓返回键：逐级后退，退到主界面再问「退出吗」。
 *
 * 层级顺序：
 *   弹窗里的二级页面 → 弹窗 → 角色/对话详情 → 非「聊天」Tab → 退出确认
 *
 * 浏览器 / WebView 里没有硬件返回键，用 history 占位兜底：
 * 每次返回先落到占位，处理完再补一个，这样默认的「退出页面」永远不会发生。
 */
export default function BackGuard({
  tab,
  onBackToHome,
}: {
  tab: string;
  onBackToHome: () => void;
}) {
  const { backStack, active, characters } = useApp();
  const [askExit, setAskExit] = useState(false);
  // 退出提示里带上当前角色名，比干巴巴一句「确认退出」更像在跟人说话
  const who = active?.name || (characters.length ? characters[0].name : '她');
  const stackRef = useRef(backStack);
  stackRef.current = backStack;
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const homeRef = useRef(onBackToHome);
  homeRef.current = onBackToHome;

  useEffect(() => {
    let removed = false;

    /** @returns true 表示这次返回已经被消费掉了 */
    const handle = () => {
      const stack = stackRef.current();
      if (stack.length) {
        stack[stack.length - 1].run();
        return true;
      }
      // 还在二级 Tab 上：先回「聊天」主界面
      if (tabRef.current !== 'chat') {
        homeRef.current();
        return true;
      }
      // 已经在主界面了：问一句
      setAskExit(true);
      return false;
    };

    // ---- 安卓原生返回键 ----
    let listener: { remove: () => void } | null = null;
    if (Capacitor.isNativePlatform()) {
      void CapacitorApp.addListener('backButton', () => {
        handle();
      }).then((l) => {
        listener = l;
      });
    }

    // ---- 浏览器 / WebView 的 history 兜底 ----
    const pushPlaceholder = () => {
      try {
        window.history.pushState({ nuanGuard: true }, '');
      } catch {
        /* 隐私模式下可能抛错，忽略 */
      }
    };
    pushPlaceholder();

    const onPop = () => {
      if (removed) return;
      handle();
      // 不管退没退成，都把占位补回来，否则下一次返回就真的退出了
      pushPlaceholder();
    };
    window.addEventListener('popstate', onPop);

    return () => {
      removed = true;
      listener?.remove();
      window.removeEventListener('popstate', onPop);
    };
  }, []);

  return (
    <Modal
      open={askExit}
      onClose={() => setAskExit(false)}
      width="max-w-[320px]"
      center
    >
      <div className="text-center">
        <p className="text-[15px] font-semibold text-fg">要走了吗</p>
        <p className="mt-2 text-[12.5px] leading-relaxed text-fg-dim">
          {who}还在等你。
          <br />
          刚才说的那些，都记着呢。
        </p>
      </div>

      <div className="mt-5 flex flex-col gap-2">
        <button onClick={() => setAskExit(false)} className="btn-primary w-full">
          再待一会儿
        </button>
        <button
          onClick={() => {
            setAskExit(false);
            if (Capacitor.isNativePlatform()) void CapacitorApp.exitApp();
          }}
          className="w-full rounded-xl py-2 text-[12px] text-fg-dimmer transition hover:text-fg-dim"
        >
          真的走了
        </button>
      </div>
    </Modal>
  );
}
