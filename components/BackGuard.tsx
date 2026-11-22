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
  const { backStack } = useApp();
  const [askExit, setAskExit] = useState(false);
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
      title="退出暧？"
      subtitle="聊天记录和记忆都留在本机，下次打开还在"
      width="max-w-xs"
    >
      <div className="flex gap-2">
        <button onClick={() => setAskExit(false)} className="btn-primary flex-1">
          再待一会儿
        </button>
        <button
          onClick={() => {
            setAskExit(false);
            if (Capacitor.isNativePlatform()) void CapacitorApp.exitApp();
          }}
          className="btn-ghost flex-1 text-danger hover:text-danger"
        >
          退出
        </button>
      </div>
    </Modal>
  );
}
