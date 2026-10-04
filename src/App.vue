<script setup lang="ts">
import { computed, h, onMounted, ref, watch } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";
import { MenuOutlined, SettingsOutlined } from "@vicons/material";
import {
  darkTheme,
  dateZhCN,
  NButton,
  NConfigProvider,
  NDrawer,
  NDrawerContent,
  NIcon,
  NMenu,
  NMessageProvider,
  NModal,
  NNotificationProvider,
  NSelect,
  NSpace,
  zhCN,
  type GlobalThemeOverrides,
  type MenuOption,
} from "naive-ui";
import type { MapData } from "@/api/types";
import { DEFAULT_PRIMARY, GAME_MODES, LANGUAGES, useConfigStore } from "@/stores/config";
import { useDataStore } from "@/stores/data";
import { useNarrow } from "@/utils/breakpoint";
import { primaryVariants } from "@/utils/color";

const route = useRoute();
const config = useConfigStore();
const data = useDataStore();
const narrow = useNarrow();

const settings = ref(false);
const drawer = ref(false);

/** 主题类与主题色 CSS 变量挂到 documentElement，全局样式和 naive-ui 主题都由此驱动 */
watch(
  () => config.theme,
  (theme) => {
    document.documentElement.classList.toggle("theme-light", theme === "light");
    document.documentElement.classList.toggle("theme-dark", theme === "dark");
  },
  { immediate: true },
);
watch(
  () => config.primaryColor,
  (color) => document.documentElement.style.setProperty("--accent", color),
  { immediate: true },
);

const naiveTheme = computed(() => (config.theme === "dark" ? darkTheme : null));
const themeOverrides = computed<GlobalThemeOverrides>(() => ({
  common: primaryVariants(config.primaryColor),
}));

/** 预设主题色 */
const PRIMARY_PRESETS = [
  { label: "绿", value: DEFAULT_PRIMARY },
  { label: "橙", value: "#f0a020" },
  { label: "蓝", value: "#2080f0" },
  { label: "紫", value: "#8b5cf6" },
  { label: "红", value: "#d03050" },
  { label: "青", value: "#14b8a6" },
];

const themeOptions = [
  { label: "暗色", value: "dark" },
  { label: "亮色", value: "light" },
];

/** 地图菜单数据：maps.json 的地图列表 + 按当前模式/语言的本地化名称 */
const maps = ref<MapData[]>([]);
const mapNames = ref<Record<string, string>>({});

onMounted(async () => {
  maps.value = (await (await fetch(import.meta.env.BASE_URL + "maps.json")).json()) as MapData[];
});

watch(
  () => [config.mode, config.lang, maps.value.length],
  async () => {
    if (!maps.value.length) return;
    const byApiId = await data.loadMapNames(config.mode, config.lang);
    const names: Record<string, string> = {};
    for (const m of maps.value) names[m.key] = byApiId[m.apiIds[0]] ?? m.key;
    mapNames.value = names;
  },
  { immediate: true },
);

const menuOptions = computed<MenuOption[]>(() => [
  { label: () => h(RouterLink, { to: "/" }, () => "首页"), key: "home" },
  { label: () => h(RouterLink, { to: "/deals" }, () => "套利表"), key: "arbitrage" },
  { label: () => h(RouterLink, { to: "/items" }, () => "物品列表"), key: "items" },
  { label: () => h(RouterLink, { to: "/tasks" }, () => "任务列表"), key: "tasks" },
  {
    label: "地图",
    key: "map",
    children: maps.value.map((m) => ({
      label: () =>
        h(RouterLink, { to: { name: "map", query: { map: m.key } } }, () => mapNames.value[m.key] ?? m.key),
      key: `map:${m.key}`,
    })),
  },
]);

/** 地图页时高亮当前地图的子菜单项（默认 customs） */
const menuValue = computed(() => {
  if (route.name !== "map") return route.name as string;
  const raw = Array.isArray(route.query.map) ? route.query.map[0] : route.query.map;
  return `map:${raw ?? "customs"}`;
});

const modeOptions = GAME_MODES.map((m) => ({ label: m.label, value: m.value }));
const langOptions = LANGUAGES.map((l) => ({ label: l, value: l }));
</script>

<template>
  <NConfigProvider :theme="naiveTheme" :theme-overrides="themeOverrides" :locale="zhCN" :date-locale="dateZhCN">
    <NMessageProvider>
      <NNotificationProvider>
        <div class="app-shell">
          <header class="app-header">
            <div class="header-inner">
              <NSpace align="center" justify="space-between" :wrap="false">
                <NButton v-if="narrow" quaternary circle title="菜单" @click="drawer = true">
                  <template #icon>
                    <NIcon :size="22"><MenuOutlined /></NIcon>
                  </template>
                </NButton>
                <NMenu v-else :value="menuValue" mode="horizontal" :options="menuOptions" />
                <NButton quaternary circle title="设置" @click="settings = true">
                  <template #icon>
                    <NIcon :size="20"><SettingsOutlined /></NIcon>
                  </template>
                </NButton>
              </NSpace>
            </div>
          </header>
          <main class="app-main">
            <div class="main-inner">
              <RouterView />
            </div>
          </main>
        </div>
        <NDrawer v-model:show="drawer" placement="left" :width="240">
          <NDrawerContent body-content-style="padding: 8px 0">
            <NMenu :value="menuValue" :options="menuOptions" @update:value="drawer = false" />
          </NDrawerContent>
        </NDrawer>
        <NModal v-model:show="settings" preset="card" title="设置" style="width: min(420px, 92vw)">
          <div class="settings-row">
            <span>游戏模式</span>
            <NSelect v-model:value="config.mode" :options="modeOptions" style="width: 230px" />
          </div>
          <div class="settings-row">
            <span>语言</span>
            <NSelect v-model:value="config.lang" :options="langOptions" style="width: 230px" />
          </div>
          <div class="settings-row">
            <span>主题</span>
            <NSelect v-model:value="config.theme" :options="themeOptions" style="width: 230px" />
          </div>
          <div class="settings-row">
            <span>主题色</span>
            <div class="color-presets">
              <button
                v-for="c in PRIMARY_PRESETS"
                :key="c.value"
                class="color-swatch"
                :class="{ active: config.primaryColor === c.value }"
                :style="{ background: c.value }"
                :title="c.label"
                @click="config.primaryColor = c.value"
              >{{ config.primaryColor === c.value ? "✓" : "" }}</button>
            </div>
          </div>
        </NModal>
      </NNotificationProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>

<style>
html,
body,
#app {
  margin: 0;
  height: 100%;
}

html.theme-dark {
  --bg: #101014;
  --bg-card: #1f1f23;
  --border: rgba(255, 255, 255, 0.09);
  --text: rgba(255, 255, 255, 0.82);
  --text-dim: #9d9d9d;
  --card-bg-subtle: rgba(255, 255, 255, 0.04);
}

html.theme-light {
  --bg: #f2f3f5;
  --bg-card: #ffffff;
  --border: rgba(0, 0, 0, 0.1);
  --text: rgba(0, 0, 0, 0.82);
  --text-dim: #6b6b6b;
  --card-bg-subtle: rgba(0, 0, 0, 0.03);
}

body {
  background: var(--bg);
  color: var(--text);
}

/* 细滚动条，与列表风格一致 */
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: rgba(128, 128, 128, 0.35);
  border-radius: 4px;
}

::-webkit-scrollbar-thumb:hover {
  background: rgba(128, 128, 128, 0.55);
}

* {
  scrollbar-width: thin;
  scrollbar-color: rgba(128, 128, 128, 0.35) transparent;
}

a {
  color: var(--accent);
  text-decoration: none;
}

a:hover {
  text-decoration: underline;
}

.app-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.app-header {
  flex: none;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
}

/* 宽屏下内容居中、左右留白；导航与正文同宽对齐 */
.header-inner,
.main-inner {
  max-width: 1200px;
  margin: 0 auto;
  width: 100%;
}

.app-main {
  flex: 1;
  min-height: 0;
  padding: 16px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  /* 卡片列表随页面整体滚动 */
  overflow-y: auto;
}

.main-inner {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

@media (max-width: 768px) {
  .app-header {
    padding: 6px 8px;
  }

  .app-main {
    padding: 8px;
  }
}

/* 卡片网格：列表页共用 */
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
}

@media (max-width: 640px) {
  .card-grid {
    grid-template-columns: 1fr;
  }
}

.item-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  cursor: pointer;
  transition: border-color 0.15s;
}

.item-card:hover {
  border-color: var(--accent);
}

.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

.settings-row:last-child {
  margin-bottom: 0;
}

.color-presets {
  display: flex;
  gap: 8px;
}

.color-swatch {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  color: #fff;
  font-size: 13px;
  line-height: 1;
  padding: 0;
}

.color-swatch.active {
  border-color: var(--text);
}
</style>
