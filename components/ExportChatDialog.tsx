'use client';

import { useState } from 'react';
import { useApp } from '@/lib/store';
import { Modal } from './ui';

/**
 * 导出聊天记录前的询问框：要不要把图片一起打包。
 * 带图 = 图片内嵌成 base64，换设备也能看，但文件大；
 * 不带图 = 只有文字，文件轻。
 */
export default function ExportChatDialog() {
  const { exportChatTarget, closeExportChat, exportChat } = useApp();
  const [busy, setBusy] = useState<'img' | 'text' | null>(null);

  const open = Boolean(exportChatTarget);
  const images = exportChatTarget?.images ?? 0;

  async function run(withImages: boolean) {
    if (!exportChatTarget) return;
    const { id } = exportChatTarget;
    setBusy(withImages ? 'img' : 'text');
    closeExportChat(); // 先收起弹窗，别挡着系统分享面板
    try {
      await exportChat(id, withImages);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal
      open={open}
      onClose={closeExportChat}
      title="导出聊天记录"
      subtitle={
        images > 0
          ? `这段对话里有 ${images} 张图，要不要一起打包？`
          : '这段对话里没有图片，直接导文字就行'
      }
      width="max-w-sm"
    >
      <div className="space-y-2">
        <button
          onClick={() => void run(true)}
          disabled={busy !== null || images === 0}
          className="w-full rounded-xl border border-brand/40 bg-brand/10 px-3.5 py-2.5 text-left transition hover:bg-brand/15 disabled:opacity-40"
        >
          <span className="block text-[13px] font-medium text-brand-soft">
            {busy === 'img' ? '正在打包…' : `带图导出${images ? `（${images} 张）` : ''}`}
          </span>
          <span className="mt-0.5 block text-[10.5px] leading-snug text-fg-dim">
            图片内嵌进文件，换台设备也能看到；文件会大一些
          </span>
        </button>

        <button
          onClick={() => void run(false)}
          disabled={busy !== null}
          className="w-full rounded-xl border border-line px-3.5 py-2.5 text-left transition hover:bg-tint/[0.04] disabled:opacity-40"
        >
          <span className="block text-[13px] font-medium text-fg">
            {busy === 'text' ? '正在导出…' : '只导文字'}
          </span>
          <span className="mt-0.5 block text-[10.5px] leading-snug text-fg-dim">
            最轻的一份，图片不会带出来
          </span>
        </button>

        <button onClick={closeExportChat} className="btn-ghost w-full text-[12.5px]">
          取消
        </button>
      </div>
    </Modal>
  );
}
