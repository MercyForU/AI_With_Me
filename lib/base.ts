/**
 * 运行环境判断。
 *
 * 两种形态：
 * - 浏览器（电脑上跑 server.js）：数据走 /api/*，相对路径即可。
 * - APK（Capacitor）：数据在设备本地 SQLite，走 lib/local/server.ts，不发网络请求。
 *
 * assetUrl 现在只是原样返回：手机版的图片是 data URL 或包内资源路径，电脑版是同源路径。
 * 留这个函数是为了将来若要支持「手机连电脑」时，只改这一处就能加上 base。
 */

export function isNativeApp(): boolean {
  if (typeof window === 'undefined') return false;
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return Boolean(cap?.isNativePlatform?.());
}

export function assetUrl(path?: string | null): string {
  return path || '';
}
