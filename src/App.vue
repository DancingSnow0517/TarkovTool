<script setup lang="ts">
import { computed, h, onMounted, ref, watch } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";
import { SettingsOutlined } from "@vicons/material";
import {
  darkTheme,
  dateZhCN,
  NButton,
  NConfigProvider,
  NIcon,
  NMenu,
  NMessageProvider,
  NModal,
  NNotificationProvider,
  NSelect,
  NSpace,
  zhCN,
  type MenuOption,
} from "naive-ui";
import type { MapData } from "@/api/types";
import { GAME_MODES, LANGUAGES, useConfigStore } from "@/stores/config";
import { useDataStore } from "@/stores/data";

const route = useRoute();
const config = useConfigStore();
const data = useDataStore();

const settings = ref(false);

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
  <NConfigProvider :theme="darkTheme" :locale="zhCN" :date-locale="dateZhCN">
    <NMessageProvider>
      <NNotificationProvider>
        <div class="app-shell">
          <header class="app-header">
            <NSpace align="center" justify="space-between">
              <NMenu :value="menuValue" mode="horizontal" :options="menuOptions" />
              <NButton quaternary circle title="设置" @click="settings = true">
                <template #icon>
                  <NIcon :size="20"><SettingsOutlined /></NIcon>
                </template>
              </NButton>
            </NSpace>
          </header>
          <main class="app-main">
            <RouterView />
          </main>
        </div>
        <NModal v-model:show="settings" preset="card" title="设置" style="width: min(420px, 92vw)">
          <div class="settings-row">
            <span>游戏模式</span>
            <NSelect v-model:value="config.mode" :options="modeOptions" style="width: 230px" />
          </div>
          <div class="settings-row">
            <span>语言</span>
            <NSelect v-model:value="config.lang" :options="langOptions" style="width: 230px" />
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

body {
  background: #101014;
  color: rgba(255, 255, 255, 0.82);
}

/* 细滚动条，与表格风格一致 */
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.16);
  border-radius: 4px;
}

::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.3);
}

* {
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.16) transparent;
}

a {
  color: #63e2b7;
  text-decoration: none;
}

a:hover {
  text-decoration: underline;
}

.item-cell {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  vertical-align: middle;
}

.item-icon {
  height: 48px;
  width: auto;
  flex: none;
}

.item-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.app-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.app-header {
  flex: none;
  padding: 8px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.09);
}

.app-main {
  flex: 1;
  min-height: 0;
  padding: 16px;
  box-sizing: border-box;
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
</style>
