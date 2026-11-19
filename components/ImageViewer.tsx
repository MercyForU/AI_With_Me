'use client';

import { useEffect } from 'react';
import { assetUrl } from '@/lib/base';
import { IconClose, IconDownload } from './icons';

/**
 * 看图模式：点开聊天里的图片后全屏看，点空白处或按 Esc 关闭。
 * 不做缩放条——手机上双指缩放交给系统，桌面端窗口够大，object-contain 已经够用。
 */
export default function ImageViewer({
  src,
  alt,
  onClose,
}: {
  src: string | null;
  alt?: string;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [src, onClose]);

  if (!src) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/92 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="查看图片"
    >
      <img
        src={assetUrl(src)}
        alt={alt || '图片'}
        className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
      <button
        onClick={onClose}
        className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white/90 transition hover:bg-white/20"
        aria-label="关闭"
      >
        <IconClose size={20} />
      </button>
      <a
        href={assetUrl(src)}
        download
        onClick={(e) => e.stopPropagation()}
        className="absolute bottom-6 flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-[12px] text-white/90 transition hover:bg-white/20"
      >
        <IconDownload size={14} />
        存下来
      </a>
    </div>
  );
}
