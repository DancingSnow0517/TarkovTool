import { defineStore } from "pinia";
import { fetchCached, fetchJson } from "@/api/client";
import type { GameMap, Item, Task, Trader, TranslationMap } from "@/api/types";
import type { GameMode } from "@/stores/config";

export interface MarketData {
  items: Record<string, Item>;
  itemTr: TranslationMap;
  traderTr: TranslationMap;
  traders: Record<string, Trader>;
  /** 英文译名始终加载，保证任何界面语言下都能用英文搜索 */
  enTr: TranslationMap;
}

export interface TaskData {
  tasks: Record<string, Task>;
  tr: TranslationMap;
  /** 英文任务译名，用于搜索 */
  en: TranslationMap;
  /** 地图 id -> normalizedName（地图页 URL 参数用） */
  mapKeys: Record<string, string>;
  mapTr: TranslationMap;
}

interface JsonData<T> {
  data: T;
}

/** 按 模式+语言 缓存市场/任务数据；force 时重新拉取（实时价格不进 localStorage） */
export const useDataStore = defineStore("data", () => {
  const marketCache = new Map<string, MarketData>();
  const taskCache = new Map<string, TaskData>();

  async function loadMarketData(mode: GameMode, lang: string, force = false): Promise<MarketData> {
    const key = `${mode}:${lang}`;
    const hit = marketCache.get(key);
    if (!force && hit) return hit;
    const items = (await fetchJson<JsonData<{ items: Record<string, Item> }>>(`/${mode}/items`)).data.items;
    const itemTr = (await fetchCached<JsonData<TranslationMap>>(`/${mode}/items_${lang}`)).data;
    const traderTr = (await fetchCached<JsonData<TranslationMap>>(`/${mode}/traders_${lang}`)).data;
    const enTr = lang === "en"
      ? itemTr
      : (await fetchCached<JsonData<TranslationMap>>(`/${mode}/items_en`)).data;
    const traders = (await fetchCached<JsonData<Record<string, Trader>>>(`/${mode}/traders`)).data;
    const data: MarketData = { items, itemTr, traderTr, traders, enTr };
    marketCache.set(key, data);
    return data;
  }

  async function loadTaskData(mode: GameMode, lang: string, force = false): Promise<TaskData> {
    const key = `${mode}:${lang}`;
    const hit = taskCache.get(key);
    if (!force && hit) return hit;
    const tasks = (await fetchCached<JsonData<{ tasks: Record<string, Task> }>>(`/${mode}/tasks`)).data.tasks;
    const tr = (await fetchCached<JsonData<TranslationMap>>(`/${mode}/tasks_${lang}`)).data;
    const en = lang === "en"
      ? tr
      : (await fetchCached<JsonData<TranslationMap>>(`/${mode}/tasks_en`)).data;
    const maps = (await fetchCached<JsonData<{ maps: Record<string, GameMap> }>>(`/${mode}/maps`)).data.maps;
    const mapTr = (await fetchCached<JsonData<TranslationMap>>(`/${mode}/maps_${lang}`)).data;
    const mapKeys: Record<string, string> = {};
    for (const [id, m] of Object.entries(maps)) mapKeys[id] = m.normalizedName ?? "";
    const data: TaskData = { tasks, tr, en, mapKeys, mapTr };
    taskCache.set(key, data);
    return data;
  }

  /** 地图 id -> 本地化名称（导航栏地图菜单用），随模式/语言走 fetchCached 缓存 */
  async function loadMapNames(mode: GameMode, lang: string): Promise<Record<string, string>> {
    const maps = (await fetchCached<JsonData<{ maps: Record<string, GameMap> }>>(`/${mode}/maps`)).data.maps;
    const tr = (await fetchCached<JsonData<TranslationMap>>(`/${mode}/maps_${lang}`)).data;
    const names: Record<string, string> = {};
    for (const [id, m] of Object.entries(maps)) names[id] = tr[`${id} Name`] ?? m.normalizedName ?? id;
    return names;
  }

  return { loadMarketData, loadTaskData, loadMapNames };
});
