import { computed, createApp, h } from "vue";
import { createPinia } from "pinia";
import { createDiscreteApi, darkTheme, NButton } from "naive-ui";
import { registerSW } from "virtual:pwa-register";
import App from "@/App.vue";
import { router } from "@/router";
import { useConfigStore } from "@/stores/config";
import { dropLegacyCache } from "@/api/client";

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);
app.use(router);

// 静态数据缓存已迁移到 Cache Storage，清理旧版 localStorage 缓存键
dropLegacyCache();

// 配置变化即持久化到 localStorage（替代 CLI 的 config.json）
const config = useConfigStore(pinia);
config.$subscribe(() => config.persist());

// PWA：注册 Service Worker；新版本就绪时弹通知，点击按钮刷新应用更新
const { notification } = createDiscreteApi(["notification"], {
  configProviderProps: computed(() => ({ theme: config.theme === "dark" ? darkTheme : null })),
});
const updateSW = registerSW({
  onNeedRefresh() {
    notification.create({
      title: "发现新版本",
      content: "更新已就绪，点击下方按钮刷新页面应用。",
      duration: 0,
      action: () =>
        h(
          NButton,
          { size: "small", type: "primary", onClick: () => updateSW(true) },
          { default: () => "刷新" },
        ),
    });
  },
  onOfflineReady() {
    console.info("应用外壳已缓存，可离线访问");
  },
});

app.mount("#app");
