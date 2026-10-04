<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { NButton, NInputNumber, NSelect, NSpace, NSpin, useMessage } from "naive-ui";
import LoadMore from "@/components/LoadMore.vue";
import { useConfigStore } from "@/stores/config";
import { useDataStore, type MarketData } from "@/stores/data";
import { findDeals, type DealRow, type PriceField } from "@/utils/deals";
import { fmtPct, fmtPrice } from "@/utils/format";

const config = useConfigStore();
const data = useDataStore();
const message = useMessage();

const priceField = ref<PriceField>("lastLowPrice");
const minDiff = ref<number | null>(1);
const loading = ref(false);
const market = ref<MarketData | null>(null);

const priceOptions = [
  { label: "最新最低挂单价", value: "lastLowPrice" },
  { label: "24h均价", value: "avg24hPrice" },
];

const deals = computed<DealRow[]>(() => {
  if (!market.value) return [];
  return findDeals(market.value, priceField.value, minDiff.value ?? 1);
});

/* ---- 无限滚动：滚动到底增量加载 ---- */

const PAGE_SIZE = 60;
const visibleCount = ref(PAGE_SIZE);
const visibleDeals = computed(() => deals.value.slice(0, visibleCount.value));
const hasMore = computed(() => visibleCount.value < deals.value.length);

watch([priceField, minDiff], () => {
  visibleCount.value = PAGE_SIZE;
});

function loadMore() {
  visibleCount.value += PAGE_SIZE;
}

async function load(force = false) {
  loading.value = true;
  try {
    market.value = await data.loadMarketData(config.mode, config.lang, force);
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
      <NSelect v-model:value="priceField" :options="priceOptions" style="width: 150px" />
      <NSpace align="center" :size="6" :wrap="false">
        <span>最小利润</span>
        <NInputNumber v-model:value="minDiff" :min="0" style="width: 120px" />
      </NSpace>
      <NButton :loading="loading" @click="load(true)">刷新</NButton>
    </NSpace>
    <NSpin :show="loading">
      <div class="card-grid">
        <div v-for="(row, i) in visibleDeals" :key="row.name" class="item-card deal-card">
          <span class="deal-rank">#{{ i + 1 }}</span>
          <img v-if="row.icon" :src="row.icon" :alt="row.name" class="deal-icon" loading="lazy" />
          <div class="deal-body">
            <a
              class="deal-title"
              :href="row.link"
              target="_blank"
              rel="noopener noreferrer"
            >{{ row.name }}</a>
            <div class="deal-profit">
              <span class="deal-profit-value">+{{ fmtPrice(row.profit) }} ₽</span>
              <span class="deal-profit-pct">{{ fmtPct(row.profitPct) }}</span>
            </div>
            <div class="deal-fields">
              <span class="field-label">跳蚤价</span>
              <span>{{ fmtPrice(row.flea) }} ₽</span>
              <span class="field-label">商人回收</span>
              <span>{{ fmtPrice(row.traderPrice) }} ₽ ({{ row.trader }})</span>
              <span class="field-label">跳蚤等级</span>
              <span>{{ row.fleaLevel ? `Lv.${row.fleaLevel}` : "-" }}</span>
            </div>
          </div>
        </div>
      </div>
      <LoadMore :loading="loading" :has-more="hasMore" @load="loadMore" />
    </NSpin>
  </div>
</template>

<style scoped>
.view {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.deal-card {
  position: relative;
  display: flex;
  gap: 12px;
  align-items: flex-start;
  cursor: default;
}

.deal-rank {
  position: absolute;
  top: 8px;
  right: 10px;
  color: var(--text-dim);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.deal-icon {
  width: 96px;
  height: 96px;
  object-fit: contain;
  flex: none;
}

.deal-body {
  flex: 1;
  min-width: 0;
}

.deal-title {
  display: inline-block;
  max-width: calc(100% - 40px);
  font-weight: 600;
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: top;
}

.deal-profit {
  margin: 6px 0;
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.deal-profit-value {
  color: var(--accent);
  font-size: 18px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.deal-profit-pct {
  color: var(--accent);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.deal-fields {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 3px 10px;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.field-label {
  color: var(--text-dim);
  white-space: nowrap;
}

@media (max-width: 640px) {
  .deal-icon {
    width: 72px;
    height: 72px;
  }
}
</style>
