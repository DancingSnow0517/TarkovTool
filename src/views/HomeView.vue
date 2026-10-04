<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { NButton, NIcon, NSpin, useNotification } from "naive-ui";
import { NotificationsOffOutlined, NotificationsOutlined } from "@vicons/material";
import { fetchCached, fetchJson } from "@/api/client";
import type { Trader, TranslationMap } from "@/api/types";
import { useConfigStore } from "@/stores/config";
import { translate } from "@/utils/deals";

interface JsonData<T> {
  data: T;
}

interface HomeTrader {
  id: string;
  name: string;
  image: string;
  /** 下次补货时间戳（ms），到期后重新拉取 */
  resetAt: number;
  /** resetAt 为按补货周期估算的值（源站数据过期时的补偿） */
  estimated: boolean;
}

const config = useConfigStore();

const now = ref(Date.now());
const loading = ref(true);
const traders = ref<HomeTrader[]>([]);
const traderTr = ref<TranslationMap>({});
/** 原始补货时间（id -> ISO），重新拉取后覆盖，名字翻译变化时复用 */
const rawTraders = ref<Record<string, Trader>>({});

/** 塔科夫时间流速为现实 7 倍，00:00 对应 unix 3 小时（UTC+3）；左右两侧相差 12 小时 */
function tarkovTime(left: boolean): string {
  const oneDay = 24 * 3600 * 1000;
  const offset = 3 * 3600 * 1000 + (left ? 0 : 12 * 3600 * 1000);
  const t = (offset + now.value * 7) % oneDay;
  const h = Math.floor(t / 3600000);
  const m = Math.floor((t % 3600000) / 60000);
  const s = Math.floor((t % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const timeLeft = computed(() => tarkovTime(true));
const timeRight = computed(() => tarkovTime(false));

/** 剩余补货时间（ms），<=0 表示数据已过期，等待重新拉取 */
function remainMs(resetAt: number): number {
  return Math.max(0, resetAt - now.value);
}

function fmtCountdown(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** 游戏内商人顺序（normalizedName），其余商人（黑商/灯塔商人等）不显示 */
const TRADER_ORDER = [
  "prapor",
  "therapist",
  "skier",
  "peacekeeper",
  "mechanic",
  "ragman",
  "jaeger",
  "ref",
];

/**
 * 各商人补货周期（ms），从 resetTime 的滚动更新中学习得到并持久化。
 * 源站文件生成有延迟（实测约 20-30 分钟），resetTime 过期但尚未更新时按周期向后推算。
 */
const INTERVALS_KEY = "tarkov-tool-trader-intervals";
const restockIntervals = new Map<string, number>(
  JSON.parse(localStorage.getItem(INTERVALS_KEY) ?? "[]") as [string, number][],
);

function learnIntervals(fresh: Record<string, Trader>) {
  let changed = false;
  for (const t of Object.values(fresh)) {
    if (!t.id || !t.resetTime) continue;
    const prev = rawTraders.value[t.id]?.resetTime;
    if (!prev || prev === t.resetTime) continue;
    const iv = Date.parse(t.resetTime) - Date.parse(prev);
    // 只接受合理周期（1 分钟 ~ 12 小时），防止源站数据跳变污染
    if (iv > 60_000 && iv < 12 * 3600_000) {
      restockIntervals.set(t.id, iv);
      changed = true;
    }
  }
  if (changed) {
    localStorage.setItem(INTERVALS_KEY, JSON.stringify([...restockIntervals]));
  }
}

function rebuild() {
  const byName = new Map<string, HomeTrader>();
  for (const t of Object.values(rawTraders.value)) {
    if (!t.id || !t.resetTime || !t.normalizedName) continue;
    let resetAt = Date.parse(t.resetTime);
    let estimated = false;
    const iv = restockIntervals.get(t.id);
    if (iv && resetAt <= Date.now()) {
      // 源站数据已过期：按已知补货周期向后推算到未来
      resetAt += Math.ceil((Date.now() - resetAt) / iv) * iv;
      estimated = true;
    }
    byName.set(t.normalizedName, {
      id: t.id,
      name: translate(t.name ?? t.id, traderTr.value),
      image: t.imageLink ?? "",
      resetAt,
      estimated,
    });
  }
  traders.value = TRADER_ORDER.flatMap((key) => {
    const t = byName.get(key);
    return t ? [t] : [];
  });
}

async function loadTraders() {
  // 随机参数绕开 Cloudflare 边缘缓存（部分文件有 8 天 CDN 缓存，no-cache 的 304 拿到的仍是陈旧内容）
  const fresh = (
    await fetchJson<JsonData<Record<string, Trader>>>(
      `/${config.mode}/traders?_=${Date.now()}`,
      { cache: "no-cache" },
    )
  ).data;
  learnIntervals(fresh);
  rawTraders.value = fresh;
  rebuild();
}

async function loadNames() {
  traderTr.value = (
    await fetchCached<JsonData<TranslationMap>>(`/${config.mode}/traders_${config.lang}`)
  ).data;
  rebuild();
}

let refreshing = false;
let lastRefreshAt = 0;
/**
 * 补货数据补偿机制：初始化失败 / 列表为空 / 有倒计时到期 都会触发重拉（15 秒节流）。
 * 拉取失败只记日志并等下一轮重试，界面保持加载态。
 */
async function refreshIfExpired() {
  if (refreshing) return;
  const need =
    loading.value || !traders.value.length || traders.value.some((t) => t.resetAt <= now.value);
  if (!need) return;
  if (now.value - lastRefreshAt < 15_000) return;
  refreshing = true;
  lastRefreshAt = now.value;
  try {
    if (loading.value) {
      await Promise.all([loadTraders(), loadNames()]);
      loading.value = false;
    } else {
      await loadTraders();
    }
  } catch (e) {
    console.error("拉取商人补货时间失败，15 秒后重试", e);
  } finally {
    refreshing = false;
  }
}

const notification = useNotification();

/** 补货通知开关（仅页面打开期间有效，不做持久化） */
const notifyOn = ref(false);
/** 已通知过的 resetAt（按商人 id），防止同一补货时间重复通知 */
const notified = new Map<string, number>();

function toggleNotify() {
  if (notifyOn.value) {
    notifyOn.value = false;
    return;
  }
  // 不等待授权结果（用户可能不处理系统弹窗），页内通知立即可用；系统通知在授权后自动生效
  if ("Notification" in window && Notification.permission === "default") {
    void Notification.requestPermission()
      .then((perm) => {
        // Edge/Chrome 的安静通知策略会把授权弹窗降级为地址栏铃铛，dismiss 后结果仍是 default，此时页内提示用户手动允许
        if (perm === "default") {
          notification.info({
            title: "系统通知未授权",
            content: "浏览器已静默拦截授权请求，可点击地址栏右侧的铃铛图标选择「允许接收通知」；页内通知不受影响。",
            duration: 10000,
          });
        }
      })
      .catch(() => "denied" as const);
  }
  // 已过期（等待重拉）的倒计时直接标记为已通知，避免开启瞬间补发旧通知
  for (const t of traders.value) {
    if (t.resetAt <= now.value) notified.set(t.id, t.resetAt);
  }
  notifyOn.value = true;
}

/** 补货时间到：页内右下角 + 系统通知（已授权时） */
function fireRestock(t: HomeTrader) {
  notification.success({
    title: "商人补货",
    content: `${t.name} 已补货`,
    duration: 8000,
  });
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification("商人补货", { body: `${t.name} 已补货`, icon: t.image });
  }
}

function checkRestock() {
  if (!notifyOn.value) return;
  for (const t of traders.value) {
    if (t.resetAt <= now.value && notified.get(t.id) !== t.resetAt) {
      notified.set(t.id, t.resetAt);
      fireRestock(t);
    }
  }
}

/** 塔科夫时间 7 倍速，游戏内 1 秒约等于现实 143ms，用 100ms 刷新保证秒数跳动平滑 */
const timer = window.setInterval(() => {
  now.value = Date.now();
  checkRestock();
  void refreshIfExpired();
}, 100);

onMounted(() => {
  void refreshIfExpired();
});

watch(
  () => config.mode,
  () => {
    loading.value = true;
    traders.value = [];
    lastRefreshAt = 0;
    void refreshIfExpired();
  },
);
watch(
  () => config.lang,
  () => {
    void loadNames().catch((e) => console.error("拉取商人译名失败", e));
  },
);

onBeforeUnmount(() => window.clearInterval(timer));
</script>

<template>
  <div class="home">
    <section class="game-time">
      <div class="clock-card">
        <span class="clock-value">{{ timeLeft }}</span>
        <span class="clock-sep">/</span>
        <span class="clock-value">{{ timeRight }}</span>
      </div>
    </section>

    <section class="restock">
      <div class="restock-card">
        <h2 class="restock-title">商人补货</h2>
        <NButton
          class="notify-btn"
          quaternary
          circle
          :title="notifyOn ? '关闭补货通知' : '开启补货通知'"
          @click="toggleNotify"
        >
          <template #icon>
            <NIcon :size="20" :color="notifyOn ? config.primaryColor : undefined">
              <NotificationsOutlined v-if="notifyOn" />
              <NotificationsOffOutlined v-else />
            </NIcon>
          </template>
        </NButton>
        <div v-if="loading" class="restock-loading"><NSpin size="large" /></div>
        <div v-else class="trader-grid">
          <div v-for="t in traders" :key="t.id" class="trader-card">
            <div class="trader-name">{{ t.name }}</div>
            <img class="trader-avatar" :src="t.image" :alt="t.name" loading="lazy" />
            <div class="trader-countdown" :title="t.estimated ? '源站数据延迟，按补货周期估算' : undefined">
              <NSpin v-if="remainMs(t.resetAt) === 0" :size="14" />
              <template v-else>{{ t.estimated ? "≈ " : "" }}{{ fmtCountdown(remainMs(t.resetAt)) }}</template>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 24px;
  padding-top: 48px;
}

@media (max-width: 768px) {
  .home {
    padding-top: 16px;
  }
}

.game-time {
  width: min(1068px, 100%);
}

.clock-card {
  padding: 32px 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--card-bg-subtle);
  text-align: center;
}

.clock-value {
  font-size: clamp(34px, 8vw, 72px);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: 2px;
  line-height: 1.1;
}

.clock-sep {
  margin: 0 12px;
  font-size: clamp(28px, 6vw, 56px);
  color: var(--text-dim);
}

.restock {
  width: min(1068px, 100%);
}

.restock-card {
  position: relative;
  padding: 24px 24px 32px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--card-bg-subtle);
}

.restock-title {
  margin: 0 0 20px;
  text-align: center;
  font-size: 18px;
  color: var(--text-dim);
}

.notify-btn {
  position: absolute;
  top: 12px;
  right: 12px;
}

.restock-loading {
  display: flex;
  justify-content: center;
  padding: 48px 0;
}

.trader-grid {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 20px;
}

.trader-card {
  width: 108px;
  text-align: center;
}

.trader-avatar {
  width: 96px;
  height: 96px;
  border-radius: 6px;
  background: var(--card-bg-subtle);
}

.trader-name {
  margin-bottom: 8px;
  font-size: 16px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trader-countdown {
  margin-top: 6px;
  font-size: 15px;
  font-variant-numeric: tabular-nums;
  color: var(--accent);
}

@media (max-width: 640px) {
  .trader-grid {
    gap: 12px;
  }

  .trader-card {
    width: 84px;
  }

  .trader-avatar {
    width: 72px;
    height: 72px;
  }
}
</style>
