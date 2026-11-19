'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { assetUrl } from '@/lib/base';
import { IconClose, IconDownload } from './icons';

const MIN_SCALE = 1;
const MAX_SCALE = 6;

type Point = { x: number; y: number };

const clamp = (v: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, v));
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * 看图模式：支持滚轮 / 双指缩放、拖动平移、双击放大。
 *
 * 缩放用 translate + scale（原点在中心），并让「指针下的那个点」保持不动，
 * 这样滚轮和双指都不会越放越跑偏。
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
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [pinching, setPinching] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  /** 这一次按下之后有没有拖动过（pointerup 后 drag.current 会被清掉，得单独记） */
  const movedRef = useRef(false);
  const scaleRef = useRef(1);
  const offsetRef = useRef<Point>({ x: 0, y: 0 });

  const pointers = useRef(new Map<number, Point>());
  const pinch = useRef<{ startDist: number; startScale: number; startMid: Point; startOffset: Point } | null>(
    null,
  );
  const drag = useRef<{ start: Point; origin: Point; moved: boolean } | null>(null);
  const lastTap = useRef<{ t: number; p: Point } | null>(null);

  const apply = useCallback((s: number, o: Point) => {
    scaleRef.current = s;
    offsetRef.current = o;
    setScale(s);
    setOffset(o);
  }, []);

  const reset = useCallback(() => apply(1, { x: 0, y: 0 }), [apply]);

  /** 以屏幕上的 (clientX, clientY) 为锚点缩放到 nextScale */
  const zoomAt = useCallback(
    (nextScale: number, clientX: number, clientY: number) => {
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect) return;
      const s = clamp(nextScale);
      if (s <= 1.001) {
        apply(1, { x: 0, y: 0 });
        return;
      }
      // 相对舞台中心的坐标
      const qx = clientX - (rect.left + rect.width / 2);
      const qy = clientY - (rect.top + rect.height / 2);
      const r = s / scaleRef.current;
      const o = offsetRef.current;
      apply(s, { x: qx - (qx - o.x) * r, y: qy - (qy - o.y) * r });
    },
    [apply],
  );

  /** 以视野中心缩放（给按钮用） */
  const zoomBy = useCallback(
    (factor: number) => {
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect) return;
      zoomAt(scaleRef.current * factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
    },
    [zoomAt],
  );

  // 换图时归位
  useEffect(() => {
    reset();
    pointers.current.clear();
    pinch.current = null;
    drag.current = null;
  }, [src, reset]);

  // Esc 关闭、+/- 缩放、0 归位
  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === '+' || e.key === '=') zoomBy(1.25);
      else if (e.key === '-') zoomBy(0.8);
      else if (e.key === '0') reset();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [src, onClose, zoomBy, reset]);

  // 滚轮缩放：必须非 passive 才能 preventDefault
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !src) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(scaleRef.current * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [src, zoomAt]);

  if (!src) return null;

  const onPointerDown = (e: React.PointerEvent) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    movedRef.current = false;

    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = {
        startDist: distance(a, b) || 1,
        startScale: scaleRef.current,
        startMid: midpoint(a, b),
        startOffset: offsetRef.current,
      };
      drag.current = null;
      setPinching(true);
      return;
    }

    if (scaleRef.current > 1) {
      // 只有真的要拖时才捕获指针，否则 click 的 target 会被改写
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      drag.current = {
        start: { x: e.clientX, y: e.clientY },
        origin: offsetRef.current,
        moved: false,
      };
      setDragging(true);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // 双指：缩放 + 跟随手指平移
    if (pointers.current.size >= 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const g = pinch.current;
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect) return;
      const s = clamp(g.startScale * (distance(a, b) / g.startDist));
      const mid = midpoint(a, b);
      const r = s / g.startScale;
      // 锚点用起始双指中点（相对舞台中心）
      const ax = g.startMid.x - (rect.left + rect.width / 2);
      const ay = g.startMid.y - (rect.top + rect.height / 2);
      const next = {
        x: ax - (ax - g.startOffset.x) * r + (mid.x - g.startMid.x),
        y: ay - (ay - g.startOffset.y) * r + (mid.y - g.startMid.y),
      };
      apply(s, s <= 1.001 ? { x: 0, y: 0 } : next);
      return;
    }

    // 单指 / 鼠标：拖动平移
    if (drag.current) {
      const dx = e.clientX - drag.current.start.x;
      const dy = e.clientY - drag.current.start.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        drag.current.moved = true;
        movedRef.current = true;
      }
      apply(scaleRef.current, { x: drag.current.origin.x + dx, y: drag.current.origin.y + dy });
    }
  };

  const endPointer = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) {
      pinch.current = null;
      setPinching(false);
    }
    if (pointers.current.size === 0) {
      drag.current = null;
      setDragging(false);
      return;
    }
    // 两只手松掉一只：用剩下的那只接着拖
    const [left] = [...pointers.current.values()];
    if (scaleRef.current > 1 && left) {
      drag.current = { start: { ...left }, origin: offsetRef.current, moved: movedRef.current };
      setDragging(true);
    }
  };

  /** 双击 / 双触：放大到 2.5 倍，已经放大了就归位 */
  const onDoubleTap = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (scaleRef.current > 1.2) reset();
    else zoomAt(2.5, e.clientX, e.clientY);
  };

  // 触屏没有 dblclick，自己判：两次点击间隔 < 300ms 且位置接近
  const onStageClick = (e: React.MouseEvent) => {
    const now = Date.now();
    const p = { x: e.clientX, y: e.clientY };
    const prev = lastTap.current;
    lastTap.current = { t: now, p };

    const isDouble = prev && now - prev.t < 300 && distance(prev.p, p) < 24;
    if (isDouble) {
      lastTap.current = null;
      onDoubleTap(e);
      return;
    }

    // 拖动过就不当点击
    if (movedRef.current) return;

    // 点在图片范围内：不关（而且双击能放大）
    const img = imgRef.current;
    if (img) {
      const r = img.getBoundingClientRect();
      if (p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom) return;
    }

    onClose();
  };

  const atDefault = scale <= 1.001;

  return (
    <div
      ref={stageRef}
      className="fixed inset-0 z-[60] flex items-center justify-center overflow-hidden bg-black/92 backdrop-blur-sm"
      style={{ touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onClick={onStageClick}
      role="dialog"
      aria-modal="true"
      aria-label="查看图片"
    >
      <img
        ref={imgRef}
        src={assetUrl(src)}
        alt={alt || '图片'}
        draggable={false}
        className="max-h-full max-w-full select-none object-contain shadow-2xl"
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          transition: dragging || pinching ? 'none' : 'transform 120ms ease-out',
          cursor: atDefault ? 'zoom-in' : dragging ? 'grabbing' : 'grab',
        }}
      />

      <p className="pointer-events-none absolute left-4 top-4 rounded-full bg-black/35 px-2.5 py-1 text-[10.5px] text-white/60">
        滚轮或双指缩放 · 拖动查看 · 双击放大
      </p>

      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white/90 transition hover:bg-white/20"
        aria-label="关闭"
      >
        <IconClose size={20} />
      </button>

      {/* 缩放条 */}
      <div
        className="absolute bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-full bg-black/45 px-1.5 py-1 backdrop-blur"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={() => zoomBy(0.8)}
          disabled={atDefault}
          className="flex h-7 w-7 items-center justify-center rounded-full text-[15px] text-white/85 transition hover:bg-white/15 disabled:opacity-30"
          aria-label="缩小"
        >
          −
        </button>
        <span className="w-11 text-center text-[11px] tabular-nums text-white/80">
          {Math.round(scale * 100)}%
        </span>
        <button
          onClick={() => zoomBy(1.25)}
          disabled={scale >= MAX_SCALE - 0.01}
          className="flex h-7 w-7 items-center justify-center rounded-full text-[15px] text-white/85 transition hover:bg-white/15 disabled:opacity-30"
          aria-label="放大"
        >
          +
        </button>
        <span className="mx-0.5 h-4 w-px bg-white/15" />
        <button
          onClick={reset}
          disabled={atDefault}
          className="rounded-full px-2 py-1 text-[11px] text-white/80 transition hover:bg-white/15 disabled:opacity-30"
        >
          还原
        </button>
      </div>

      <a
        href={assetUrl(src)}
        download
        onClick={(e) => e.stopPropagation()}
        className="absolute bottom-5 right-4 flex items-center gap-1.5 rounded-full bg-black/45 px-3 py-1.5 text-[11.5px] text-white/85 backdrop-blur transition hover:bg-white/15"
      >
        <IconDownload size={14} />
        存下来
      </a>
    </div>
  );
}
