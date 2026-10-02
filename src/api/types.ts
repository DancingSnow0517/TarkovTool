/** json.tarkov.dev 数据类型（仅声明项目实际使用的字段） */

export interface SellOffer {
  trader: string;
  priceRUB: number;
}

export interface Item {
  id: string;
  name: string;
  normalizedName?: string;
  link?: string;
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

export interface Trader {
  name?: string;
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
