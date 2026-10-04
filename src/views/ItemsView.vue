<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { NButton, NInput, NModal, NSpace, NSpin, useMessage } from "naive-ui";
import ColumnsModal from "@/components/ColumnsModal.vue";
import LoadMore from "@/components/LoadMore.vue";
import { fetchJson } from "@/api/client";
import type { PricePoint } from "@/api/types";
import { useConfigStore } from "@/stores/config";
import { useDataStore, type MarketData, type TaskData } from "@/stores/data";
import {
  DEFAULT_ITEM_COLUMNS,
  ITEM_COLUMNS,
  makeItemRow,
  matchRow,
  sortItemRows,
  type ItemColumnKey,
  type ItemRow,
} from "@/utils/deals";
import { fmtPrice, fmtSignedPct } from "@/utils/format";
import { itemDetails, tasksNeedingItem, traderPrices } from "@/utils/item-detail";

const config = useConfigStore();
const data = useDataStore();
const message = useMessage();

const rows = ref<ItemRow[]>([]);
const query = ref("");
const loading = ref(false);
const showColumns = ref(false);
const marketData = ref<MarketData | null>(null);

const modal = ref(false);
const current = ref<ItemRow | null>(null);
const prices = ref<PricePoint[]>([]);
const pricesLoading = ref(false);
const pricesError = ref("");
const taskData = ref<TaskData | null>(null);

const canFlea = computed(() => !!current.value && !current.value.item.types?.includes("noFlea"));

const detailDesc = computed(() => {
  const d = current.value?.item.description;
  return d ? (marketData.value?.itemTr[d] ?? "") : "";
});

const detailTraders = computed(() =>
  current.value && marketData.value ? traderPrices(current.value.item, marketData.value) : [],
);

const detailEntries = computed(() =>
  current.value ? itemDetails(current.value.item, marketData.value ?? undefined) : [],
);

const needingTasks = computed(() =>
  current.value && taskData.value ? tasksNeedingItem(current.value.id, taskData.value) : [],
);

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return rows.value;
  return rows.value.filter((r) => matchRow(r, q));
});

/* ---- 无限滚动：滚动到底增量加载 ---- */

const PAGE_SIZE = 60;
const visibleCount = ref(PAGE_SIZE);
const visibleRows = computed(() => filtered.value.slice(0, visibleCount.value));
const hasMore = computed(() => visibleCount.value < filtered.value.length);

watch(query, () => {
  visibleCount.value = PAGE_SIZE;
});

function loadMore() {
  visibleCount.value += PAGE_SIZE;
}

/* ---- 卡片字段（沿用列设置的字段选择） ---- */

const activeKeys = computed<ItemColumnKey[]>(() => {
  const valid = new Set<string>(ITEM_COLUMNS.map((c) => c.key));
  return (config.columns ?? DEFAULT_ITEM_COLUMNS).filter((k): k is ItemColumnKey => valid.has(k));
});

const columnLabels = new Map<string, string>(ITEM_COLUMNS.map((c) => [c.key, c.label]));

function cellText(key: ItemColumnKey, row: ItemRow): string {
  switch (key) {
    case "flea":
    case "avg24h":
    case "low24h":
    case "high24h":
    case "base":
      return fmtPrice(row[key]);
    case "change48h":
      return row.change48h == null ? "-" : fmtSignedPct(row.change48h);
    case "offers":
      return row.offers == null ? "-" : String(row.offers);
    case "trader":
      return row.traderPrice != null ? `${fmtPrice(row.traderPrice)} (${row.trader})` : "-";
    case "flea_level":
      return row.fleaLevel ? `Lv.${row.fleaLevel}` : "-";
  }
}

function cellTone(key: ItemColumnKey, row: ItemRow): string {
  if (key !== "change48h" || row.change48h == null) return "";
  return row.change48h >= 0 ? "tone-up" : "tone-down";
}

function toggleFav(row: ItemRow) {
  config.toggleFavorite(row.id);
  sortItemRows(rows.value, config.favorites);
}

/* ---- 跳蚤价格历史走势（手绘 SVG，不引图表库） ---- */

const CHART_W = 640;
const CHART_H = 200;
/** 左侧留 Y 轴价格标签，底部留日期标签 */
const PAD = { l: 64, r: 12, t: 10, b: 24 };

type ChartRange = "7d" | "all";
const chartRange = ref<ChartRange>("7d");
const hoverIdx = ref<number | null>(null);

/** 默认只显示最近 7 天（以数据最后一点时间为锚），可切全部 */
const visiblePrices = computed(() => {
  const pts = prices.value;
  if (chartRange.value === "all" || pts.length < 2) return pts;
  const end = pts[pts.length - 1].timestamp;
  const cut = pts.filter((p) => p.timestamp >= end - 7 * 86400_000);
  return cut.length >= 2 ? cut : pts;
});

interface ChartPoint {
  x: number;
  y: number;
  ym: number;
  p: PricePoint;
}

interface ChartView {
  line: string;
  minLine: string;
  points: ChartPoint[];
  yTicks: { y: number; label: string }[];
  xTicks: { x: number; label: string; anchor: string }[];
}

const chart = computed<ChartView | null>(() => {
  const pts = visiblePrices.value;
  if (pts.length < 2) return null;
  const lo = Math.min(...pts.map((p) => p.priceMin));
  const hi = Math.max(...pts.map((p) => p.price));
  const span = hi - lo || 1;
  const x0 = pts[0].timestamp;
  const xSpan = pts[pts.length - 1].timestamp - x0 || 1;
  const px = (t: number) => PAD.l + ((t - x0) / xSpan) * (CHART_W - PAD.l - PAD.r);
  const py = (v: number) => CHART_H - PAD.b - ((v - lo) / span) * (CHART_H - PAD.t - PAD.b);
  const fmtDate = (t: number) => new Date(t).toLocaleDateString("zh-CN");
  const yTicks = [0, 1, 2, 3].map((i) => {
    const v = lo + (span * i) / 3;
    return { y: py(v), label: fmtPrice(Math.round(v)) };
  });
  const xIdx = [0, Math.floor((pts.length - 1) / 2), pts.length - 1];
  const anchors = ["start", "middle", "end"] as const;
  const xTicks = xIdx.map((i, k) => ({ x: px(pts[i].timestamp), label: fmtDate(pts[i].timestamp), anchor: anchors[k] }));
  const points: ChartPoint[] = pts.map((p) => ({ x: px(p.timestamp), y: py(p.price), ym: py(p.priceMin), p }));
  return {
    line: points.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" "),
    minLine: points.map((c) => `${c.x.toFixed(1)},${c.ym.toFixed(1)}`).join(" "),
    points,
    yTicks,
    xTicks,
  };
});

const hoverPoint = computed(() =>
  hoverIdx.value != null ? (chart.value?.points[hoverIdx.value] ?? null) : null,
);

/** 悬停提示显示到时分秒（坐标轴刻度保持年月日） */
const hoverDate = computed(() =>
  hoverPoint.value ? new Date(hoverPoint.value.p.timestamp).toLocaleString("zh-CN", { hour12: false }) : "",
);

/** 悬停提示框位置：跟随光标所在数据点，越界时收回图内 */
const tipStyle = computed(() => {
  if (!hoverPoint.value) return {};
  const leftPct = (hoverPoint.value.x / CHART_W) * 100;
  const topPct = (hoverPoint.value.y / CHART_H) * 100;
  return {
    left: `${Math.min(Math.max(leftPct, 12), 88)}%`,
    top: `${Math.max(topPct - 14, 2)}%`,
  };
});

function onChartMove(e: MouseEvent) {
  const pts = chart.value?.points;
  if (!pts?.length) return;
  const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * CHART_W;
  let best = 0;
  let bd = Infinity;
  pts.forEach((pt, i) => {
    const d = Math.abs(pt.x - x);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  hoverIdx.value = best;
}

/* ---- 点击卡片打开详情弹窗 ---- */

async function openItem(row: ItemRow) {
  current.value = row;
  modal.value = true;
  prices.value = [];
  pricesError.value = "";
  chartRange.value = "7d";
  hoverIdx.value = null;
  if (!row.item.types?.includes("noFlea")) {
    pricesLoading.value = true;
    try {
      const resp = await fetchJson<{ data: PricePoint[] }>(`/${config.mode}/prices/${row.id}`);
      prices.value = resp.data ?? [];
    } catch (e) {
      pricesError.value = `价格历史加载失败：${e instanceof Error ? e.message : String(e)}`;
    } finally {
      pricesLoading.value = false;
    }
  }
  if (!taskData.value) {
    try {
      taskData.value = await data.loadTaskData(config.mode, config.lang);
    } catch (e) {
      message.error(`加载任务数据失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function load(force = false) {
  loading.value = true;
  try {
    const m = await data.loadMarketData(config.mode, config.lang, force);
    marketData.value = m;
    const list = Object.values(m.items).map((item) => makeItemRow(item, m));
    sortItemRows(list, config.favorites);
    rows.value = list;
    visibleCount.value = PAGE_SIZE;
  } catch (e) {
    message.error(`加载市场数据失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    loading.value = false;
  }
}

onMounted(() => load());
watch(() => [config.mode, config.lang], () => load());
</script>

<template>
  <div class="view">
    <NSpace align="center">
      <NInput
        v-model:value="query"
        placeholder="搜索：中文 / 英文 / 拼音 / 首字母"
        clearable
        style="max-width: 280px"
      />
      <NButton @click="showColumns = true">字段设置</NButton>
      <NButton :loading="loading" @click="load(true)">刷新</NButton>
    </NSpace>
    <NSpin :show="loading">
      <div class="card-grid">
        <div v-for="row in visibleRows" :key="row.id" class="item-card goods-card" @click="openItem(row)">
          <img v-if="row.icon" :src="row.icon" :alt="row.name" class="goods-icon" loading="lazy" />
          <div class="goods-body">
            <div class="goods-title-row">
              <a
                class="goods-title"
                :href="row.link"
                target="_blank"
                rel="noopener noreferrer"
                @click.stop
              >{{ row.name }}</a>
              <span class="goods-fav" @click.stop="toggleFav(row)">{{ config.favorites.has(row.id) ? "★" : "☆" }}</span>
            </div>
            <div class="goods-fields">
              <template v-for="key in activeKeys" :key="key">
                <span class="field-label">{{ columnLabels.get(key) }}</span>
                <span class="field-value" :class="cellTone(key, row)">{{ cellText(key, row) }}</span>
              </template>
            </div>
          </div>
        </div>
      </div>
      <LoadMore :loading="loading" :has-more="hasMore" @load="loadMore" />
    </NSpin>
    <ColumnsModal v-model:show="showColumns" />
    <NModal v-model:show="modal" style="width: min(720px, 92vw)">
      <div v-if="current" class="item-modal">
        <button class="item-modal-close" title="关闭" @click="modal = false">✕</button>
        <div class="item-modal-head">
          <img
            v-if="current.icon"
            :src="current.icon"
            :alt="current.name"
            class="item-modal-img"
          />
          <div class="item-modal-head-text">
            <h2 class="item-modal-title">
              <a :href="current.link" target="_blank" rel="noopener noreferrer">{{ current.name }}</a>
            </h2>
            <p v-if="current.item.wikiLink" class="item-modal-meta">
              <a :href="current.item.wikiLink" target="_blank" rel="noopener noreferrer">Wiki</a>
            </p>
          </div>
        </div>
        <p v-if="detailDesc" class="item-modal-desc">{{ detailDesc }}</p>
        <template v-if="detailTraders.length">
          <h4>商人回收价</h4>
          <div class="trader-prices">
            <div v-for="t in detailTraders" :key="t.name" class="trader-price">
              <img v-if="t.avatar" :src="t.avatar" :alt="t.name" class="trader-avatar" loading="lazy" />
              <div class="trader-name">{{ t.name }}</div>
              <div class="trader-text">{{ t.text }}</div>
            </div>
          </div>
        </template>
        <h4>跳蚤价格走势</h4>
        <template v-if="canFlea">
          <NSpin :show="pricesLoading">
            <div class="chart-wrap">
              <div v-if="chart" class="chart-toolbar">
                <button
                  class="chart-range"
                  :class="{ active: chartRange === '7d' }"
                  @click="chartRange = '7d'"
                >最近7天</button>
                <button
                  class="chart-range"
                  :class="{ active: chartRange === 'all' }"
                  @click="chartRange = 'all'"
                >全部</button>
              </div>
              <div v-if="chart" class="chart-box">
                <svg
                  :viewBox="`0 0 ${CHART_W} ${CHART_H}`"
                  class="price-chart"
                  @mousemove="onChartMove"
                  @mouseleave="hoverIdx = null"
                >
                  <line
                    v-for="(t, i) in chart.yTicks"
                    :key="`g${i}`"
                    :x1="PAD.l"
                    :x2="CHART_W - PAD.r"
                    :y1="t.y"
                    :y2="t.y"
                    class="grid-line"
                  />
                  <text
                    v-for="(t, i) in chart.yTicks"
                    :key="`yl${i}`"
                    :x="PAD.l - 6"
                    :y="t.y + 4"
                    class="axis-label"
                    text-anchor="end"
                  >{{ t.label }}</text>
                  <text
                    v-for="(t, i) in chart.xTicks"
                    :key="`xl${i}`"
                    :x="t.x"
                    :y="CHART_H - 6"
                    class="axis-label"
                    :text-anchor="t.anchor"
                  >{{ t.label }}</text>
                  <polyline :points="chart.minLine" fill="none" stroke="#7a7a7a" stroke-width="1.5" />
                  <polyline :points="chart.line" fill="none" stroke="#63e2b7" stroke-width="2" />
                  <template v-if="hoverPoint">
                    <line
                      :x1="hoverPoint.x"
                      :x2="hoverPoint.x"
                      :y1="PAD.t"
                      :y2="CHART_H - PAD.b"
                      class="hover-line"
                    />
                    <circle :cx="hoverPoint.x" :cy="hoverPoint.y" r="3.5" fill="#63e2b7" />
                    <circle :cx="hoverPoint.x" :cy="hoverPoint.ym" r="3" fill="#7a7a7a" />
                  </template>
                </svg>
                <div v-if="hoverPoint" class="chart-tip" :style="tipStyle">
                  <div class="chart-tip-date">{{ hoverDate }}</div>
                  <div>均价 {{ fmtPrice(hoverPoint.p.price) }} ₽</div>
                  <div class="chart-tip-min">最低 {{ fmtPrice(hoverPoint.p.priceMin) }} ₽</div>
                </div>
              </div>
              <p v-if="pricesError" class="chart-empty">{{ pricesError }}</p>
              <p v-else-if="!chart && !pricesLoading" class="chart-empty">暂无历史价格数据</p>
            </div>
          </NSpin>
        </template>
        <p v-else class="chart-empty">该物品无法上架跳蚤市场</p>
        <template v-if="detailEntries.length">
          <h4>属性详情</h4>
          <div class="detail-grid">
            <template v-for="e in detailEntries" :key="e.label">
              <span class="detail-label">{{ e.label }}</span>
              <span>{{ e.value }}</span>
            </template>
          </div>
        </template>
        <template v-if="needingTasks.length">
          <h4>需求任务</h4>
          <ul class="need-tasks">
            <li v-for="t in needingTasks" :key="`${t.id}:${t.action}`">
              <a :href="`https://tarkov.dev/task/${t.norm}`" target="_blank" rel="noopener noreferrer">{{ t.name }}</a>
              <span class="need-action">
                {{ t.action }}<template v-if="t.count > 1"> ×{{ t.count }}</template>
                <template v-if="t.foundInRaid">（战局内捡到）</template>
              </span>
            </li>
          </ul>
        </template>
      </div>
    </NModal>
  </div>
</template>

<style scoped>
.view {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 物品卡片：左大图标，右侧名称 + 字段 */
.goods-card {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.goods-icon {
  width: 96px;
  height: 96px;
  object-fit: contain;
  flex: none;
}

.goods-body {
  flex: 1;
  min-width: 0;
}

.goods-title-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.goods-title {
  font-weight: 600;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.goods-fav {
  color: #f0a020;
  cursor: pointer;
  flex: none;
  font-size: 16px;
}

.goods-fields {
  margin-top: 8px;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 3px 10px;
  font-size: 13px;
}

.field-label {
  color: var(--text-dim);
  white-space: nowrap;
}

.field-value {
  font-variant-numeric: tabular-nums;
}

.tone-up {
  color: #63e2b7;
}

.tone-down {
  color: #e88080;
}

.item-modal {
  position: relative;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 20px 24px;
  max-height: 82vh;
  overflow-y: auto;
}

.item-modal-close {
  position: absolute;
  top: 10px;
  right: 12px;
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 14px;
  cursor: pointer;
}

.item-modal-close:hover {
  color: var(--text);
}

.item-modal-head {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  margin-bottom: 12px;
}

.item-modal-img {
  height: 96px;
  width: auto;
  flex: none;
}

.item-modal-title {
  margin: 0;
  font-size: 22px;
}

.item-modal-meta {
  margin: 4px 0 0;
  color: var(--text-dim);
}

.item-modal-desc {
  color: var(--text);
  line-height: 1.6;
}

.trader-prices {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}

.trader-price {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  min-width: 72px;
}

.trader-avatar {
  height: 44px;
  width: auto;
}

.trader-name {
  color: var(--text-dim);
  font-size: 12px;
}

.trader-text {
  font-weight: 600;
}

.chart-wrap {
  min-height: 60px;
}

.chart-toolbar {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-bottom: 4px;
}

.chart-range {
  background: none;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-dim);
  font-size: 12px;
  padding: 2px 10px;
  cursor: pointer;
}

.chart-range.active {
  color: var(--accent);
  border-color: var(--accent);
}

.chart-box {
  position: relative;
}

.price-chart {
  width: 100%;
  height: auto;
  display: block;
}

.grid-line {
  stroke: var(--border);
  stroke-width: 1;
}

.axis-label {
  fill: var(--text-dim);
  font-size: 11px;
}

.hover-line {
  stroke: var(--text-dim);
  stroke-width: 1;
  stroke-dasharray: 3 3;
}

.chart-tip {
  position: absolute;
  transform: translate(-50%, -100%);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
  line-height: 1.5;
  pointer-events: none;
  white-space: nowrap;
}

.chart-tip-date {
  color: var(--text-dim);
}

.chart-tip-min {
  color: var(--text-dim);
}

.chart-empty {
  color: var(--text-dim);
}

.detail-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 16px;
}

.detail-label {
  color: var(--text-dim);
}

/* 兴奋剂效果等多行值按 \n 换行渲染 */
.detail-grid span:not(.detail-label) {
  white-space: pre-line;
}

.need-tasks li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 4px 0;
}

.need-action {
  color: var(--text-dim);
  font-size: 13px;
}

@media (max-width: 640px) {
  .goods-icon {
    width: 72px;
    height: 72px;
  }
}
</style>
