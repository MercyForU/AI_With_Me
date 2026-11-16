import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '暧 · AI 陪伴',
  description: '角色真正属于你的 AI 陪伴平台：人格、记忆、聊天记录都能带走。',
  applicationName: '暧',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  themeColor: '#08080d',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-full antialiased">
        <script
          // 在首屏绘制前决定主题，避免深色→浅色闪一下
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var m=localStorage.getItem('nuan-theme')||'system';var d=m==='system'?(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):m;document.documentElement.dataset.theme=d;}catch(e){document.documentElement.dataset.theme='dark';}})();",
          }}
        />
        {children}
      </body>
    </html>
  );
}
