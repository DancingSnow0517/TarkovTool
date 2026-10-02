<script setup lang="ts">
import { computed, h, onMounted, ref, watch } from "vue";
import {
  NButton,
  NDataTable,
  NInput,
  NSpace,
  NSpin,
  NText,
  useMessage,
  type DataTableColumns,
} from "naive-ui";
import ColumnsModal from "@/components/ColumnsModal.vue";
import { useConfigStore } from "@/stores/config";
import { useDataStore } from "@/stores/data";
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
import { renderItemName } from "@/utils/item-cell";

const config = useConfigStore();
const data = useDataStore();
const message = useMessage();

const rows = ref<ItemRow[]>([]);
const query = ref("");
const loading = ref(false);
const showColumns = ref(false);

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return rows.value;
  return rows.value.filter((r) => matchRow(r, q));
});

const activeKeys = computed<ItemColumnKey[]>(() => {
  const valid = new Set<string>(ITEM_COLUMNS.map((c) => c.key));
  return (config.columns ?? DEFAULT_ITEM_COLUMNS).filter((k): k is ItemColumnKey => valid.has(k));
});

const columnLabels = new Map<string, string>(ITEM_COLUMNS.map((c) => [c.key, c.label]));

const columnWidths: Record<ItemColumnKey, number> = {
  flea: 130,
  avg24h: 130,
  low24h: 130,
  high24h: 130,
  change48h: 100,
  offers: 90,
  trader: 200,
  flea_level: 90,
  base: 130,
};

function renderCell(key: ItemColumnKey, row: ItemRow) {
  switch (key) {
    case "flea":
    case "avg24h":
    case "low24h":
    case "high24h":
    case "base":
      return fmtPrice(row[key]);
    case "change48h": {
      const v = row.change48h;
      if (v == null) return "-";
      return h(NText, { type: v >= 0 ? "success" : "error" }, () => fmtSignedPct(v));
    }
    case "offers":
      return row.offers == null ? "-" : String(row.offers);
    case "trader":
      return row.traderPrice != null ? `${fmtPrice(row.traderPrice)} (${row.trader})` : "-";
    case "flea_level":
      return row.fleaLevel ? `Lv.${row.fleaLevel}` : "-";
  }
}

const columns = computed<DataTableColumns<ItemRow>>(() => [
  {
    title: "★",
    key: "fav",
    width: 50,
    render: (row) =>
      h(
        "span",
        {
          style: "cursor: pointer; color: #f0a020",
          onClick: () => {
            config.toggleFavorite(row.id);
            sortItemRows(rows.value, config.favorites);
          },
        },
        config.favorites.has(row.id) ? "★" : "☆",
      ),
  },
  {
    title: "物品",
    key: "name",
    width: 320,
    resizable: true,
    ellipsis: { tooltip: true },
    render: renderItemName,
  },
  ...activeKeys.value.map((key) => ({
    title: columnLabels.get(key),
    key,
    width: columnWidths[key],
    resizable: true,
    render: (row: ItemRow) => renderCell(key, row),
  })),
]);

async function load(force = false) {
  loading.value = true;
  try {
    const m = await data.loadMarketData(config.mode, config.lang, force);
    const list = Object.values(m.items).map((item) => makeItemRow(item, m));
    sortItemRows(list, config.favorites);
    rows.value = list;
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
        style="width: 280px"
      />
      <NButton @click="showColumns = true">列设置</NButton>
      <NButton :loading="loading" @click="load(true)">刷新</NButton>
    </NSpace>
    <NSpin :show="loading" class="table-wrap">
      <NDataTable
        :columns="columns"
        :data="filtered"
        :row-key="(row: ItemRow) => row.id"
        flex-height
        virtual-scroll
        size="small"
      />
    </NSpin>
    <ColumnsModal v-model:show="showColumns" />
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
