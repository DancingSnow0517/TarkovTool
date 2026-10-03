/** json.tarkov.dev 数据类型（仅声明项目实际使用的字段） */

export interface SellOffer {
  trader: string;
  price: number;
  priceRUB: number;
  currency: string;
}

/** 物品属性明细（propertiesType 区分武器/护甲/弹药等，字段按类型宽松读取） */
export interface ItemProperties {
  propertiesType?: string;
  [key: string]: unknown;
}

export interface Item {
  id: string;
  name: string;
  shortName?: string;
  normalizedName?: string;
  description?: string;
  link?: string;
  wikiLink?: string;
  weight?: number;
  width?: number;
  height?: number;
  types?: string[];
  properties?: ItemProperties | null;
  lastLowPrice?: number | null;
  avg24hPrice?: number | null;
  low24hPrice?: number | null;
  high24hPrice?: number | null;
  changeLast48hPercent?: number | null;
  lastOfferCount?: number | null;
  sellToTrader?: SellOffer[] | null;
  minLevelForFlea?: number | null;
  basePrice?: number | null;
  gridImageLink?: string | null;
}

/** 跳蚤市场价格历史点位（/{mode}/prices/{itemId}） */
export interface PricePoint {
  priceMin: number;
  price: number;
  offerCount: number;
  timestamp: number;
}

export interface Trader {
  name?: string;
  imageLink?: string;
}

export interface TaskZone {
  id: string;
  map: string;
}

export interface TaskPosition {
  x: number;
  y: number;
  z: number;
}

export interface TaskLocation {
  map: string;
  positions?: TaskPosition[];
}

export interface TaskObjective {
  description?: string;
  /** 目标动作类型：giveItem/findItem/plantItem/mark/useItem/sellItem/buildWeapon 等 */
  type?: string;
  count?: number;
  /** 目标涉及的物品 id 列表（giveItem/findItem 等） */
  items?: string[];
  /** 单个物品 id（buildWeapon 等） */
  item?: string;
  /** 标记动作使用的标记物 id（mark） */
  markerItem?: string;
  /** 是否要求战局内捡到 */
  foundInRaid?: boolean;
  optional?: boolean;
  zones?: TaskZone[] | null;
  questItem?: string | null;
  possibleLocations?: TaskLocation[] | null;
}

export interface TaskRequirement {
  task: string;
  status: string[];
}

export interface TaskRewardStanding {
  trader: string;
  standing: number;
}

export interface TaskRewardItem {
  item: string;
  count: number;
}

/** 任务完成奖励：商人好感 + 物品（金钱也以物品形式给出，按货币物品 id 区分） */
export interface TaskRewards {
  traderStanding?: TaskRewardStanding[];
  items?: TaskRewardItem[];
}

export interface Task {
  id: string;
  name: string;
  normalizedName?: string;
  trader?: string;
  map?: string | null;
  minPlayerLevel?: number | null;
  kappaRequired?: boolean;
  wikiLink?: string;
  taskImageLink?: string | null;
  /** 完成任务给的经验值 */
  experience?: number;
  objectives?: TaskObjective[];
  taskRequirements?: TaskRequirement[];
  finishRewards?: TaskRewards;
}

export interface GameMap {
  normalizedName?: string;
}

export type TranslationMap = Record<string, string>;

/** /{mode}/maps 中地图页标记相关字段（撤离点/转移/危险区） */
export interface ApiMapExtract {
  name: string;
  /** pmc / scav / shared（合作撤离点）；部分地图无阵营划分（按 PMC 处理） */
  faction?: string;
  position: TaskPosition;
  outline?: TaskPosition[];
  top?: number;
  bottom?: number;
}

export interface ApiMapTransit {
  /** 翻译键（如 FAC_TRANSIT_12_DESC），在 /{mode}/maps_{lang} 中查译文 */
  description: string;
  position: TaskPosition;
  outline?: TaskPosition[];
  top?: number;
  bottom?: number;
}

export interface ApiMapHazard {
  /** minefield / sniper / hazard（通用，不展示） */
  hazardType: string;
  /** 翻译键（如 DamageType_Landmine） */
  name: string;
  position: TaskPosition;
  outline?: TaskPosition[];
  top?: number;
  bottom?: number;
}

/** 裁剪后缓存的地图标记数据（key 为 API 地图 id） */
export interface ApiMapMarkers {
  extracts: ApiMapExtract[];
  transits: ApiMapTransit[];
  hazards: ApiMapHazard[];
}

/** /{mode}/maps 原始响应（只声明标记相关字段，其余字段裁剪时丢弃） */
export interface MapsApiResponse {
  data: {
    maps: Record<
      string,
      {
        extracts?: ApiMapExtract[];
        transits?: ApiMapTransit[];
        hazards?: ApiMapHazard[];
      }
    >;
  };
}

/** maps.json 中的地图定义（地图页使用） */
export interface MapLabel {
  position: [number, number];
  text: string;
  rotation?: number;
  size?: number;
  top?: number;
  bottom?: number;
}

export interface MapExtent {
  height?: [number, number];
  bounds?: [number, number][][];
}

export interface MapLayer {
  name: string;
  svgLayer?: string;
  tilePath?: string;
  extents?: MapExtent[];
}

export interface MapData {
  key: string;
  bounds: [[number, number], [number, number]];
  svgBounds?: [[number, number], [number, number]] | null;
  transform?: [number, number, number, number];
  coordinateRotation?: number;
  minZoom: number;
  maxZoom: number;
  tileSize?: number | null;
  svgPath?: string | null;
  tilePath?: string | null;
  svgLayer?: string;
  heightRange?: [number, number];
  apiIds: string[];
  labels?: MapLabel[];
  layers?: MapLayer[];
}
