import { createApp } from "vue";
import { createPinia } from "pinia";
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

app.mount("#app");
