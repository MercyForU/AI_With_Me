/** @type {import('next').NextConfig} */
const nextConfig = {
  // 纯前端应用：静态导出，可直接托管到任意 CDN / 静态站点
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
};

export default nextConfig;
