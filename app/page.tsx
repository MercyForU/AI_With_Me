'use client';

import dynamic from 'next/dynamic';

// 云 SDK 依赖浏览器环境，整体延迟到客户端渲染
const App = dynamic(() => import('@/components/App'), {
  ssr: false,
  loading: () => (
    <div className="flex h-dvh items-center justify-center bg-ink">
      <div className="flex flex-col items-center gap-4">
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-line border-t-brand" />
        <p className="text-sm text-fg-dimmer">正在进入…</p>
      </div>
    </div>
  ),
});

export default function Page() {
  return <App />;
}
