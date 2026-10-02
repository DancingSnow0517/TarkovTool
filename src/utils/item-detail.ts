/** 物品详情弹窗的数据组装：商人回收价、属性明细、需求任务 */

import type { Item, TranslationMap } from "@/api/types";
import type { MarketData, TaskData } from "@/stores/data";
import { translate } from "@/utils/deals";

/** 按币种格式化价格：卢布空格分隔，美元/欧元带符号 */
export function fmtCurrency(price: number, currency: string): string {
  switch (currency) {
    case "USD":
      return `$${price.toLocaleString("en-US")}`;
    case "EUR":
      return `€${price.toLocaleString("en-US")}`;
    default:
      return `${price.toLocaleString("en-US")} ₽`;
  }
}

export interface TraderPrice {
  name: string;
  avatar: string;
  text: string;
  priceRUB: number;
}

/** 商人回收价列表，按卢布折算价降序 */
export function traderPrices(item: Item, market: MarketData): TraderPrice[] {
  const list: TraderPrice[] = [];
  for (const offer of item.sellToTrader ?? []) {
    const trader = market.traders[offer.trader] ?? {};
    list.push({
      name: translate(trader.name ?? offer.trader, market.traderTr),
      avatar: trader.imageLink ?? "",
      text: fmtCurrency(offer.price, offer.currency),
      priceRUB: offer.priceRUB,
    });
  }
  list.sort((a, b) => b.priceRUB - a.priceRUB);
  return list;
}

export interface DetailEntry {
  label: string;
  value: string;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** 惩罚类字段是小数（-0.09 → -9%），展示时乘 100 */
function pct(v: unknown): string | undefined {
  const n = num(v);
  return n == null ? undefined : `${Math.round(n * 1000) / 10}%`;
}

/** 医疗物品治愈部位/状态的枚举值 → 中文（dump 无翻译键） */
const CURES: Record<string, string> = {
  LightBleeding: "轻出血",
  HeavyBleeding: "重出血",
  Fracture: "骨折",
  Pain: "疼痛",
  Contusion: "脑震荡",
  Intoxication: "中毒",
  RadExposure: "辐射",
};

function curesText(v: unknown): string | undefined {
  if (!Array.isArray(v) || !v.length) return undefined;
  return v.map((c) => CURES[String(c)] ?? String(c)).join(", ");
}

/** 头盔隔音程度枚举 → 中文 */
const DEAFENING: Record<string, string> = {
  None: "无",
  Mild: "轻微",
  Moderate: "中等",
  High: "严重",
};

function zonesText(v: unknown, tr: TranslationMap): string | undefined {
  if (!Array.isArray(v) || !v.length) return undefined;
  return v.map((z) => translate(String(z), tr)).join(", ");
}

function armorEntries(p: Item["properties"], tr: TranslationMap, push: (l: string, v: string | number | undefined) => void) {
  if (!p) return;
  push("护甲等级", num(p.class));
  push("耐久", num(p.durability));
  push("材质", str(p.material));
  push("装甲类型", str(p.armorType) ? translate(str(p.armorType)!, tr) : undefined);
  push("防护区域", zonesText(p.zones, tr));
  push("移速惩罚", pct(p.speedPenalty));
  push("转身惩罚", pct(p.turnPenalty));
  push("人机惩罚", pct(p.ergoPenalty));
  push("钝伤穿透", num(p.bluntThroughput));
  push("致盲防护", pct(p.blindnessProtection));
}

/** 通用属性（重量/占格/基础价）+ 按 propertiesType 分型的各类装备属性 */
export function itemDetails(item: Item, market?: MarketData): DetailEntry[] {
  const tr = market?.itemTr ?? {};
  const out: DetailEntry[] = [];
  const push = (label: string, value: string | number | undefined) => {
    if (value != null && value !== "") out.push({ label, value: String(value) });
  };
  const p = item.properties;
  // 武器/配件类的实际占格在 properties.defaultWidth/Height，item.width/height 是折叠尺寸
  const w = num(p?.defaultWidth) ?? item.width;
  const h = num(p?.defaultHeight) ?? item.height;
  push("重量", item.weight != null ? `${item.weight} kg` : undefined);
  push("占格", w != null && h != null ? `${w}×${h}` : undefined);
  push("基础价", item.basePrice ? `${item.basePrice.toLocaleString("en-US")} ₽` : undefined);
  if (!p) return out;
  // propertiesType 形如 ItemPropertiesWeapon / ItemPropertiesArmor
  const kind = (p.propertiesType ?? "").replace(/^ItemProperties/, "");
  switch (kind) {
    case "Weapon":
      push("口径", str(p.caliber)?.replace(/^Caliber/, ""));
      push("人机功效", num(p.ergonomics));
      push("垂直后坐", num(p.recoilVertical));
      push("水平后坐", num(p.recoilHorizontal));
      push("射速", num(p.fireRate));
      push("有效射程", num(p.effectiveDistance) != null ? `${p.effectiveDistance} m` : undefined);
      push("耐久", num(p.maxDurability));
      break;
    case "Preset": {
      const baseId = str(p.baseItem);
      const base = baseId ? market?.items[baseId] : undefined;
      push("基础武器", base ? translate(base.name, tr) : undefined);
      push("人机功效", num(p.ergonomics));
      push("垂直后坐", num(p.recoilVertical));
      push("水平后坐", num(p.recoilHorizontal));
      push("精度", num(p.moa) != null ? `${p.moa} MOA` : undefined);
      break;
    }
    case "Armor":
    case "Helmet":
    case "ArmorAttachment":
      armorEntries(p, tr, push);
      if (kind === "Helmet") {
        const deaf = str(p.deafening);
        push("隔音", deaf ? (DEAFENING[deaf] ?? deaf) : undefined);
      }
      break;
    case "ChestRig":
      push("容量", num(p.capacity) != null ? `${p.capacity} 格` : undefined);
      armorEntries(p, tr, push);
      break;
    case "Backpack":
    case "Container":
      push("容量", num(p.capacity) != null ? `${p.capacity} 格` : undefined);
      push("移速惩罚", pct(p.speedPenalty));
      push("转身惩罚", pct(p.turnPenalty));
      push("人机惩罚", pct(p.ergoPenalty));
      break;
    case "Headphone":
      push("环境音量", num(p.ambientVolume) != null ? `${p.ambientVolume} dB` : undefined);
      push("压缩器增益", num(p.compressorGain) != null ? `${p.compressorGain} dB` : undefined);
      push("距离修正", num(p.distanceModifier) != null ? `×${p.distanceModifier}` : undefined);
      push("失真", num(p.distortion));
      push("干音量", num(p.dryVolume) != null ? `${p.dryVolume} dB` : undefined);
      break;
    case "Magazine":
      push("容量", num(p.capacity) != null ? `${p.capacity} 发` : undefined);
      push("人机功效", num(p.ergonomics));
      push("装填修正", pct(p.loadModifier));
      push("检查弹药修正", pct(p.ammoCheckModifier));
      push("故障率", pct(p.malfunctionChance));
      break;
    case "Scope":
      push("倍率", Array.isArray(p.zoomLevels) && p.zoomLevels.length
        ? (p.zoomLevels[0] as number[]).map((z) => `${z}×`).join(" / ")
        : undefined);
      push("人机功效", num(p.ergonomics));
      push("瞄准距离", num(p.sightingRange) != null ? `${p.sightingRange} m` : undefined);
      break;
    case "Glasses":
      push("致盲防护", pct(p.blindnessProtection));
      push("材质", str(p.material));
      break;
    case "Barrel":
      push("人机功效", num(p.ergonomics));
      push("后坐", pct(p.recoilModifier));
      push("精度", num(p.centerOfImpact) != null ? `${p.centerOfImpact} MOA` : undefined);
      break;
    case "Grenade":
      push("引信", num(p.fuse) != null ? `${p.fuse} s` : undefined);
      push("爆炸距离", num(p.minExplosionDistance) != null ? `${p.minExplosionDistance}~${p.maxExplosionDistance} m` : undefined);
      push("破片数", num(p.fragments));
      break;
    case "Melee":
      push("挥砍伤害", num(p.slashDamage));
      push("刺击伤害", num(p.stabDamage));
      push("攻击距离", num(p.hitRadius) != null ? `${p.hitRadius} m` : undefined);
      break;
    case "FoodDrink":
      push("能量", num(p.energy));
      push("水分", num(p.hydration));
      push("份数", num(p.units));
      break;
    case "MedicalItem":
    case "Painkiller":
    case "SurgicalKit":
      push("使用次数", num(p.uses));
      push("使用时间", num(p.useTime) != null ? `${p.useTime} s` : undefined);
      push("治疗", curesText(p.cures));
      break;
    case "MedKit":
      push("生命值", num(p.hitpoints));
      push("使用时间", num(p.useTime) != null ? `${p.useTime} s` : undefined);
      push("单次治疗上限", num(p.maxHealPerUse));
      push("治疗", curesText(p.cures));
      break;
    case "Stim":
      push("使用时间", num(p.useTime) != null ? `${p.useTime} s` : undefined);
      push("治疗", curesText(p.cures));
      push("效果", stimEffectsText(p.stimEffects, tr));
      break;
    case "Key":
      push("使用次数", num(p.uses));
      break;
    case "NightVision":
      push("强度", num(p.intensity));
      push("噪声", num(p.noiseIntensity));
      break;
    case "Ammo":
      push("伤害", num(p.damage));
      push("穿甲", num(p.penetrationPower));
      push("护甲伤害", num(p.armorDamage));
      push("碎弹率", pct(p.fragmentationChance));
      push("弹丸数", num(p.projectileCount));
      push("初速", num(p.initialSpeed) != null ? `${p.initialSpeed} m/s` : undefined);
      push("曳光", p.tracer === true ? "是" : p.tracer === false ? "否" : undefined);
      break;
    case "WeaponMod":
      push("人机功效", num(p.ergonomics));
      push("后坐", pct(p.recoilModifier));
      push("精度", pct(p.accuracyModifier));
      break;
  }
  return out;
}

/** 兴奋剂效果列表：一行一条（\n 分隔），类型/技能走 items_zh 翻译；数值为 0 时不显示 */
function stimEffectsText(v: unknown, tr: TranslationMap): string | undefined {
  if (!Array.isArray(v) || !v.length) return undefined;
  return v
    .map((e) => {
      const eff = e as { type?: string; skill?: string; value?: number; percent?: boolean; delay?: number; duration?: number; chance?: number };
      const type = translate(eff.type ?? "", tr);
      const skill = eff.skill ? `（${translate(eff.skill, tr)}）` : "";
      const value = eff.value ? ` ${eff.value > 0 ? "+" : ""}${eff.value}${eff.percent ? "%" : ""}` : "";
      const delay = eff.delay ? ` 延迟${eff.delay}s` : "";
      const duration = eff.duration != null ? ` 持续${eff.duration}s` : "";
      const chance = eff.chance != null && eff.chance < 1 ? ` ${Math.round(eff.chance * 100)}%概率` : "";
      return `${type}${skill}${value}${delay}${duration}${chance}`;
    })
    .join("\n");
}

/** 物品目标动作 → 中文 */
const OBJECTIVE_ACTIONS: Record<string, string> = {
  giveItem: "上交",
  findItem: "找到",
  plantItem: "放置",
  mark: "标记",
  useItem: "使用",
  sellItem: "出售",
  buildWeapon: "改装",
};

export interface NeedingTask {
  id: string;
  name: string;
  norm: string;
  action: string;
  count: number;
  foundInRaid: boolean;
}

/** 需求该物品的任务：扫描所有任务目标，items/item/markerItem 含该物品 id 的算需求 */
export function tasksNeedingItem(itemId: string, td: TaskData): NeedingTask[] {
  const out: NeedingTask[] = [];
  const seen = new Set<string>();
  for (const task of Object.values(td.tasks)) {
    for (const ob of task.objectives ?? []) {
      const matched =
        ob.items?.includes(itemId) || ob.item === itemId || ob.markerItem === itemId;
      if (!matched) continue;
      const action = OBJECTIVE_ACTIONS[ob.type ?? ""] ?? ob.type ?? "";
      const key = `${task.id}:${action}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: task.id,
        name: translate(task.name, td.tr),
        norm: task.normalizedName ?? "",
        action,
        count: ob.count ?? 1,
        foundInRaid: ob.foundInRaid ?? false,
      });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
