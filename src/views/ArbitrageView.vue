<script setup lang="ts">
import { computed, h, onMounted, ref, watch } from "vue";
import {
  NButton,
  NDataTable,
  NInputNumber,
  NSelect,
  NSpace,
  NSpin,
  NText,
  useMessage,
  type DataTableColumns,
} from "naive-ui";
import { useConfigStore } from "@/stores/config";
import { useDataStore, type MarketData } from "@/stores/data";
import { findDeals, type DealRow, type PriceField } from "@/utils/deals";
import { fmtPct, fmtPrice } from "@/utils/format";
import { renderItemName } from "@/utils/item-cell";

const config = useConfigStore();
const data = useDataStore();
const message = useMessage();

const priceField = ref<PriceField>("lastLowPrice");
const minDiff = ref<number | null>(1);
const limit = ref<number | null>(50);
const loading = ref(false);
const market = ref<MarketData | null>(null);

const priceOptions = [
  { label: "最新最低挂单价", value: "lastLowPrice" },
  { label: "24h均价", value: "avg24hPrice" },
];

const deals = computed<DealRow[]>(() => {
  if (!market.value) return [];
  return findDeals(market.value, priceField.value, minDiff.value ?? 1).slice(0, limit.value ?? 50);
});

const columns: DataTableColumns<DealRow> = [
  { title: "#", key: "index", width: 60, render: (_row, index) => index + 1 },
  {
    title: "物品",
    key: "name",
    width: 320,
    resizable: true,
    ellipsis: { tooltip: true },
    render: renderItemName,
  },
  { title: "跳蚤价 ₽", key: "flea", width: 130, resizable: true, render: (row) => fmtPrice(row.flea) },
  { title: "商人回收价 ₽", key: "traderPrice", width: 140, resizable: true, render: (row) => fmtPrice(row.traderPrice) },
  { title: "商人", key: "trader", width: 120, resizable: true },
  {
    title: "跳蚤等级",
    key: "fleaLevel",
    width: 90,
    render: (row) => (row.fleaLevel ? `Lv.${row.fleaLevel}` : "-"),
  },
  {
    title: "利润 ₽",
    key: "profit",
    width: 120,
    resizable: true,
    render: (row) => h(NText, { type: "success" }, () => fmtPrice(row.profit)),
  },
  {
    title: "利润率",
    key: "profitPct",
    width: 100,
    resizable: true,
    render: (row) => h(NText, { type: "success" }, () => fmtPct(row.profitPct)),
  },
];

async function load(force = false) {
  loading.value = true;
  try {
    market.value = await data.loadMarketData(config.mode, config.lang, force);
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
      <NSpace align="center" :size="6">
        <span>最小利润</span>
        <NInputNumber v-model:value="minDiff" :min="0" style="width: 120px" />
      </NSpace>
      <NSpace align="center" :size="6">
        <span>显示条数</span>
        <NInputNumber v-model:value="limit" :min="1" style="width: 100px" />
      </NSpace>
      <NButton :loading="loading" @click="load(true)">刷新</NButton>
    </NSpace>
    <NSpin :show="loading" class="table-wrap">
      <NDataTable
        :columns="columns"
        :data="deals"
        :row-key="(row: DealRow) => row.name"
        flex-height
        size="small"
      />
    </NSpin>
  </div>
</template>

<style scoped>
.view {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 12px;
}

.table-wrap {
  flex: 1;
  min-height: 0;
}

.table-wrap :deep(.n-spin-content) {
  height: 100%;
}

/* flex-height 的表体 flex-basis: 0，表格根必须有确定高度，否则只剩表头 */
.table-wrap :deep(.n-data-table) {
  height: 100%;
}
</style>
