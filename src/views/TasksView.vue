<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { NButton, NInput, NModal, NSpace, NSpin, useMessage } from "naive-ui";
import LoadMore from "@/components/LoadMore.vue";
import type { TaskObjective } from "@/api/types";
import { useConfigStore } from "@/stores/config";
import { useDataStore, type MarketData, type TaskData } from "@/stores/data";
import { kappaTaskIds, makeTaskRow, matchRow, resolveRewards, taskMapLinks, translate, type TaskRow } from "@/utils/deals";

const config = useConfigStore();
const data = useDataStore();
const message = useMessage();

const rows = ref<TaskRow[]>([]);
const taskData = ref<TaskData | null>(null);
const marketData = ref<MarketData | null>(null);
const query = ref("");
const loading = ref(false);
const modal = ref(false);
const current = ref<TaskRow | null>(null);

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

const mapLinks = computed(() => {
  if (!current.value || !taskData.value) return [];
  return taskMapLinks(current.value.task, taskData.value);
});

const rewards = computed(() => {
  if (!current.value || !marketData.value) return null;
  return resolveRewards(current.value.task, marketData.value);
});

const hasRewards = computed(() => {
  const r = rewards.value;
  return (
    !!r &&
    (r.experience > 0 || r.standings.length > 0 || r.money.length > 0 || r.items.length > 0)
  );
});

function objectiveText(ob: TaskObjective): string {
  const text = translate(ob.description ?? "", taskData.value?.tr ?? {});
  return ob.optional ? `${text} (可选)` : text;
}

function openTask(row: TaskRow) {
  current.value = row;
  modal.value = true;
}

async function load(force = false) {
  loading.value = true;
  try {
    const [market, td] = await Promise.all([
      data.loadMarketData(config.mode, config.lang, force),
      data.loadTaskData(config.mode, config.lang, force),
    ]);
    taskData.value = td;
    marketData.value = market;
    const kappaIds = kappaTaskIds(td.tasks);
    const list = Object.values(td.tasks).map((t) => {
      const row = makeTaskRow(t, td, market);
      row.kappa = kappaIds.has(row.id);
      return row;
    });
    list.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
    rows.value = list;
    visibleCount.value = PAGE_SIZE;
  } catch (e) {
    message.error(`加载任务数据失败：${e instanceof Error ? e.message : String(e)}`);
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
      <NButton :loading="loading" @click="load(true)">刷新</NButton>
    </NSpace>
    <NSpin :show="loading">
      <div class="card-grid">
        <div v-for="row in visibleRows" :key="row.id" class="item-card task-card" @click="openTask(row)">
          <img v-if="row.icon" :src="row.icon" :alt="row.name" class="task-icon" loading="lazy" />
          <div class="task-body">
            <a
              class="task-title"
              :href="`https://tarkov.dev/task/${row.norm}`"
              target="_blank"
              rel="noopener noreferrer"
              @click.stop
            >{{ row.name }}</a>
            <div class="task-fields">
              <span class="field-label">商人</span>
              <span>{{ row.trader || "-" }}</span>
              <span class="field-label">地图</span>
              <span>{{ row.map || "-" }}</span>
              <span class="field-label">等级</span>
              <span>{{ row.level ? `Lv.${row.level}` : "-" }}</span>
            </div>
          </div>
          <span v-if="row.kappa" class="task-kappa" title="需要 3x4 (Kappa)">Kappa ✔</span>
        </div>
      </div>
      <LoadMore :loading="loading" :has-more="hasMore" @load="loadMore" />
    </NSpin>
    <NModal v-model:show="modal" style="width: min(640px, 92vw)">
      <div v-if="current" class="task-modal">
        <button class="task-modal-close" title="关闭" @click="modal = false">✕</button>
        <h2 class="task-modal-title">
          <a
            :href="`https://tarkov.dev/task/${current.norm}`"
            target="_blank"
            rel="noopener noreferrer"
          >{{ current.name }}</a>
        </h2>
        <img
          v-if="current.icon"
          :src="current.icon"
          :alt="current.name"
          class="task-modal-img"
        />
        <p class="task-modal-meta">
          商人：{{ current.trader || "-" }}　地图：{{ current.map || "-" }}　等级：{{ current.level ? `Lv.${current.level}` : "-" }}
          <span v-if="current.kappa">　需要 3x4 (Kappa)</span>
        </p>
        <p v-if="current.wiki" class="task-modal-meta">
          <a :href="current.wiki" target="_blank" rel="noopener noreferrer">Wiki</a>
        </p>
        <template v-if="current.task.objectives?.length">
          <h4>任务目标</h4>
          <ul>
            <li v-for="(ob, i) in current.task.objectives" :key="i">{{ objectiveText(ob) }}</li>
          </ul>
        </template>
        <template v-if="hasRewards && rewards">
          <h4>任务奖励</h4>
          <ul class="task-rewards">
            <li v-if="rewards.experience > 0">经验值 +{{ rewards.experience.toLocaleString() }}</li>
            <li v-for="(s, i) in rewards.standings" :key="`s${i}`">
              商人好感：{{ s.trader }} {{ s.standing > 0 ? "+" : "" }}{{ s.standing }}
            </li>
            <li v-for="(m, i) in rewards.money" :key="`m${i}`">
              <img v-if="m.icon" :src="m.icon" :alt="m.name" class="reward-icon" loading="lazy" />
              {{ m.name }} ×{{ m.count.toLocaleString() }}
            </li>
            <li v-for="(it, i) in rewards.items" :key="`i${i}`">
              <img v-if="it.icon" :src="it.icon" :alt="it.name" class="reward-icon" loading="lazy" />
              <a v-if="it.link" :href="it.link" target="_blank" rel="noopener noreferrer">{{ it.name }}</a>
              <span v-else>{{ it.name }}</span>
              <template v-if="it.count > 1"> ×{{ it.count.toLocaleString() }}</template>
            </li>
          </ul>
        </template>
        <template v-if="mapLinks.length">
          <h4>地图定位（新标签页打开）</h4>
          <div>
            <template v-for="(link, i) in mapLinks" :key="i">
              <span v-if="i > 0"> | </span>
              <RouterLink :to="{ name: 'map', query: link.query }" target="_blank">{{ link.mapName }}</RouterLink>
            </template>
          </div>
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

.task-card {
  position: relative;
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.task-icon {
  width: 72px;
  height: 72px;
  object-fit: cover;
  border-radius: 6px;
  flex: none;
}

.task-body {
  flex: 1;
  min-width: 0;
}

.task-title {
  display: inline-block;
  max-width: 100%;
  font-weight: 600;
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: top;
}

.task-kappa {
  position: absolute;
  top: 8px;
  right: 10px;
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
}

.task-fields {
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

.task-modal {
  position: relative;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 20px 24px;
  max-height: 82vh;
  overflow-y: auto;
}

.task-modal-close {
  position: absolute;
  top: 10px;
  right: 12px;
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 14px;
  cursor: pointer;
}

.task-modal-close:hover {
  color: var(--text);
}

.task-modal-title {
  margin: 0 0 12px;
  text-align: center;
  font-size: 22px;
}

.task-modal-img {
  display: block;
  margin: 0 auto 12px;
  max-width: 100%;
  border-radius: 6px;
}

.task-modal-meta {
  text-align: center;
  color: var(--text-dim);
}

.task-rewards li {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 4px 0;
}

.reward-icon {
  height: 32px;
  width: auto;
  flex: none;
}
</style>
