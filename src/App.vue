<script setup lang="ts">
import { computed, h, onMounted, ref, watch } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";
import { DarkModeOutlined, LightModeOutlined, MenuOutlined, SettingsOutlined } from "@vicons/material";
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
  NPopover,
  NSelect,
  NSpace,
  NSwitch,
  NTooltip,
  zhCN,
  type GlobalThemeOverrides,
  type MenuOption,
} from "naive-ui";
import type { MapData } from "@/api/types";
import { DEFAULT_PRIMARY, GAME_MODES, LANGUAGES, useConfigStore } from "@/stores/config";
import { useDataStore } from "@/stores/data";
import { useTrackStore } from "@/stores/track";
import { useRaidLogStore } from "@/stores/raidLog";
import { loadDirHandle } from "@/utils/fs-watch";
import { useNarrow } from "@/utils/breakpoint";
import { primaryVariants } from "@/utils/color";

const route = useRoute();
const config = useConfigStore();
const data = useDataStore();
const track = useTrackStore();
const raid = useRaidLogStore();
const narrow = useNarrow();

const settings = ref(false);
const drawer = ref(false);
const trackErr = ref("");
const raidErr = ref("");

/** 选择/重新选择截图目录并开始监听（点击即用户手势，可弹授权） */
async function selectTrackDir(forcePicker = false) {
  trackErr.value = "";
  const err = await track.enable(forcePicker);
  if (err) {
    trackErr.value = err;
    return;
  }
  config.trackIntent = true;
  config.persist();
}

function stopTrack() {
  track.disable();
  config.trackIntent = false;
  config.persist();
}

/** 选择/重新选择 Logs 目录并开始监听 */
async function selectRaidDir(forcePicker = false) {
  raidErr.value = "";
  const err = await raid.enable(forcePicker);
  if (err) {
    raidErr.value = err;
    return;
  }
  config.raidLogIntent = true;
  config.persist();
}

function stopRaid() {
  raid.disable();
  config.raidLogIntent = false;
  config.persist();
}

function onAutoMapLog(v: boolean) {
  config.autoMapLog = v;
  config.persist();
}

function onAutoMapScreenshot(v: boolean) {
  config.autoMapScreenshot = v;
  config.persist();
}

function onFollowScreenshot(v: boolean) {
  config.followScreenshot = v;
  config.persist();
}

/** 页面加载时静默恢复监听：同一会话内刷新页面授权仍有效（无需手势）；
 * 浏览器重启后权限失效，需在设置里重新选择目录 */
async function resumeWatching() {
  if (config.trackIntent && !track.enabled) {
    try {
      const h = await loadDirHandle("screenshotDir");
      if (h && (await h.queryPermission({ mode: "read" })) === "granted") await track.startWatching(h);
    } catch (e) {
      console.warn("恢复截图监听失败:", e);
    }
  }
  if (config.raidLogIntent && !raid.enabled) {
    try {
      const h = await loadDirHandle("eftLogsDir");
      if (h && (await h.queryPermission({ mode: "read" })) === "granted") await raid.startWatching(h);
    } catch (e) {
      console.warn("恢复日志监听失败:", e);
    }
  }
}
void resumeWatching();

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

function toggleTheme() {
  config.theme = config.theme === "dark" ? "light" : "dark";
}

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
              <div class="header-row">
                <div class="header-left">
                  <NButton v-if="narrow" quaternary circle title="菜单" @click="drawer = true">
                    <template #icon>
                      <NIcon :size="22"><MenuOutlined /></NIcon>
                    </template>
                  </NButton>
                  <RouterLink to="/" class="brand" title="Tarkov 工具箱">
                    <img src="/icons/pwa-192.png" alt="Tarkov 工具箱" class="brand-icon" />
                    <span class="brand-name">Tarkov 工具箱</span>
                  </RouterLink>
                  <NMenu v-if="!narrow" :value="menuValue" mode="horizontal" :options="menuOptions" />
                </div>
                <NSpace align="center" :size="4" :wrap="false">
                  <NPopover trigger="click" placement="bottom" :show-arrow="false">
                    <template #trigger>
                      <NButton quaternary circle title="主题色">
                        <span class="color-dot" :style="{ background: config.primaryColor }"></span>
                      </NButton>
                    </template>
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
                  </NPopover>
                  <NButton
                    quaternary
                    circle
                    :title="config.theme === 'dark' ? '切换到亮色' : '切换到暗色'"
                    @click="toggleTheme"
                  >
                    <template #icon>
                      <NIcon :size="20">
                        <LightModeOutlined v-if="config.theme === 'dark'" />
                        <DarkModeOutlined v-else />
                      </NIcon>
                    </template>
                  </NButton>
                  <NButton quaternary circle title="设置" @click="settings = true">
                    <template #icon>
                      <NIcon :size="20"><SettingsOutlined /></NIcon>
                    </template>
                  </NButton>
                </NSpace>
              </div>
            </div>
          </header>
          <main class="app-main" :class="{ 'map-mode': route.name === 'map' }">
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
            <span>截图目录</span>
            <div class="settings-actions">
              <span v-if="track.enabled" class="hint-ok">监听中：{{ track.dirName }}</span>
              <NButton size="small" @click="selectTrackDir(track.enabled)">
                {{ track.enabled ? "重新选择" : "选择文件夹" }}
              </NButton>
              <NButton v-if="track.enabled" size="small" @click="stopTrack">停止</NButton>
            </div>
          </div>
          <div class="settings-hint">
            监听后，游戏内截图会自动在地图页标记玩家位置与朝向（仅 Chrome / Edge）。
            截图目录默认为「文档\Escape from Tarkov\Screenshots」，可在 启动器 → 设置 → 截图 中确认。
            <div v-if="trackErr" class="hint-err">{{ trackErr }}</div>
          </div>
          <div class="settings-row">
            <span>Logs 目录</span>
            <div class="settings-actions">
              <span v-if="raid.enabled" class="hint-ok">监听中：{{ raid.dirName }}</span>
              <NButton size="small" @click="selectRaidDir(raid.enabled)">
                {{ raid.enabled ? "重新选择" : "选择文件夹" }}
              </NButton>
              <NButton v-if="raid.enabled" size="small" @click="stopRaid">停止</NButton>
            </div>
          </div>
          <div class="settings-hint">
            监听后，可从日志检测进入战局的地图（线上 / PVE / 训练均支持）。
            Logs 目录在 启动器 → 设置 → 日志 查看，形如 D:\Games\Escape from Tarkov\Logs。
            <div v-if="raidErr" class="hint-err">{{ raidErr }}</div>
          </div>
          <div class="settings-row">
            <span>进战局自动切图</span>
            <NTooltip trigger="hover" :disabled="raid.enabled">
              <template #trigger>
                <span class="switch-wrap" :class="{ off: !raid.enabled }">
                  <NSwitch
                    :value="config.autoMapLog"
                    :disabled="!raid.enabled"
                    @update:value="onAutoMapLog"
                  />
                </span>
              </template>
              需要先选择 Logs 目录开始监听
            </NTooltip>
          </div>
          <div class="settings-hint">
            检测到进入战局时自动把地图页切到对应地图；只在新进战局时切换，不干扰手动切图。
          </div>
          <div class="settings-row">
            <span>截图跟随切图</span>
            <NTooltip trigger="hover" :disabled="track.enabled">
              <template #trigger>
                <span class="switch-wrap" :class="{ off: !track.enabled }">
                  <NSwitch
                    :value="config.autoMapScreenshot"
                    :disabled="!track.enabled"
                    @update:value="onAutoMapScreenshot"
                  />
                </span>
              </template>
              需要先选择截图目录开始监听
            </NTooltip>
          </div>
          <div class="settings-hint">截图位置落在其他地图时自动切换过去；关闭时仅提示。</div>
          <div class="settings-row">
            <span>截图视角跟随</span>
            <NTooltip trigger="hover" :disabled="track.enabled">
              <template #trigger>
                <span class="switch-wrap" :class="{ off: !track.enabled }">
                  <NSwitch
                    :value="config.followScreenshot"
                    :disabled="!track.enabled"
                    @update:value="onFollowScreenshot"
                  />
                </span>
              </template>
              需要先选择截图目录开始监听
            </NTooltip>
          </div>
          <div class="settings-hint">新截图时视角自动居中到玩家位置，缩放为 4 倍左右。</div>
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

/* 地图页全屏：不受居中宽度与内边距限制 */
.app-main.map-mode {
  padding: 0;
  overflow: hidden;
}

.app-main.map-mode .main-inner {
  max-width: none;
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

.settings-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  text-decoration: none;
  color: inherit;
  flex-shrink: 0;
}

.brand-icon {
  width: 28px;
  height: 28px;
  border-radius: 7px;
}

.brand-name {
  font-size: 16px;
  font-weight: 600;
  white-space: nowrap;
}

.settings-row:last-child {
  margin-bottom: 0;
}

.settings-hint {
  margin: -8px 0 14px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text);
  opacity: 0.65;
}

.settings-hint .hint-ok {
  opacity: 1;
  color: var(--accent);
}

.settings-hint .hint-err {
  opacity: 1;
  color: #d03050;
}

.settings-hint .hint-link {
  cursor: pointer;
  text-decoration: underline;
  color: var(--accent);
}

.switch-wrap {
  display: inline-flex;
}

.switch-wrap.off {
  cursor: not-allowed;
}

.color-presets {
  display: flex;
  gap: 8px;
}

/* 头部主题色按钮里的当前色圆点 */
.color-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  display: inline-block;
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
