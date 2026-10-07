import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "/",
  plugins: [
    vue(),
    VitePWA({
      registerType: "prompt",
      injectRegister: false, // 在 main.ts 手动注册，便于弹新版本提示
      manifest: false, // 复用 public/manifest.webmanifest
      workbox: {
        // 应用外壳 precache；地图瓦片/楼层图（500MB+）只走运行时缓存
        globPatterns: ["**/*.{js,css,html,png,webmanifest}", "maps.json"],
        globIgnores: ["assets/maps/**"],
        navigateFallback: "index.html",
        runtimeCaching: [
          {
            urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith("/assets/maps/"),
            handler: "CacheFirst",
            options: {
              cacheName: "map-assets",
              expiration: { maxEntries: 2000, maxAgeSeconds: 30 * 24 * 3600 },
            },
          },
          {
            // assets.tarkov.dev 无 CORS 头，需 no-cors 拉取并允许缓存 opaque 响应
            urlPattern: /^https:\/\/assets\.tarkov\.dev\//,
            handler: "CacheFirst",
            options: {
              cacheName: "tarkov-assets",
              fetchOptions: { mode: "no-cors" },
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxEntries: 5000, maxAgeSeconds: 30 * 24 * 3600 },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    chunkSizeWarningLimit: 1500,
  },
});
