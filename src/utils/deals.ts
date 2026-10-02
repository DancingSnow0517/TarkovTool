/** 数据计算逻辑（移植自 main.py）：套利、物品行、任务行、任务地图链接 */

import type { Item, Task } from "@/api/types";
import type { MarketData, TaskData } from "@/stores/data";
import { pinyinIndex } from "@/utils/pinyin";

export function translate(placeholder: string, tr: Record<string, string>): string {
  return tr[placeholder] ?? placeholder;
}

/* ---- 套利表 ---- */

export type PriceField = "lastLowPrice" | "avg24hPrice";

export interface DealRow {
  name: string;
  link: string;
  icon: string;
  flea: number;
  traderPrice: number;
  trader: string;
  fleaLevel: number;
  profit: number;
  profitPct: number;
}

export function findDeals(data: MarketData, priceField: PriceField, minDiff: number): DealRow[] {
  const deals: DealRow[] = [];
  for (const item of Object.values(data.items)) {
    const flea = item[priceField];
    const offers = item.sellToTrader ?? [];
    if (!flea || !offers.length) continue;
    const best = offers.reduce((a, b) => (b.priceRUB > a.priceRUB ? b : a));
    const profit = best.priceRUB - flea;
    if (profit < minDiff) continue;
    const trader = data.traders[best.trader] ?? {};
    deals.push({
      name: translate(item.name, data.itemTr),
      link: item.link ?? "",
      icon: item.gridImageLink ?? "",
      flea,
      traderPrice: best.priceRUB,
      trader: translate(trader.name ?? best.trader, data.traderTr),
      fleaLevel: item.minLevelForFlea ?? 0,
      profit,
      profitPct: (profit / flea) * 100,
    });
  }
  deals.sort((a, b) => b.profit - a.profit);
  return deals;
}

/* ---- 物品列表 ---- */

export const ITEM_COLUMNS = [
  { key: "flea", label: "跳蚤价 ₽" },
  { key: "avg24h", label: "24h均价 ₽" },
  { key: "low24h", label: "24h最低 ₽" },
  { key: "high24h", label: "24h最高 ₽" },
  { key: "change48h", label: "48h涨跌" },
  { key: "offers", label: "挂单数" },
  { key: "trader", label: "商人回收" },
  { key: "flea_level", label: "跳蚤等级" },
  { key: "base", label: "基准价 ₽" },
] as const;

export type ItemColumnKey = (typeof ITEM_COLUMNS)[number]["key"];

export const DEFAULT_ITEM_COLUMNS: ItemColumnKey[] = ["flea", "avg24h", "trader", "flea_level"];

export interface ItemRow {
  id: string;
  name: string;
  norm: string;
  en: string;
  py: string;
  pya: string;
  link: string;
  icon: string;
  flea: number | null;
  avg24h: number | null;
  low24h: number | null;
  high24h: number | null;
  change48h: number | null;
  offers: number | null;
  traderPrice: number | null;
  trader: string;
  fleaLevel: number;
  base: number | null;
}

export function makeItemRow(item: Item, data: MarketData): ItemRow {
  const offers = item.sellToTrader ?? [];
  const best = offers.length ? offers.reduce((a, b) => (b.priceRUB > a.priceRUB ? b : a)) : null;
  const trader = best ? (data.traders[best.trader] ?? {}) : {};
  const name = translate(item.name, data.itemTr);
  return {
    id: item.id,
    name,
    norm: item.normalizedName ?? "",
    en: translate(item.name, data.enTr).toLowerCase(),
    ...pinyinIndex(name),
    link: item.link ?? "",
    icon: item.gridImageLink ?? "",
    flea: item.lastLowPrice ?? null,
    avg24h: item.avg24hPrice ?? null,
    low24h: item.low24hPrice ?? null,
    high24h: item.high24hPrice ?? null,
    change48h: item.changeLast48hPercent ?? null,
    offers: item.lastOfferCount ?? null,
    traderPrice: best ? best.priceRUB : null,
    trader: best ? translate(trader.name ?? "", data.traderTr) : "",
    fleaLevel: item.minLevelForFlea ?? 0,
    base: item.basePrice ?? null,
  };
}

/** 收藏排最前，其余按跳蚤价降序（无价格的垫底） */
export function sortItemRows(rows: ItemRow[], favs: Set<string>): void {
  rows.sort((a, b) => {
    const fa = favs.has(a.id) ? 0 : 1;
    const fb = favs.has(b.id) ? 0 : 1;
    if (fa !== fb) return fa - fb;
    return (b.flea ?? -1) - (a.flea ?? -1);
  });
}

/* ---- 搜索 ---- */

export interface Searchable {
  name: string;
  en: string;
  norm: string;
  py: string;
  pya: string;
}

/** 中文/英文/normalizedName/拼音全拼/首字母 搜索 */
export function matchRow(row: Searchable, q: string): boolean {
  return (
    row.name.toLowerCase().includes(q) ||
    row.en.includes(q) ||
    row.norm.includes(q) ||
    row.py.includes(q) ||
    row.pya.includes(q)
  );
}

/* ---- 任务列表 ---- */

/** Kappa 所需任务的传递闭包：kappaRequired 任务 + 它们（递归）依赖的前置任务 */
export function kappaTaskIds(tasks: Record<string, Task>): Set<string> {
  const ids = new Set<string>();
  const queue = Object.values(tasks).filter((t) => t.kappaRequired).map((t) => t.id);
  while (queue.length) {
    const id = queue.pop()!;
    if (ids.has(id)) continue;
    ids.add(id);
    for (const req of tasks[id]?.taskRequirements ?? []) queue.push(req.task);
  }
  return ids;
}

export interface TaskRow extends Searchable {
  id: string;
  task: Task;
  trader: string;
  map: string;
  level: number;
  kappa: boolean;
  wiki: string;
  icon: string;
}

export function makeTaskRow(task: Task, td: TaskData, market: MarketData): TaskRow {
  const name = translate(task.name, td.tr);
  const trader = task.trader ? (market.traders[task.trader] ?? {}) : {};
  return {
    id: task.id,
    task,
    name,
    norm: task.normalizedName ?? "",
    en: translate(task.name, td.en).toLowerCase(),
    ...pinyinIndex(name),
    trader: translate(trader.name ?? "", market.traderTr),
    map: task.map ? translate(`${task.map} Name`, td.mapTr) : "",
    level: task.minPlayerLevel ?? 0,
    kappa: task.kappaRequired ?? false,
    wiki: task.wikiLink ?? "",
    icon: task.taskImageLink ?? "",
  };
}

/* ---- 任务地图链接 ---- */

export interface TaskMapLink {
  mapName: string;
  /** 站内地图页 query 参数（模式/语言由地图页跟随导航栏配置，不随链接携带） */
  query: { map: string; q: string; task: string };
}

/** 汇总任务所有目标的坐标点，按地图分组：每张地图一条链接，q 携带该图全部点位 */
export function taskMapLinks(task: Task, td: TaskData): TaskMapLink[] {
  const byMap = new Map<string, { key: string; qids: string[] }>();
  const add = (mapId: string | undefined, qid: string) => {
    const key = mapId ? td.mapKeys[mapId] : undefined;
    if (!mapId || !key) return;
    let entry = byMap.get(mapId);
    if (!entry) {
      entry = { key, qids: [] };
      byMap.set(mapId, entry);
    }
    if (!entry.qids.includes(qid)) entry.qids.push(qid);
  };
  for (const ob of task.objectives ?? []) {
    for (const z of ob.zones ?? []) add(z.map, z.id);
    const questItem = ob.questItem;
    if (questItem) {
      for (const loc of ob.possibleLocations ?? []) add(loc.map, questItem);
    }
  }
  return [...byMap.entries()].map(([mapId, { key, qids }]) => ({
    mapName: translate(`${mapId} Name`, td.mapTr),
    query: { map: key, q: qids.join(","), task: task.id },
  }));
}

/* ---- 任务奖励 ---- */

/** 货币物品 id（卢布/美元/欧元），奖励拆分时按此归类为金钱 */
const CURRENCY_IDS = new Set([
  "5449016a4bdc2d6f028b456f",
  "5696686a4bdc2da3298b456a",
  "569668774bdc2da2298b4568",
]);

export interface RewardView {
  /** 经验值 */
  experience: number;
  /** 商人好感增减 */
  standings: { trader: string; standing: number }[];
  /** 金钱奖励：本地化货币名 + 图标 + 数量 */
  money: { name: string; count: number; icon: string }[];
  /** 物品奖励：本地化名 + 图标 + 数量 + 链接 */
  items: { name: string; count: number; icon: string; link: string }[];
}

/** 解析任务完成奖励为展示结构；名称/图标取自市场物品与商人数据 */
export function resolveRewards(task: Task, market: MarketData): RewardView {
  const view: RewardView = { experience: task.experience ?? 0, standings: [], money: [], items: [] };
  const rewards = task.finishRewards;
  if (!rewards) return view;
  for (const s of rewards.traderStanding ?? []) {
    const trader = market.traders[s.trader] ?? {};
    view.standings.push({
      trader: translate(trader.name ?? s.trader, market.traderTr),
      standing: s.standing,
    });
  }
  for (const ri of rewards.items ?? []) {
    const item = market.items[ri.item];
    const name = item ? translate(item.name, market.itemTr) : ri.item;
    const icon = item?.gridImageLink ?? "";
    if (CURRENCY_IDS.has(ri.item)) {
      view.money.push({ name, count: ri.count, icon });
    } else {
      view.items.push({ name, count: ri.count, icon, link: item?.link ?? "" });
    }
  }
  return view;
}
