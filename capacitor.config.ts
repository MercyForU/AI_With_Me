import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Android 壳的配置。
 *
 * webDir 指向 Next 的静态导出产物：APK 自带一份前端，启动不依赖电脑。
 * 数据仍在本机服务器上，所以 API 地址在 App 里运行时配置（见 lib/base.ts）。
 */
const config: CapacitorConfig = {
  appId: 'com.nuan.companion',
  appName: '暧',
  webDir: 'out',
  android: {
    allowMixedContent: true, // 局域网是 http 明文
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
