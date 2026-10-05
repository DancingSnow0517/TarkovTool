<script setup lang="ts">
/* 纯静态塔科夫任务地图：?map=<地图key>&q=<区域/任务物品id,逗号分隔>&task=<任务id>
 * 模式/语言跟随导航栏下拉框（config store），不从 URL 读取。
 * 坐标系/投影与楼层分层逻辑移植自 the-hideout/tarkov-dev (src/pages/map/index.jsx)，
 * 页面行为对齐 web/map.js。 */
import { computed, h, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { LocationQuery, LocationQueryValue } from "vue-router";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useMessage } from "naive-ui";
import { fetchCached, fetchCachedTrimmed } from "@/api/client";
import { useConfigStore } from "@/stores/config";
import { useDataStore } from "@/stores/data";
import { useTrackStore } from "@/stores/track";
import type { TrackPoint } from "@/stores/track";
import { useRaidLogStore } from "@/stores/raidLog";
import { useSyncStore } from "@/stores/sync";
import { useMapTasksStore } from "@/stores/mapTasks";
import SyncModal from "@/components/SyncModal.vue";
import { MARKER_CATS, MARKER_GROUPS, SEASON_FILES_BY_ID, SEASON_FILE_IDS } from "@/utils/markers";
import { pinyinIndex } from "@/utils/pinyin";
import type {
  ApiMapMarkers,
  MapData,
  MapExtent,
  MapLayer,
  MapsApiResponse,
  MapsMarkersTrimmed,
  TaskLocation,
  TaskPosition,
  TranslationMap,
} from "@/api/types";

const route = useRoute();
const router = useRouter();
const config = useConfigStore();
const data = useDataStore();
const track = useTrackStore();
const raid = useRaidLogStore();
const sync = useSyncStore();
const mapTasks = useMapTasksStore();
const message = useMessage();

const mapEl = ref<HTMLDivElement>();
const floorPanelEl = ref<HTMLDivElement>();
const objPanelEl = ref<HTMLDivElement>();
const markerPanelEl = ref<HTMLDivElement>();
const styleSelectEl = ref<HTMLSelectElement>();
const status = ref("加载中 ...");
const zoomInfo = ref("");
const raidTime = ref("");
/** 指针（鼠标/触摸）位置的游戏坐标文本 "x, z" */
const cursorPos = ref("");
const syncModal = ref(false);

/** 接收模式：URL 带 ?sync=<id> 时作为移动端接收 PC 位置同步 */
const syncMode = computed(() => !!queryStr(route.query.sync));
const currentMapKey = computed(() => queryStr(route.query.map) || "customs");

const syncStatusText = computed(() => {
  switch (sync.clientStatus) {
    case "connecting":
      return "同步连接中 ...";
    case "connected":
      return "已同步";
    case "reconnecting":
      return "同步重连中 ...";
    default:
      return "";
  }
});

/** 断开同步：移除 URL 的 sync 参数，由 watcher 统一做拆连清理 */
function disconnectSync() {
  const query = { ...route.query };
  delete query.sync;
  void router.replace({ query });
}

/* ---- json.tarkov.dev 任务数据（仅声明地图页用到的字段） ---- */

interface ZoneDef {
  id: string;
  map: string;
  outline?: TaskPosition[];
  position: TaskPosition;
  size?: { x?: number; z?: number };
}

interface ObjectiveDef {
  id?: string;
  description?: string;
  zones?: ZoneDef[] | null;
  questItem?: string | null;
  possibleLocations?: TaskLocation[] | null;
}

interface TaskDef {
  id: string;
  name: string;
  normalizedName?: string;
  taskImageLink?: string | null;
  objectives?: ObjectiveDef[];
}

interface TasksResponse {
  data: { tasks: Record<string, TaskDef> };
}

interface TrResponse {
  data: TranslationMap;
}

interface ObjectiveEntry {
  task: TaskDef;
  ob: ObjectiveDef;
}

/* ---- Leaflet 图层上挂载的自定义字段 ---- */

interface LabelVis {
  fullBounded: MapLayer[];
  matched: MapLayer[];
  onBase: boolean;
}

type LabelMarker = L.Marker & { _vis: LabelVis };

type FocusLayer = (L.Path | L.FeatureGroup) & {
  _floor: MapLayer | null;
  _normal: L.PathOptions;
  _dim: L.PathOptions;
  _entries: ObjectiveEntry[];
  /** 任务列表绘制物记录所属任务 id（URL 聚焦绘制物为空） */
  _taskId?: string;
  // Path 基类类型未声明 getBounds；Polygon 自带，CircleMarker 由 circlePoint 补，多刷点组用 FeatureGroup（自带）
  getBounds(): L.LatLngBounds;
};

type FloorMatch = { type: "full" | "partial"; bounded: boolean } | false;

/** 地图上已绘制的一个标记：中心图标 + 常驻名称（仅撤离点组）+ 悬浮才显示的区域轮廓 */
interface MarkerRec {
  dot: L.Marker;
  outline?: L.Polygon;
  cat: string;
  vis: LabelVis;
  /** 所属楼层（按中心高度判定），点击跨层标记时切到该层 */
  floor: MapLayer | null;
  hovered: boolean;
}

/* 只有撤离点组在图标下方常驻名称文本 */
const EXTRACT_CATS = new Set(MARKER_GROUPS[0].children.map((c) => c.key));

/* 固定机炮的 id 不在 items 数据里，名称用固定映射（AGS-30 / NSV） */
const STATIONARY_NAMES: Record<string, string> = {
  "5cdeb229d7f00c000e7ce174": "AGS-30 自动榴弹发射器",
  "5d52cc5ba4b9367408500062": "NSV 重机枪",
};

interface XZ {
  x: number;
  z: number;
}

/* ---- 组件内地图状态（切换地图/样式时整体重置） ---- */

let map: L.Map | null = null;
let mapData: MapData | null = null;
let mapBounds: L.LatLngBounds | null = null;
let svgRoot: SVGElement | null = null; // 内联 SVG 的根节点（仅 SVG 底图）
let baseTileLayer: L.TileLayer | null = null; // 瓦片底图（仅瓦片底图）
let floorOverlay: L.TileLayer | null = null; // 当前楼层的瓦片叠加层
let activeFloor: MapLayer | null = null; // 当前楼层（null = 主层）
let focusLayers: FocusLayer[] = []; // 聚焦绘制物，_floor 记录所属楼层（含 URL 聚焦与任务列表两种来源）
let labelMarkers: LabelMarker[] = []; // 区域标签，_vis 记录楼层可见性
let markerRecs: MarkerRec[] = []; // 撤离点/危险区标记
let markerCounts: Record<string, number> = {}; // 各类别标记数量（面板只列出当前地图存在的类别）
let raidTimer: ReturnType<typeof setInterval> | null = null;

const setStatus = (msg: string) => {
  status.value = msg;
};

const queryStr = (v: LocationQueryValue | LocationQueryValue[] | undefined): string =>
  (Array.isArray(v) ? v[0] : v) ?? "";

/* ---- 游戏内时间（移植自 tarkov-dev src/components/Time.jsx） ---- */

function tarkovTime(left: boolean): string {
  // 现实 1 秒 = 游戏 7 秒；游戏零点不对齐 unix 0，而是对齐莫斯科时区（UTC+3）。
  // 左/右两个战局时间相差 12 小时
  const hrs = (n: number) => n * 3600 * 1000;
  const t = (hrs(3) + (left ? 0 : hrs(12)) + Date.now() * 7) % hrs(24);
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function startRaidTime(mapKey: string) {
  // 工厂/夜间工厂时间固定；实验室只有一个时间段
  if (mapKey === "factory") {
    raidTime.value = "15:28:00 / 03:28:00";
    return;
  }
  const update = () => {
    raidTime.value =
      mapKey === "the-lab" ? tarkovTime(true) : `${tarkovTime(true)} / ${tarkovTime(false)}`;
  };
  update();
  raidTimer = setInterval(update, 100);
}

/* ---- 坐标系（移植自 tarkov-dev） ---- */

function applyRotation(latLng: L.LatLng, rotation?: number): L.LatLng {
  if (!latLng.lng && !latLng.lat) return L.latLng(0, 0);
  if (!rotation) return latLng;
  const angle = (rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const { lng: x, lat: y } = latLng;
  return L.latLng(x * sin + y * cos, x * cos - y * sin);
}

function getCRS(md: MapData): L.CRS {
  let scaleX = 1,
    scaleY = 1,
    marginX = 0,
    marginY = 0;
  if (md.transform) {
    scaleX = md.transform[0];
    scaleY = md.transform[2] * -1;
    marginX = md.transform[1];
    marginY = md.transform[3];
  }
  return L.extend({}, L.CRS.Simple, {
    transformation: new L.Transformation(scaleX, marginX, scaleY, marginY),
    projection: L.extend({}, L.Projection.LonLat, {
      project: (latLng: L.LatLng) =>
        L.Projection.LonLat.project(applyRotation(latLng, md.coordinateRotation)),
      unproject: (point: L.Point) =>
        applyRotation(L.Projection.LonLat.unproject(point), (md.coordinateRotation ?? 0) * -1),
    }),
  }) as L.CRS;
}

function pos(position: XZ): [number, number] {
  return [position.z, position.x];
}

function getBounds(bounds: [[number, number], [number, number]]): L.LatLngBounds {
  return L.latLngBounds([bounds[0][1], bounds[0][0]], [bounds[1][1], bounds[1][0]]);
}

function getScaledBounds(
  bounds: [[number, number], [number, number]],
  scale: number,
): [number, number][] {
  const cx = (bounds[0][0] + bounds[1][0]) / 2;
  const cy = (bounds[0][1] + bounds[1][1]) / 2;
  const w = (bounds[1][0] - bounds[0][0]) * scale;
  const h = (bounds[1][1] - bounds[0][1]) * scale;
  return [
    [cy - h / 2, cx - w / 2],
    [cy + h / 2, cx + w / 2],
  ];
}

/* ---- 楼层状态 ---- */

function inExtentBounds(boundsEntry: [number, number][], position: XZ): boolean {
  // bounds 条目是游戏坐标的对角点 [[x, z], [x, z], 名称?]
  const [c1, c2] = boundsEntry;
  return (
    position.x >= Math.min(c1[0], c2[0]) &&
    position.x <= Math.max(c1[0], c2[0]) &&
    position.z >= Math.min(c1[1], c2[1]) &&
    position.z <= Math.max(c1[1], c2[1])
  );
}

function floorMatch(
  top: number,
  bottom: number,
  position: XZ,
  extents: MapExtent[] | undefined,
): FloorMatch {
  // 移植自 tarkov-dev markerIsOnLayer：高度重叠 + 水平 bounds 包含
  // 返回 {type: "full"|"partial", bounded: 匹配的 extent 是否带水平 bounds}，不匹配返回 false
  for (const ext of extents || []) {
    const [lo, hi] = ext.height || [-Infinity, Infinity];
    if (top >= lo && bottom < hi) {
      const full = bottom >= lo && top <= hi;
      if (ext.bounds) {
        for (const b of ext.bounds) {
          if (inExtentBounds(b, position)) return { type: full ? "full" : "partial", bounded: true };
        }
      } else {
        return { type: full ? "full" : "partial", bounded: false };
      }
    }
  }
  return false;
}

function layerForZone(position: TaskPosition): MapLayer | null {
  // 楼层归属按触发区域中心高度（position.y）判定：
  // 大体积触发区的 top/bottom 常横跨多层（部分重叠会误判），中心高度才是实际所在层
  for (const layer of mapData?.layers || []) {
    if (floorMatch(position.y, position.y, position, layer.extents)) return layer;
  }
  return null;
}

function labelVisibility(top: number, bottom: number, position: XZ): LabelVis {
  // 移植自 tarkov-dev markerIsOnActiveLayer 的标签可见性判定：
  // fullBounded: 完全落在该层（匹配 extent 带水平 bounds）→ 该层未激活时隐藏
  // matched: 与该层高度/bounds 有重叠 → 该层激活时显示
  // onBase: 高度落在主层 heightRange 内 → 主层视图显示
  const fullBounded: MapLayer[] = [],
    matched: MapLayer[] = [];
  for (const layer of mapData?.layers || []) {
    const m = floorMatch(top, bottom, position, layer.extents);
    if (!m) continue;
    matched.push(layer);
    if (m.type === "full" && m.bounded) fullBounded.push(layer);
  }
  const hr = mapData?.heightRange || [-Infinity, Infinity];
  const onBase = top >= hr[0] && bottom < hr[1];
  return { fullBounded, matched, onBase };
}

function labelVisible(v: LabelVis, layer: MapLayer | null): boolean {
  for (const l of v.fullBounded) if (l !== layer) return false;
  return layer ? v.matched.includes(layer) : v.onBase;
}

function setFloor(layer: MapLayer | null) {
  if (!map || !mapData) return;
  activeFloor = layer;
  // SVG 底图：切换楼层分组显隐，非主层时基底分组调暗（样式移植自 tarkov-dev）
  if (svgRoot) {
    const svgEl = svgRoot.parentElement;
    svgEl?.classList.toggle("off-level", !!layer);
    const activeId = layer ? layer.svgLayer : mapData.svgLayer;
    for (const g of Array.from(svgRoot.children)) {
      if (g.nodeName !== "g" || !g.id || g.classList.contains("base-layer")) continue;
      const show =
        g.id === activeId ||
        (!!activeId && (g as SVGElement).dataset.keepWithGroup === activeId);
      g.classList.toggle("hidden-layer", !show);
    }
  }
  // 楼层瓦片叠加：SVG 分组覆盖不到的楼层（无 svgLayer）或瓦片底图
  if (floorOverlay) {
    floorOverlay.remove();
    floorOverlay = null;
  }
  if (layer && layer.tilePath && !(svgRoot && layer.svgLayer)) {
    floorOverlay = L.tileLayer(layer.tilePath, {
      tileSize: mapData.tileSize || 256,
      bounds: mapBounds ?? undefined,
      maxZoom: Math.max(7, mapData.maxZoom),
      maxNativeZoom: mapData.maxZoom,
    }).addTo(map);
  }
  // 瓦片底图在非主层时调暗
  if (baseTileLayer) {
    const container = baseTileLayer.getContainer();
    if (container) container.classList.toggle("off-level", !!layer);
  }
  // 标签可见性（同官方 markerIsOnActiveLayer + off-level 标签 display:none）：
  // 完全落在未激活楼层内的一律隐藏；选中楼层时只显示与该层重叠的标签；主层只显示主层高度内的
  for (const m of labelMarkers) {
    const el = m.getElement();
    if (el) el.style.display = labelVisible(m._vis, layer) ? "" : "none";
  }
  // 非当前楼层的聚焦绘制物调暗
  for (const l of focusLayers) {
    const onFloor = (l._floor || null) === layer;
    l.setStyle(onFloor ? l._normal : l._dim);
  }
  // 标记（撤离点/危险区）按楼层 + 勾选状态显隐
  updateMarkers();
  // 面板选中态（跳过头部行，只匹配楼层行）
  const panel = floorPanelEl.value;
  if (panel) {
    Array.from(panel.querySelectorAll(".floor-item")).forEach((el, i) =>
      el.classList.toggle("active", mapData!.layers![i] === layer),
    );
  }
}

/* ---- 地图底层 ---- */

async function addSvgLayer(md: MapData, bounds: L.LatLngBounds) {
  const svgElement = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svgElement.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const text = await (await fetch(import.meta.env.BASE_URL + md.svgPath)).text();
  svgElement.innerHTML = text;
  svgRoot = svgElement.children[0] as SVGElement;
  svgElement.setAttribute("viewBox", String(svgRoot.getAttribute("viewBox")));
  // 顶层 g 节点里只保留本图基准楼层，其余隐藏
  for (const g of Array.from(svgRoot.children).filter((c) => c.nodeName === "g" && c.id)) {
    if (g.id === md.svgLayer || (g as SVGElement).dataset["keepWithGroup"] === md.svgLayer) {
      g.classList.add("base-layer");
    } else {
      g.classList.add("hidden-layer", "overlay-layer");
    }
  }
  const svgBounds = md.svgBounds ? getBounds(md.svgBounds) : bounds;
  L.svgOverlay(svgElement, svgBounds, { className: "base-layer" }).addTo(map!);
}

function addTileLayer(md: MapData, bounds: L.LatLngBounds) {
  baseTileLayer = L.tileLayer(md.tilePath!, {
    tileSize: md.tileSize || 256,
    bounds,
    maxZoom: Math.max(7, md.maxZoom),
    maxNativeZoom: md.maxZoom,
  }).addTo(map!);
}

function addLabels(md: MapData) {
  if (!md.labels || !md.labels.length) return;
  for (const label of md.labels) {
    const top = label.top ?? 1000;
    const bottom = label.bottom ?? -1000;
    const position: XZ = { x: label.position[0], z: label.position[1] };
    const marker = L.marker(pos(position), {
      icon: L.divIcon({
        html: `<div class="label" style="font-size: ${label.size || 100}%; transform: translate3d(-50%, -50%, 0) rotate(${label.rotation || 0}deg)">${label.text}</div>`,
        className: "map-area-label",
      }),
      interactive: false,
      zIndexOffset: -100000,
    }).addTo(map!) as LabelMarker;
    marker._vis = labelVisibility(top, bottom, position);
    labelMarkers.push(marker);
  }
}

/* ---- 地图标记（撤离点/危险区） ---- */

function catEnabled(key: string): boolean {
  return config.mapMarkersOff === null || !config.mapMarkersOff.has(key);
}

function drawMapMarkers(
  api: ApiMapMarkers,
  containerDefs: Record<string, string>,
  tr: TranslationMap,
  itemTr: TranslationMap,
) {
  const add = (
    catKey: string,
    title: string,
    sub: string,
    position: TaskPosition,
    outline?: TaskPosition[],
    top?: number,
    bottom?: number,
  ) => {
    const cat = MARKER_CATS.get(catKey)!;
    const iconUrl =
      cat.iconUrl ?? import.meta.env.BASE_URL + "assets/interactive/" + (cat.icon ?? "");
    const rec: MarkerRec = {
      dot: L.marker(pos(position), {
        icon: L.icon({
          iconUrl,
          iconSize: [26, 26],
          iconAnchor: [13, 13],
        }),
      }).addTo(map!),
      cat: catKey,
      vis: labelVisibility(top ?? 1000, bottom ?? -1000, position),
      floor: layerForZone(position),
      hovered: false,
    };
    // 点击跨层（半透明）标记时切到它所在的楼层
    rec.dot.on("click", () => {
      if (rec.floor !== activeFloor) setFloor(rec.floor);
    });
    // closeOnClick:false：点击会冒泡到地图，默认行为会把刚打开的气泡又关掉；
    // 改由地图点击处理器统一判定（点在标记外才关）
    rec.dot.bindPopup(`<b>${title}</b>${sub ? `<br>${sub}` : ""}`, { closeOnClick: false });
    // 撤离点组：图标下方常驻名称文本
    if (EXTRACT_CATS.has(catKey)) {
      rec.dot.bindTooltip(title, {
        permanent: true,
        direction: "bottom",
        offset: [0, 14],
        className: "mk-name",
        interactive: false,
      });
    }
    // 区域轮廓默认隐藏，悬浮图标时显示
    if (outline && outline.length >= 3) {
      rec.outline = L.polygon(outline.map(pos), {
        color: cat.color,
        weight: 2,
        fillColor: cat.color,
        fillOpacity: 0.12,
        interactive: false,
      }).addTo(map!);
      rec.dot.on("mouseover", () => {
        rec.hovered = true;
        refreshOutline(rec);
      });
      rec.dot.on("mouseout", () => {
        rec.hovered = false;
        refreshOutline(rec);
      });
    }
    markerRecs.push(rec);
    markerCounts[catKey] = (markerCounts[catKey] ?? 0) + 1;
  };
  for (const e of api.extracts) {
    // 无阵营字段的地图（工厂/中心区21+）只有 PMC 一种撤离点；
    // shared 是 PMC/Scav 都能用的共享撤离点（真正的合作撤离点译文里自含"合作"字样）
    const catKey =
      e.faction === "scav" ? "scav-extract" : e.faction === "shared" ? "coop-extract" : "pmc-extract";
    add(catKey, tr[e.name] || e.name, `<i>${MARKER_CATS.get(catKey)!.label}</i>`, e.position, e.outline, e.top, e.bottom);
  }
  for (const t of api.transits) {
    add("transit", tr[t.description] || t.description, "<i>转移</i>", t.position, t.outline, t.top, t.bottom);
  }
  for (const h of api.hazards) {
    // 通用 hazard（迷宫陷阱）不在面板类别内，不展示
    if (h.hazardType !== "minefield" && h.hazardType !== "sniper") continue;
    add(h.hazardType, tr[h.name] || h.name, "", h.position, h.outline, h.top, h.bottom);
  }
  for (const l of api.locks) {
    const keyName = itemTr[`${l.key} Name`] || l.key;
    const kind = l.lockType === "trunk" ? "上锁的后备箱" : "上锁的门";
    // 门只有位置点，按所在高度判定楼层
    add("locked-door", kind, `钥匙: ${keyName}`, l.position, undefined, l.position.y, l.position.y);
  }
  for (const s of api.stationaryWeapons) {
    const name = STATIONARY_NAMES[s.stationaryWeapon] || s.stationaryWeapon;
    add("stationary-weapon", name, "<i>固定机炮</i>", s.position, undefined, s.position.y, s.position.y);
  }
  for (const s of api.switches) {
    add("switch", tr[s.name] || s.name, "<i>开关</i>", s.position, s.outline, s.top, s.bottom);
  }
  for (const c of api.lootContainers) {
    // 类别按 normalizedName 归并（同译名不同 id 的容器共用勾选项与图标）
    const norm = containerDefs[c.lootContainer];
    if (!norm || !MARKER_CATS.has(norm)) continue;
    const name = tr[`${c.lootContainer} Name`] || norm;
    add(norm, name, "<i>搜刮容器</i>", c.position, undefined, c.position.y, c.position.y);
  }
  for (const spot of api.seasonFiles) {
    spot.files.forEach((fid, idx) => {
      const file = SEASON_FILES_BY_ID.get(fid);
      if (!file) return;
      // 同一点位刷多种文件时横向错开一点，避免图标完全重叠点不到
      const position =
        idx === 0 ? spot.position : { ...spot.position, x: spot.position.x + idx * 0.8 };
      add(file.key, itemTr[`${fid} Name`] || file.label, "<i>赛季文件</i>", position, undefined, position.y, position.y);
    });
  }
}

/** 轮廓只在悬浮且类别启用时显示 */
function refreshOutline(rec: MarkerRec) {
  const el = rec.outline?.getElement() as SVGElement | undefined;
  if (el) el.style.display = rec.hovered && catEnabled(rec.cat) ? "" : "none";
}

/** 图标/常驻文本/轮廓三件套的整体透明度（跨层标记半透明） */
function setRecOpacity(rec: MarkerRec, opacity: string) {
  const dotEl = rec.dot.getElement();
  if (dotEl) dotEl.style.opacity = opacity;
  const tipEl = rec.dot.getTooltip()?.getElement();
  if (tipEl) tipEl.style.opacity = opacity;
  const outEl = rec.outline?.getElement() as SVGElement | undefined;
  if (outEl) outEl.style.opacity = opacity;
}

/** 关闭标记气泡：Leaflet 的 closePopup 只认"当前"气泡（多个气泡同开时其余关不掉），直接按层移除 */
function closeMarkerPopup(dot: L.Marker) {
  const popup = dot.getPopup();
  if (popup && popup.isOpen()) map!.removeLayer(popup);
}

/** 类别未勾选 → 隐藏；勾选但不在当前楼层 → 半透明；否则正常显示 */
function updateMarkers() {
  for (const rec of markerRecs) {
    const enabled = catEnabled(rec.cat);
    const dim = enabled && !labelVisible(rec.vis, activeFloor);
    if (!enabled) closeMarkerPopup(rec.dot);
    const dotEl = rec.dot.getElement();
    if (dotEl) dotEl.style.display = enabled ? "" : "none";
    const tipEl = rec.dot.getTooltip()?.getElement();
    if (tipEl) tipEl.style.display = enabled ? "" : "none";
    setRecOpacity(rec, dim ? "0.3" : "");
    refreshOutline(rec);
  }
}

/** 点击位置是否命中图标标记（图标 26px，给一点余量） */
function markerHit(dot: L.Marker, latlng: L.LatLng): boolean {
  const d = map!.latLngToLayerPoint(dot.getLatLng()).distanceTo(map!.latLngToLayerPoint(latlng));
  return d <= 16;
}

/** 勾选变更：合并当前状态写回 store（持久化），重建面板并刷新显隐 */
function commitMarkers(changes: (readonly [string, boolean])[]) {
  const enabled = MARKER_GROUPS.flatMap((g) => g.children)
    .filter((c) => {
      const change = changes.find(([k]) => k === c.key);
      return change ? change[1] : catEnabled(c.key);
    })
    .map((c) => c.key);
  config.setMapMarkers(enabled);
  buildMarkerPanel();
  updateMarkers();
}

/** 标记面板收起状态：窄屏（手机）默认收起，点击标题切换；跨地图重建保持 */
let markerCollapsed = window.innerWidth <= 768;

/** 楼层面板收起状态：同标记面板 */
let floorCollapsed = window.innerWidth <= 768;

/** 目标列表面板收起状态：同楼层面板 */
let objCollapsed = window.innerWidth <= 768;

/** 窄屏下点击面板外区域自动收起展开的面板（捕获阶段监听，避免地图拦截事件） */
function collapsePanelsOnOutsideClick(e: MouseEvent) {
  if (window.innerWidth > 768) return;
  const target = e.target as Node;
  const floorPanel = floorPanelEl.value;
  if (floorPanel && !floorPanel.hidden && !floorCollapsed && !floorPanel.contains(target)) {
    floorCollapsed = true;
    floorPanel.classList.add("collapsed");
    const toggle = floorPanel.querySelector(".floor-toggle");
    if (toggle) toggle.textContent = "▶";
  }
  const objPanel = objPanelEl.value;
  if (objPanel && !objPanel.hidden && !objCollapsed && !objPanel.contains(target)) {
    objCollapsed = true;
    objPanel.classList.add("collapsed");
    const toggle = objPanel.querySelector(".obj-toggle");
    if (toggle) toggle.textContent = "▶";
  }
  const markerPanel = markerPanelEl.value;
  if (markerPanel && !markerPanel.hidden && !markerCollapsed && !markerPanel.contains(target)) {
    markerCollapsed = true;
    markerPanel.classList.add("collapsed");
    const toggle = markerPanel.querySelector(".mk-toggle");
    if (toggle) toggle.textContent = "▶";
  }
}

/** 分组勾选面板：组行三态（全选/部分/全不选），子项缩进；只列出当前地图存在的类别 */
function buildMarkerPanel() {
  const panel = markerPanelEl.value!;
  panel.innerHTML = "";
  let any = false;
  const title = document.createElement("div");
  title.className = "mk-title";
  const titleText = document.createElement("span");
  titleText.textContent = "标记";
  const toggle = document.createElement("span");
  toggle.className = "mk-toggle";
  title.appendChild(titleText);
  title.appendChild(toggle);
  title.onclick = () => {
    markerCollapsed = !markerCollapsed;
    panel.classList.toggle("collapsed", markerCollapsed);
    syncToggle();
  };
  function syncToggle() {
    toggle.textContent = markerCollapsed ? "▶" : "▾";
  }
  syncToggle();
  panel.appendChild(title);
  const body = document.createElement("div");
  body.className = "mk-body";
  panel.appendChild(body);
  for (const group of MARKER_GROUPS) {
    const present = group.children.filter((c) => markerCounts[c.key]);
    if (!present.length) continue;
    any = true;
    const enabledCount = present.filter((c) => catEnabled(c.key)).length;
    const groupRow = document.createElement("label");
    groupRow.className = "mk-row mk-group-row";
    const groupBox = document.createElement("input");
    groupBox.type = "checkbox";
    groupBox.checked = enabledCount === present.length;
    groupBox.indeterminate = enabledCount > 0 && enabledCount < present.length;
    // 全选态点击 → 全不选；未全选/部分选 → 全选
    groupBox.onchange = () =>
      commitMarkers(present.map((c) => [c.key, enabledCount < present.length] as const));
    groupRow.appendChild(groupBox);
    groupRow.appendChild(document.createTextNode(group.label));
    body.appendChild(groupRow);
    for (const cat of present) {
      const row = document.createElement("label");
      row.className = "mk-row mk-child-row";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = catEnabled(cat.key);
      box.onchange = () => commitMarkers([[cat.key, box.checked]]);
      const swatch = document.createElement("img");
      swatch.className = "mk-swatch";
      swatch.src = cat.iconUrl ?? import.meta.env.BASE_URL + "assets/interactive/" + (cat.icon ?? "");
      swatch.alt = "";
      swatch.loading = "lazy";
      row.appendChild(box);
      row.appendChild(swatch);
      row.appendChild(document.createTextNode(cat.label));
      body.appendChild(row);
    }
  }
  panel.classList.toggle("collapsed", markerCollapsed);
  panel.hidden = !any;
}

/* ---- 任务目标定位 ---- */

function zoneLatLngs(zone: ZoneDef): [number, number][] {
  if (zone.outline && zone.outline.length) return zone.outline.map(pos);
  // 无轮廓时用 position + size 画矩形
  const { x, z } = zone.position;
  const sx = ((zone.size && zone.size.x) ?? 0) / 2 || 3;
  const sz = ((zone.size && zone.size.z) ?? 0) / 2 || 3;
  return [
    [z - sz, x - sx],
    [z - sz, x + sx],
    [z + sz, x + sx],
    [z + sz, x - sx],
  ];
}

function entryBodies(entries: ObjectiveEntry[], tr: TranslationMap): string[] {
  // 一个点位可能被多个任务/目标复用，逐条列出；
  // 不同目标译文相同时（如"找到"+"标记"译成同一句）只显示一次
  const bodies: string[] = [];
  for (const { task, ob } of entries) {
    const name = tr[task.name] || task.normalizedName || task.name;
    const desc = tr[ob.description ?? ""] || ob.description || "";
    const s = `<b>${name}</b><br>${desc}`;
    if (!bodies.includes(s)) bodies.push(s);
  }
  return bodies;
}

function popupHtml(entries: ObjectiveEntry[], tr: TranslationMap, floor: MapLayer | null): string {
  const floorLine = floor ? `<br><i>楼层: ${floor.name}</i>` : "";
  return entryBodies(entries, tr).join("<hr>") + floorLine;
}

function trackFocus(
  layer: L.Path | L.FeatureGroup,
  floor: MapLayer | null,
  normal: L.PathOptions,
  dim: L.PathOptions,
): FocusLayer {
  const fl = layer as FocusLayer;
  fl._floor = floor;
  fl._normal = normal;
  fl._dim = dim;
  focusLayers.push(fl);
  return fl;
}

/** 任务物品刷点（红色圆点）。CircleMarker 没有 getBounds，补一个单点 bounds（聚焦/自适应要用） */
function circlePoint(p: TaskPosition): L.CircleMarker {
  const m = L.circleMarker(pos(p), {
    radius: 6,
    color: "#ff5252",
    weight: 2,
    fillColor: "#ff5252",
    fillOpacity: 0.8,
  });
  (m as L.CircleMarker & { getBounds(): L.LatLngBounds }).getBounds = () =>
    L.latLngBounds([m.getLatLng()]);
  return m;
}

function ringContains(ring: L.LatLng[], latlng: L.LatLng): boolean {
  // 射线法判断点是否在多边形内（平面坐标足够精确）
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].lng,
      yi = ring[i].lat;
    const xj = ring[j].lng,
      yj = ring[j].lat;
    if (
      yi > latlng.lat !== yj > latlng.lat &&
      latlng.lng < ((xj - xi) * (latlng.lat - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function layerContainsPoint(layer: L.Path | L.FeatureGroup, latlng: L.LatLng): boolean {
  if (layer instanceof L.FeatureGroup) {
    return layer.getLayers().some((l) => layerContainsPoint(l as L.Path, latlng));
  }
  if (layer instanceof L.CircleMarker) {
    const d = map!
      .latLngToLayerPoint(layer.getLatLng())
      .distanceTo(map!.latLngToLayerPoint(latlng));
    return d <= layer.getRadius() + 4;
  }
  const ring = (layer as L.Polygon).getLatLngs()[0] as unknown as L.LatLng[];
  return ringContains(ring, latlng);
}

/** 聚焦图层上实际绑了气泡的对象：多刷点组（FeatureGroup）展开为各刷点，其余为图层自身 */
function popupTargets(layer: FocusLayer): L.Layer[] {
  return layer instanceof L.FeatureGroup ? layer.getLayers() : [layer as L.Layer];
}

/** 关闭全部聚焦图层的气泡（含多刷点组的子刷点） */
function closeAllFocusPopups() {
  for (const l of focusLayers) for (const t of popupTargets(l)) t.closePopup();
}

/** 弹出一组聚焦图层的气泡；与其他目标的气泡互相遮挡的只保留先打开的，
 * 同组多刷点之间不去重（每个刷点都显示气泡） */
function openLayerPopups(layers: FocusLayer[]) {
  const keptRects: DOMRect[] = [];
  for (const layer of layers) {
    const ownRects: DOMRect[] = [];
    for (const t of popupTargets(layer)) {
      const popup = t.getPopup();
      if (!popup) continue;
      t.openPopup();
      const el = popup.getElement();
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const overlap = keptRects.some(
        (k) => !(r.right < k.left || r.left > k.right || r.bottom < k.top || r.top > k.bottom),
      );
      if (overlap) t.closePopup();
      else ownRects.push(r);
    }
    keptRects.push(...ownRects);
  }
}

function bindFocusPopup(
  layer: FocusLayer,
  entries: ObjectiveEntry[],
  tr: TranslationMap,
  floor: MapLayer | null,
) {
  // autoClose/closeOnClick:false:初始自动展开的多点气泡保持同时可见;
  // autoPan:false:打开气泡不拖动地图,保持按全部点位自适应的视图
  layer.bindPopup(popupHtml(entries, tr, floor), {
    autoClose: false,
    closeOnClick: false,
    autoPan: false,
  });
  layer._entries = entries;
  // 接管点击（去掉 bindPopup 默认的点击弹出）：
  // 同一位置叠了多个目标时，点击在它们之间循环切换（气泡 + 楼层）
  layer.off("click");
  layer.on("click", (e: L.LeafletMouseEvent) => {
    const stack = focusLayers.filter((l) => l.getPopup() && layerContainsPoint(l, e.latlng));
    const openIdx = stack.findIndex((l) => l.isPopupOpen());
    const next = openIdx >= 0 ? stack[(openIdx + 1) % stack.length] : layer;
    closeAllFocusPopups();
    next.openPopup();
    setFloor(next._floor || null);
  });
}

/* ---- 目标列表面板 ---- */

function focusObjective(layer: FocusLayer, row: HTMLElement) {
  // 单聚焦一个目标：切到所在楼层、缩放到该目标（多刷点自适应到全部刷点）并弹出气泡
  objPanelEl.value
    ?.querySelectorAll(".obj-item.active")
    .forEach((el) => el.classList.remove("active"));
  row.classList.add("active");
  closeAllFocusPopups();
  setFloor(layer._floor || null);
  map!.fitBounds(layer.getBounds().pad(0.5), { maxZoom: mapData!.maxZoom, animate: false });
  openLayerPopups([layer]);
}

function buildObjectiveList(tr: TranslationMap) {
  const objPanel = objPanelEl.value;
  if (!objPanel) return;
  objPanel.innerHTML = "";
  if (!focusLayers.length) {
    objPanel.hidden = true;
    return;
  }
  // 头部标题行：点击收起/展开（窄屏默认收起，跨地图重建保持状态）
  const head = document.createElement("div");
  head.className = "obj-head";
  const headLabel = document.createElement("span");
  headLabel.textContent = `目标 (${focusLayers.length})`;
  const headToggle = document.createElement("span");
  headToggle.className = "obj-toggle";
  const syncToggle = () => {
    headToggle.textContent = objCollapsed ? "▶" : "▾";
  };
  head.onclick = () => {
    objCollapsed = !objCollapsed;
    objPanel.classList.toggle("collapsed", objCollapsed);
    syncToggle();
  };
  syncToggle();
  head.append(headLabel, headToggle);
  objPanel.appendChild(head);
  objPanel.classList.toggle("collapsed", objCollapsed);
  for (const layer of focusLayers) {
    const row = document.createElement("div");
    row.className = "obj-item";
    // 完成勾选：同一绘制点位可能叠多个目标，一起勾选/取消（半选态）
    const obIds = layer._entries.map((e) => e.ob.id).filter((x): x is string => !!x);
    const doneCount = obIds.filter((id) => mapTasks.done.includes(id)).length;
    const allDone = obIds.length > 0 && doneCount === obIds.length;
    if (allDone) row.classList.add("done");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = allDone;
    cb.indeterminate = doneCount > 0 && !allDone;
    cb.title = "标记完成";
    cb.onclick = (e) => {
      e.stopPropagation();
      mapTasks.setDone(obIds, !allDone);
    };
    row.appendChild(cb);
    const body = document.createElement("div");
    body.className = "obj-body";
    body.innerHTML = entryBodies(layer._entries, tr).join("<hr>");
    row.appendChild(body);
    // 任务列表来源的行：✕ 从列表移除该任务（URL 聚焦的行不显示）
    if (layer._taskId) {
      const rm = document.createElement("span");
      rm.className = "obj-remove";
      rm.textContent = "✕";
      rm.title = "从任务列表移除";
      rm.onclick = (e) => {
        e.stopPropagation();
        mapTasks.remove(layer._taskId!);
      };
      row.appendChild(rm);
    }
    row.onclick = () => focusObjective(layer, row);
    objPanel.appendChild(row);
  }
  objPanel.hidden = false;
}

function findAndDraw(
  tasksData: TasksResponse["data"],
  tr: TranslationMap,
): { missing: string[]; layers: FocusLayer[] } {
  const missing: string[] = [];
  const drawnFrom = focusLayers.length;
  const zoneHits = new Map<string, { zone: ZoneDef; entries: ObjectiveEntry[] }>(); // zone.id -> 跨任务去重
  const itemHits = new Map<string, { p: TaskPosition; entries: ObjectiveEntry[] }>(); // "x,z" -> 点位
  for (const qid of qIds) {
    let found = false;
    for (const task of Object.values(tasksData.tasks)) {
      if (taskParam && task.id !== taskParam) continue;
      for (const ob of task.objectives || []) {
        for (const zone of ob.zones || []) {
          if (zone.id !== qid || !mapData!.apiIds.includes(zone.map)) continue;
          found = true;
          if (!zoneHits.has(zone.id)) zoneHits.set(zone.id, { zone, entries: [] });
          zoneHits.get(zone.id)!.entries.push({ task, ob });
        }
        if (ob.questItem === qid) {
          for (const loc of ob.possibleLocations || []) {
            if (!mapData!.apiIds.includes(loc.map)) continue;
            for (const p of loc.positions || []) {
              found = true;
              const k = `${p.x},${p.z}`;
              if (!itemHits.has(k)) itemHits.set(k, { p, entries: [] });
              itemHits.get(k)!.entries.push({ task, ob });
            }
          }
        }
      }
    }
    if (!found) missing.push(qid);
  }
  for (const { zone, entries } of zoneHits.values()) {
    const floor = layerForZone(zone.position);
    const poly = L.polygon(zoneLatLngs(zone), {
      color: "#ffd54a",
      weight: 3,
      fillColor: "#ffd54a",
      fillOpacity: 0.15,
      className: "zone-focus",
    }).addTo(map!);
    bindFocusPopup(trackFocus(poly, floor, { opacity: 1, fillOpacity: 0.15 }, { opacity: 0.15, fillOpacity: 0.03 }), entries, tr, floor);
  }
  for (const { p, entries } of itemHits.values()) {
    const floor = layerForZone(p);
    const marker = circlePoint(p).addTo(map!);
    bindFocusPopup(trackFocus(marker, floor, { opacity: 1, fillOpacity: 0.8 }, { opacity: 0.15, fillOpacity: 0.1 }), entries, tr, floor);
  }
  return { missing, layers: focusLayers.slice(drawnFrom) };
}

/* ---- 任务搜索 / 任务列表 ---- */

/** 任务数据按 模式+语言 缓存（fetchCached 本身有 localStorage 缓存，这里是内存索引） */
let taskCacheKey = "";
let taskById = new Map<string, TaskDef>();
let taskTr: TranslationMap = {};
interface TaskSearchEntry {
  id: string;
  label: string;
  en: string;
  norm: string;
  py: string;
  pya: string;
  img: string;
}
let taskSearchIndex: TaskSearchEntry[] = [];

async function ensureTaskData() {
  const key = `${config.mode}:${config.lang}`;
  if (taskCacheKey === key) return;
  const tasksData = (await fetchCached<TasksResponse>(`/${config.mode}/tasks`)).data;
  const tr = (await fetchCached<TrResponse>(`/${config.mode}/tasks_${config.lang}`)).data;
  const en =
    config.lang === "en"
      ? tr
      : (await fetchCached<TrResponse>(`/${config.mode}/tasks_en`)).data;
  taskById = new Map(Object.values(tasksData.tasks).map((t) => [t.id, t]));
  taskTr = tr;
  taskSearchIndex = Object.values(tasksData.tasks).map((t) => {
    const label = tr[t.name] || t.normalizedName || t.name;
    const { py, pya } = pinyinIndex(label);
    return {
      id: t.id,
      label,
      en: (en[t.name] || t.name).toLowerCase(),
      norm: (t.normalizedName || "").toLowerCase(),
      py,
      pya,
      img: t.taskImageLink || "",
    };
  });
  taskCacheKey = key;
}

const searchText = ref("");
const searchResults = ref<TaskSearchEntry[]>([]);
const searchActive = ref(0);

/** 任务在当前地图上是否有自己的触发区域（zones）；
 * 只有任务物品点位（questItem 刷新点）而没有自有区域的任务不出现在搜索里 */
function taskOnCurrentMap(task: TaskDef): boolean {
  const apiIds = mapData?.apiIds || [];
  for (const ob of task.objectives || []) {
    for (const z of ob.zones || []) {
      if (apiIds.includes(z.map)) return true;
    }
  }
  return false;
}

/** 中文/英文/normalizedName/拼音全拼/首字母 匹配（与物品/任务页一致），
 * 只保留当前地图有目标的任务，按相关度排序取前 8 个 */
function runSearch() {
  const q = searchText.value.trim().toLowerCase();
  if (!q) {
    searchResults.value = [];
    return;
  }
  if (!taskSearchIndex.length) {
    // 数据尚未加载完（首次搜索触发加载中），加载完成后重跑
    void ensureTaskData().then(runSearch);
    return;
  }
  const score = (t: TaskSearchEntry) => {
    const label = t.label.toLowerCase();
    if (label === q || t.en === q || t.norm === q) return 0;
    if (label.startsWith(q) || t.en.startsWith(q) || t.norm.startsWith(q)) return 1;
    if (t.py.startsWith(q) || t.pya.startsWith(q)) return 2;
    return 3;
  };
  searchResults.value = taskSearchIndex
    .filter(
      (t) =>
        (t.label.toLowerCase().includes(q) ||
          t.en.includes(q) ||
          t.norm.includes(q) ||
          t.py.includes(q) ||
          t.pya.includes(q)) &&
        taskOnCurrentMap(taskById.get(t.id)!),
    )
    .map((t) => ({ t, s: score(t) }))
    .sort((a, b) => a.s - b.s || a.t.label.length - b.t.label.length)
    .slice(0, 8)
    .map(({ t }) => t);
  searchActive.value = 0;
}

function onSearchKey(e: KeyboardEvent) {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!searchResults.value.length) return;
    const d = e.key === "ArrowDown" ? 1 : -1;
    searchActive.value =
      (searchActive.value + d + searchResults.value.length) % searchResults.value.length;
  } else if (e.key === "Enter") {
    const r = searchResults.value[searchActive.value];
    if (r) pickTask(r);
  } else if (e.key === "Escape") {
    searchText.value = "";
    searchResults.value = [];
  }
}

/** 绘制单个任务的当前地图目标（zones 黄多边形 + questItem 红点位，与 URL 聚焦同一套）。
 * tracked=true 时图层带 _taskId 标记来源为任务列表（目标行显示移除按钮）；
 * tracked=false 用于 ?task=<id> 无 q 参数的 URL 进入。返回本次绘制的图层 */
function drawTaskObjectives(task: TaskDef, tracked: boolean): FocusLayer[] {
  const drawn: FocusLayer[] = [];
  if (!map || !mapData) return drawn;
  const md = mapData;
  const zoneHits = new Map<string, { zone: ZoneDef; entries: ObjectiveEntry[] }>();
  // 物品目标按 objective 分组：一个目标一组刷点（目标面板一行），组内按坐标去重
  const itemGroups = new Map<
    string,
    { positions: TaskPosition[]; seen: Set<string>; entries: ObjectiveEntry[] }
  >();
  for (const ob of task.objectives || []) {
    for (const zone of ob.zones || []) {
      if (!md.apiIds.includes(zone.map)) continue;
      if (!zoneHits.has(zone.id)) zoneHits.set(zone.id, { zone, entries: [] });
      zoneHits.get(zone.id)!.entries.push({ task, ob });
    }
    if (ob.questItem) {
      const k = ob.id || ob.questItem;
      for (const loc of ob.possibleLocations || []) {
        if (!md.apiIds.includes(loc.map)) continue;
        for (const p of loc.positions || []) {
          let g = itemGroups.get(k);
          if (!g) {
            g = { positions: [], seen: new Set(), entries: [{ task, ob }] };
            itemGroups.set(k, g);
          }
          const pk = `${p.x},${p.z}`;
          if (g.seen.has(pk)) continue;
          g.seen.add(pk);
          g.positions.push(p);
        }
      }
    }
  }
  for (const { zone, entries } of zoneHits.values()) {
    const floor = layerForZone(zone.position);
    const poly = L.polygon(zoneLatLngs(zone), {
      color: "#ffd54a",
      weight: 3,
      fillColor: "#ffd54a",
      fillOpacity: 0.15,
      className: "zone-focus",
    }).addTo(map!);
    const fl = trackFocus(
      poly,
      floor,
      { opacity: 1, fillOpacity: 0.15 },
      { opacity: 0.15, fillOpacity: 0.03 },
    );
    if (tracked) fl._taskId = task.id;
    bindFocusPopup(fl, entries, taskTr, floor);
    drawn.push(fl);
  }
  for (const { positions, entries } of itemGroups.values()) {
    // 每个刷点一个红点（子点自带气泡与楼层信息）；
    // 多刷点合并为一组：整组聚焦时自适应到全部刷点、每个刷点弹气泡
    const markers: L.CircleMarker[] = [];
    const floors = new Set<MapLayer | null>();
    for (const p of positions) {
      const floor = layerForZone(p);
      const m = circlePoint(p).addTo(map!);
      const fl = m as L.Path as FocusLayer;
      fl._floor = floor;
      bindFocusPopup(fl, entries, taskTr, floor);
      markers.push(m);
      floors.add(floor);
    }
    const floor = floors.size === 1 ? [...floors][0] : null;
    const fl = trackFocus(
      markers.length === 1 ? markers[0] : L.featureGroup(markers).addTo(map!),
      floor,
      { opacity: 1, fillOpacity: 0.8 },
      { opacity: 0.15, fillOpacity: 0.1 },
    );
    fl._entries = entries; // 组本身不绑气泡，但目标面板/勾选逻辑读 _entries
    if (tracked) fl._taskId = task.id;
    drawn.push(fl);
  }
  // 非当前楼层的绘制物初始即为调暗样式
  for (const l of drawn) {
    if ((l._floor || null) !== activeFloor) l.setStyle(l._dim);
  }
  return drawn;
}

/** 重绘任务列表来源的目标（URL 聚焦的绘制物不动），并重建目标列表面板 */
async function redrawTracked() {
  for (const l of focusLayers.filter((l) => l._taskId)) l.remove();
  focusLayers = focusLayers.filter((l) => !l._taskId);
  if (!map || !mapData) return;
  if (mapTasks.ids.length) {
    await ensureTaskData();
    if (!map || !mapData) return; // await 期间地图可能被重建，旧实例上的绘制直接丢弃
    for (const id of mapTasks.ids) {
      const task = taskById.get(id);
      if (!task) {
        console.warn("任务列表中存在未知任务 id:", id);
        continue;
      }
      drawTaskObjectives(task, true);
    }
  }
  buildObjectiveList(taskTr);
}

/** 聚焦一组目标图层（URL 进入与任务列表共用）：切楼层（多层回主层）、
 * 缩放到全部点位、弹气泡（互相遮挡的只留先打开的） */
function focusLayersView(layers: FocusLayer[], pad: number) {
  if (!layers.length || !map || !mapData) return;
  closeAllFocusPopups();
  const floors = new Set(layers.map((l) => l._floor || null));
  setFloor(floors.size === 1 ? [...floors][0] : null);
  // 单点小范围需要大 padding 避免过度放大；多点按点位分布自适应。
  // animate:false：缩放动画中气泡位置是变换中的中间值，去遮挡检测会拿到错误位置
  map.fitBounds(L.featureGroup(layers).getBounds().pad(pad), {
    maxZoom: mapData.maxZoom,
    animate: false,
  });
  openLayerPopups(layers);
}

/** 聚焦任务列表中的某个任务的全部目标（复用 URL 进入的聚焦行为） */
function focusTrackedTask(id: string) {
  const layers = focusLayers.filter((l) => l._taskId === id);
  focusLayersView(layers, layers.length > 1 ? 0.5 : 2);
}

function pickTask(r: TaskSearchEntry) {
  searchText.value = "";
  searchResults.value = [];
  if (mapTasks.ids.includes(r.id)) {
    // 已在列表里：不重复添加，直接聚焦
    focusTrackedTask(r.id);
    return;
  }
  mapTasks.add(r.id);
  // ids watcher 已触发一次重绘；这里等重绘完成后把视角聚焦到新任务
  void nextTick(async () => {
    await redrawTracked();
    focusTrackedTask(r.id);
  });
}

// 任务列表变化（本地增删 / 远程同步）→ 重绘当前地图上的任务目标
watch(
  () => [...mapTasks.ids],
  () => {
    void redrawTracked();
  },
);

// 目标完成状态变化（本地勾选 / 远程同步）→ 只重建面板勾选态，不动地图图层
watch(
  () => [...mapTasks.done],
  () => buildObjectiveList(taskTr),
);

/* ---- 生命周期：清理旧地图实例与状态 ---- */

/* ---- 滚轮缩放：固定倍率（新=原×倍率 / 原÷倍率）+ 平滑曲线 ----
 * 实现照搬 Leaflet 捏合缩放的内部路径：
 * 动画帧里用 _move(..., {pinch:true}) 只改 CSS 变换（瓦片不重建，无黑屏）；
 * 曲线收尾时用 _animateZoom 结算，瓦片在缩放动画结束、新级别加载就绪后才替换（旧瓦片保留不裁剪）。
 */

/** Leaflet 内部方法（捏合缩放同款调用方式） */
interface MapInternals extends L.Map {
  _animatingZoom: boolean;
  _mapPane: HTMLElement;
  _move(center: L.LatLng, zoom: number, data?: unknown, supressEvent?: boolean): void;
  _moveStart(zoomChanged: boolean, noMoveStart: boolean): void;
  _animateZoom(center: L.LatLng, zoom: number, startAnim: boolean, noUpdate?: boolean): void;
  _stop(): void;
}

const WHEEL_FACTOR = 1.2;
let wheelTarget: number | null = null;
let wheelCursorPt: L.Point | null = null;
let wheelLatLng: L.LatLng | null = null;
let wheelRaf = 0;
let wheelMoved = false;

function onMapWheel(e: WheelEvent) {
  if (!map) return;
  e.preventDefault();
  const m = map as MapInternals;
  m._stop();
  // 上一次结算动画（_animateZoom 的 CSS 过渡）还在跑时立即终止：
  // 否则其 250ms 收尾定时器会把视图拉回旧目标中心/缩放（连续滚轮时的抖动来源）。
  // 清掉 _animatingZoom 后定时器触发即直接返回；内部缩放值在动画开始时已是目标值，
  // 下面的 base = getZoom() 正好从该值继续乘/除倍率
  if (m._animatingZoom) {
    m._animatingZoom = false;
    L.DomUtil.removeClass(m._mapPane, "leaflet-zoom-anim");
  }
  wheelCursorPt = map.mouseEventToContainerPoint(e);
  wheelLatLng = map.containerPointToLatLng(wheelCursorPt);
  // 连续滚动时中断上一次动画：以当前实际缩放为基准再乘/除倍率
  const base = map.getZoom();
  const next = Math.min(
    map.getMaxZoom(),
    Math.max(map.getMinZoom(), e.deltaY < 0 ? base * WHEEL_FACTOR : base / WHEEL_FACTOR),
  );
  if (next === base) return;
  wheelTarget = next;
  if (!wheelRaf) wheelRaf = requestAnimationFrame(stepWheelZoom);
}

/** 保持光标所指经纬度不动：由目标缩放反推视图中心 */
function wheelCenterAt(zoom: number): L.LatLng {
  const m = map!;
  const pt = wheelCursorPt!;
  const half = m.getSize().divideBy(2);
  return m.unproject(m.project(wheelLatLng!, zoom).subtract(pt).add(half), zoom);
}

function stepWheelZoom() {
  wheelRaf = 0;
  if (!map || wheelTarget == null || !wheelCursorPt || !wheelLatLng) return;
  const m = map as MapInternals;
  const z = map.getZoom();
  const diff = wheelTarget - z;
  if (!wheelMoved) {
    m._moveStart(true, false);
    wheelMoved = true;
  }
  // 剩余差值交给 Leaflet 原生缩放动画收尾（CSS 过渡平滑滑到位，结束后才结算瓦片级别）
  if (Math.abs(diff) < 0.08) {
    m._animateZoom(wheelCenterAt(wheelTarget), wheelTarget, true);
    wheelTarget = null;
    wheelMoved = false;
    return;
  }
  // 每帧逼近目标 1/8 的差值，形成较长的平滑减速曲线；pinch 标记让瓦片层只做变换不重建
  const next = z + diff * 0.12;
  m._move(wheelCenterAt(next), next, { pinch: true, round: false }, undefined);
  wheelRaf = requestAnimationFrame(stepWheelZoom);
}

function cleanup() {
  if (wheelRaf) {
    cancelAnimationFrame(wheelRaf);
    wheelRaf = 0;
  }
  wheelTarget = null;
  wheelLatLng = null;
  wheelCursorPt = null;
  wheelMoved = false;
  mapEl.value?.removeEventListener("wheel", onMapWheel);
  if (raidTimer) {
    clearInterval(raidTimer);
    raidTimer = null;
  }
  if (map) {
    map.remove();
    map = null;
  }
  mapData = null;
  mapBounds = null;
  svgRoot = null;
  baseTileLayer = null;
  floorOverlay = null;
  activeFloor = null;
  trackLayer = null;
  focusLayers = [];
  labelMarkers = [];
  markerRecs = [];
  markerCounts = {};
  if (floorPanelEl.value) {
    floorPanelEl.value.innerHTML = "";
    floorPanelEl.value.hidden = true;
  }
  if (objPanelEl.value) {
    objPanelEl.value.innerHTML = "";
    objPanelEl.value.hidden = true;
  }
  if (markerPanelEl.value) {
    markerPanelEl.value.innerHTML = "";
    markerPanelEl.value.hidden = true;
  }
}

/* ---- 截图位置追踪 / 日志自动切图 ---- */

let allMaps: MapData[] = [];
let trackLayer: L.LayerGroup | null = null;
let mapNamesCache: Record<string, string> = {};
/** 已应用的日志切图事件时间戳：只有更新的事件才会触发自动切图，手动切图不被覆盖 */
let raidAppliedAt = 0;
/** 日志事件超过该时长视为过期（上一局/昨天的战局），打开地图页时不恢复 */
const RAID_EVENT_FRESH_MS = 3 * 3600 * 1000;
/** 截图触发跨图自动切换后，重建完成时把视角居中到玩家位置 */
let followAfterInit = false;

async function mapDisplayName(md: MapData): Promise<string> {
  if (!Object.keys(mapNamesCache).length) {
    mapNamesCache = await data.loadMapNames(config.mode, config.lang);
  }
  return mapNamesCache[md.apiIds[0]] ?? md.key;
}

/** 游戏坐标是否落在地图 bounds 内 */
function containsPoint(md: MapData, x: number, z: number): boolean {
  const [a, b] = md.bounds;
  return (
    x >= Math.min(a[0], b[0]) && x <= Math.max(a[0], b[0]) && z >= Math.min(a[1], b[1]) && z <= Math.max(a[1], b[1])
  );
}

/** 视角朝向在屏幕上的角度（度）。CRS 变换是仿射的，角度与缩放无关，取任意 zoom 投影即可 */
function headingDeg(p: TrackPoint): number {
  const m = map!;
  const z = m.getZoom();
  const p0 = m.project(L.latLng(p.z, p.x), z);
  const p1 = m.project(L.latLng(p.z + p.fz, p.x + p.fx), z);
  // 屏幕坐标 y 向下，正下方为 90°；图片默认朝下，故减 90° 修正
  return (Math.atan2(p1.y - p0.y, p1.x - p0.x) * 180) / Math.PI - 90;
}

/** 视角跟随的目标缩放：固定 4 倍左右（实测合适的观察倍率），不大幅拉近 */
function followZoom(): number {
  return 4;
}

/** 渲染轨迹：历史点为小圆点，最新点为脉冲底圈 + 按朝向旋转的玩家箭头 */
function renderTrack() {
  if (!map) return;
  if (!trackLayer) trackLayer = L.layerGroup().addTo(map);
  trackLayer.clearLayers();
  const pts = track.points;
  pts.forEach((p, i) => {
    const ll = L.latLng(p.z, p.x);
    if (i === pts.length - 1 && (track.enabled || track.remote)) {
      L.marker(ll, {
        icon: L.divIcon({
          className: "track-self",
          html:
            `<div class="track-pulse"></div>` +
            `<img class="track-arrow" src="${import.meta.env.BASE_URL}assets/interactive/self.png" ` +
            `style="transform: rotate(${headingDeg(p)}deg)" alt="">`,
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        }),
        zIndexOffset: 100000,
      })
        .bindTooltip(`${p.time}　高度 ${p.y.toFixed(1)}m　FOV ${p.fov}`, { direction: "top", offset: [0, -14] })
        .addTo(trackLayer!);
    } else {
      L.circleMarker(ll, { radius: 5, color: "#63e2b7", weight: 1, opacity: 0.7, fillOpacity: 0.35 })
        .bindTooltip(`${p.time}　高度 ${p.y.toFixed(1)}m`)
        .addTo(trackLayer!);
    }
  });
}

/** 视角居中到最新截图位置（若在当前地图内） */
function followLatest() {
  if (!map || !mapData || !track.points.length) return;
  const p = track.points[track.points.length - 1];
  if (!containsPoint(mapData, p.x, p.z)) return;
  map.flyTo(L.latLng(p.z, p.x), followZoom(), { duration: 0.4 });
}

// 新截图：重绘轨迹；PC host 广播给移动端；位置不在当前地图时按设置自动跟随切图或给出可点击提示
watch(
  () => track.points.length,
  async (n, prev) => {
    renderTrack();
    if (n <= prev) return;
    const p = track.points[n - 1];
    if (track.enabled) sync.notifyPoint(p);
    if (!mapData || (!track.enabled && !track.remote)) return;
    if (containsPoint(mapData, p.x, p.z)) {
      // 接收模式下跟随是本功能的核心用途，无视 followScreenshot 设置
      if (config.followScreenshot || track.remote) followLatest();
      return;
    }
    const other = allMaps.find((m) => m.key !== mapData!.key && containsPoint(m, p.x, p.z));
    if (!other) {
      message.warning(`新截图位置 (${p.x.toFixed(0)}, ${p.z.toFixed(0)}) 不在任何已知地图范围内`);
      return;
    }
    const name = await mapDisplayName(other);
    if (config.autoMapScreenshot) {
      // 截图跟随优先于日志恢复：压制日志的过期事件，避免被拉回旧战局地图
      raidAppliedAt = Math.max(raidAppliedAt, raid.lastAt);
      followAfterInit = config.followScreenshot;
      message.success(`截图位置位于「${name}」，已自动切换`);
      void router.push({ query: { ...route.query, map: other.key } });
      return;
    }
    message.warning(
      () =>
        h(
          "a",
          {
            style: "cursor: pointer; text-decoration: underline;",
            onClick: () => router.push({ query: { ...route.query, map: other.key } }),
          },
          `截图位置位于「${name}」，点击切换`,
        ),
      { duration: 8000 },
    );
  },
);

// 日志检测到新进战局：自动切换地图页到对应地图（只响应新事件）
watch(
  () => `${raid.mapKey}@${raid.lastAt}`,
  async () => {
    if (!raid.enabled || !raid.mapKey || !config.autoMapLog) return;
    if (raid.lastAt <= raidAppliedAt) return;
    const current = queryStr(route.query.map) || "customs";
    if (raid.mapKey === current) {
      raidAppliedAt = raid.lastAt;
      return;
    }
    raidAppliedAt = raid.lastAt;
    const md = allMaps.find((m) => m.key === raid.mapKey);
    const name = md ? await mapDisplayName(md) : raid.mapKey;
    message.success(`日志检测到进入「${name}」，已自动切换地图`);
    void router.push({ query: { ...route.query, map: raid.mapKey } });
  },
);

/* ---- 主流程 ---- */

let qIds: string[] = [];
let taskParam = "";

async function init() {
  cleanup();

  const mapParam = queryStr(route.query.map) || "customs";
  qIds = queryStr(route.query.q)
    .split(",")
    .filter(Boolean);
  taskParam = queryStr(route.query.task); // 指定任务 id 时只匹配该任务的目标
  const gameMode = config.mode; // 模式/语言跟随导航栏下拉框
  const lang = config.lang;
  const styleParam = queryStr(route.query.style);

  const maps = (await (
    await fetch(import.meta.env.BASE_URL + "maps.json")
  ).json()) as MapData[];
  allMaps = maps;
  mapData = maps.find((m) => m.key === mapParam) || maps.find((m) => m.key === "customs")!;
  sync.notifyMap(mapData.key); // host 侧：更新快照中的当前地图（未开启同步时为无操作）

  // 日志同步中的战局在别的地图且事件较新：打开地图页时直接切过去（query watcher 会重建）。
  // 过期事件不恢复（避免被昨天/上一局的记录锁住），已应用过的事件不重复应用（保留手动切图）
  if (
    raid.enabled &&
    config.autoMapLog &&
    raid.mapKey &&
    raid.mapKey !== mapData.key &&
    raid.lastAt > raidAppliedAt &&
    Date.now() - raid.lastAt < RAID_EVENT_FRESH_MS
  ) {
    raidAppliedAt = raid.lastAt;
    void router.replace({ query: { ...route.query, map: raid.mapKey } });
    return;
  }

  const styleSelect = styleSelectEl.value!;
  styleSelect.value = styleParam;
  styleSelect.onchange = () => {
    // 样式写回 URL，由 query watcher 统一重建地图
    const query: LocationQuery = { ...route.query };
    if (styleSelect.value) query.style = styleSelect.value;
    else delete query.style;
    void router.replace({ query });
  };

  const floorPanel = floorPanelEl.value!;
  if (mapData.layers && mapData.layers.length) {
    // 头部标题行：点击收起/展开（窄屏默认收起，跨地图重建保持状态）
    const head = document.createElement("div");
    head.className = "floor-head";
    const headLabel = document.createElement("span");
    headLabel.textContent = "楼层";
    const headToggle = document.createElement("span");
    headToggle.className = "floor-toggle";
    const syncFloorToggle = () => {
      headToggle.textContent = floorCollapsed ? "▶" : "▾";
    };
    head.onclick = () => {
      floorCollapsed = !floorCollapsed;
      floorPanel.classList.toggle("collapsed", floorCollapsed);
      syncFloorToggle();
    };
    syncFloorToggle();
    head.append(headLabel, headToggle);
    floorPanel.appendChild(head);
    // 纵向单选楼层（不含地面层），再次点击已选楼层取消选择回到地面层
    mapData.layers.forEach((layer) => {
      const row = document.createElement("div");
      row.className = "floor-item";
      row.innerHTML = `<span class="dot"></span><span>${layer.name}</span>`;
      row.onclick = () => {
        setFloor(activeFloor === layer ? null : layer);
      };
      floorPanel.appendChild(row);
    });
    floorPanel.classList.toggle("collapsed", floorCollapsed);
    floorPanel.hidden = false;
  }

  mapBounds = getBounds(mapData.bounds);
  map = L.map(mapEl.value!, {
    crs: getCRS(mapData),
    minZoom: mapData.minZoom,
    maxZoom: Math.max(7, mapData.maxZoom),
    maxBounds: getScaledBounds(mapData.bounds, 1.5),
    attributionControl: false,
    // 缩放按钮放左下角（自定义位置，见下方 zoomControl）
    zoomControl: false,
    // 无极倍率：缩放不再取整；min/max 由各地图数据决定
    zoomSnap: 0,
    bounceAtZoomLimits: false,
    // 滚轮走自定义固定倍率 + 平滑曲线；触摸捏合走 Leaflet 原生（跟随手势，不插值）
    scrollWheelZoom: false,
  });
  map.fitBounds(mapBounds, { animate: false });
  L.control.zoom({ position: "bottomleft" }).addTo(map);
  const updateZoom = () => {
    zoomInfo.value = `缩放: ${map!.getZoom().toFixed(1)}`;
  };
  map.on("zoomend zoom", updateZoom);
  updateZoom();
  mapEl.value!.addEventListener("wheel", onMapWheel, { passive: false });
  // 指针位置的游戏坐标（x, z）：桌面鼠标 + 移动端触摸拖动
  // Leaflet 触摸事件类型声明不带 latlng，但运行时提供（与鼠标事件同结构）
  const showCursorPos = (e: L.LeafletEvent) => {
    const { latlng } = e as L.LeafletMouseEvent;
    cursorPos.value = `${latlng.lng.toFixed(1)}, ${latlng.lat.toFixed(1)}`;
  };
  map.on("mousemove", showCursorPos);
  map.on("touchstart", showCursorPos);
  map.on("touchmove", showCursorPos);
  startRaidTime(mapData.key);

  const useSvg = mapData.svgPath && styleParam !== "tile";
  const useTile = mapData.tilePath && (styleParam === "tile" || !mapData.svgPath);
  try {
    if (useSvg) await addSvgLayer(mapData, mapBounds);
    else if (useTile) addTileLayer(mapData, mapBounds);
  } catch {
    // SVG 加载失败时回退瓦片
    if (mapData.tilePath) addTileLayer(mapData, mapBounds);
  }
  addLabels(mapData);
  setFloor(null); // 应用初始标签可见性：完全属于某楼层的标签在主层隐藏

  // 点击地图空白处关闭所有气泡。注意不能用 propagatedFrom 判断：
  // 点击高亮时地图容器也作为直接目标触发一次 click（无 propagatedFrom），
  // 所以统一用点击坐标是否落在某个高亮内来区分（与循环切换的几何判定一致）
  map.on("click", (e: L.LeafletMouseEvent) => {
    if (e.latlng && focusLayers.some((l) => l.getPopup() && layerContainsPoint(l, e.latlng)))
      return;
    for (const l of focusLayers) l.closePopup();
    // 标记气泡同理：点在图标上保留，点到空白处全部关闭
    if (!(e.latlng && markerRecs.some((r) => r.dot.getPopup() && markerHit(r.dot, e.latlng))))
      for (const r of markerRecs) closeMarkerPopup(r.dot);
    objPanelEl.value
      ?.querySelectorAll(".obj-item.active")
      .forEach((el) => el.classList.remove("active"));
  });

  // 撤离点/危险区标记。全量 /maps 响应体积大（~8MB），裁剪出标记字段后再缓存（~140KB）
  setStatus("加载地图标记 ...");
  const apiMarkers = await fetchCachedTrimmed<MapsApiResponse, MapsMarkersTrimmed>(
    `/${gameMode}/maps`,
    (raw) => {
      const out: MapsMarkersTrimmed = { containerDefs: {}, maps: {} };
      for (const [id, c] of Object.entries(raw.data.lootContainers ?? {})) {
        if (c.normalizedName) out.containerDefs[id] = c.normalizedName;
      }
      for (const [id, m] of Object.entries(raw.data.maps)) {
        out.maps[id] = {
          extracts: m.extracts ?? [],
          transits: m.transits ?? [],
          hazards: m.hazards ?? [],
          locks: m.locks ?? [],
          stationaryWeapons: m.stationaryWeapons ?? [],
          switches: m.switches ?? [],
          lootContainers: m.lootContainers ?? [],
          // 散图刷新点只保留含赛季文件的，物品列表也只留文件 id
          seasonFiles: (m.lootLoose ?? [])
            .map((l) => ({
              position: l.position,
              files: (l.items ?? []).filter((i) => SEASON_FILE_IDS.has(i)),
            }))
            .filter((l) => l.files.length > 0),
        };
      }
      return out;
    },
    7 * 24 * 3600 * 1000,
    3, // v3：新增赛季文件点位（lootLoose 过滤）
  );
  const mapTr = (await fetchCached<TrResponse>(`/${gameMode}/maps_${lang}`)).data;
  // 上锁的门需要钥匙物品名（items_{lang} 的 "<id> Name" 键）
  const itemTr = (await fetchCached<TrResponse>(`/${gameMode}/items_${lang}`)).data;
  const apiId = mapData.apiIds.find((id) => apiMarkers.maps[id]);
  if (apiId) drawMapMarkers(apiMarkers.maps[apiId], apiMarkers.containerDefs, mapTr, itemTr);
  buildMarkerPanel();
  updateMarkers();
  renderTrack();
  // 接收模式：进入页面时若已有远程轨迹点，视角直接聚焦玩家位置
  if (followAfterInit || (track.remote && track.points.length)) {
    followAfterInit = false;
    followLatest();
  }

  // 任务列表（搜索添加/同步恢复）目标绘制，不依赖 URL 参数
  await redrawTracked();
  if (!map) return; // await 期间地图可能被重建

  if (!qIds.length && !taskParam) {
    setStatus("");
    return;
  }

  setStatus("加载任务数据 ...");
  await ensureTaskData();
  if (!map) return;
  const tr = taskTr;
  let missing: string[] = [];
  let layers: FocusLayer[] = [];
  if (qIds.length) {
    ({ missing, layers } = findAndDraw({ tasks: Object.fromEntries(taskById) }, tr));
  } else {
    // 只传任务 id：从任务数据推出它在当前地图的区域/物品点位
    const task = taskById.get(taskParam);
    if (task) layers = drawTaskObjectives(task, false);
    else missing = [taskParam];
  }
  buildObjectiveList(tr);

  if (layers.length) {
    focusLayersView(layers, qIds.length > 1 || layers.length > 1 ? 0.3 : 2);
    setStatus(missing.length ? `未找到: ${missing.join(", ")}` : "");
  } else {
    setStatus(`未找到目标: ${qIds.length ? qIds.join(", ") : taskParam}`);
  }
}

onMounted(() => {
  document.addEventListener("click", collapsePanelsOnOutsideClick, true);
  init().catch((e: unknown) => setStatus(`加载失败: ${e instanceof Error ? e.message : String(e)}`));
});

// ?sync=<id>：进入/退出接收模式。参数变化重连，参数移除则断开并清空远程轨迹
watch(
  () => queryStr(route.query.sync),
  (sid, prev) => {
    if (sid && sid !== prev) {
      sync.connectClient(sid);
    } else if (!sid && sync.clientStatus !== "off") {
      sync.disconnectClient();
      track.leaveRemote();
      renderTrack();
    }
  },
  { immediate: true },
);

// 收到 PC 端地图切换（快照或 map 消息）：切到同一地图（query watcher 会重建地图）
watch(
  () => [sync.remoteMap, sync.remoteMapAt],
  () => {
    if (sync.remoteMap && sync.remoteMap !== currentMapKey.value) {
      void router.push({ query: { ...route.query, map: sync.remoteMap } });
    }
  },
);

// 导航栏切换模式/语言时用新配置重建地图（点位数据按模式区分、文案按语言翻译）
watch(
  () => [config.mode, config.lang],
  () => {
    init().catch((e: unknown) =>
      setStatus(`加载失败: ${e instanceof Error ? e.message : String(e)}`),
    );
  },
);

// 导航栏地图菜单/样式选择只改 URL query，由这里统一重建地图
watch(
  () => [route.query.map, route.query.style],
  () => {
    init().catch((e: unknown) =>
      setStatus(`加载失败: ${e instanceof Error ? e.message : String(e)}`),
    );
  },
);

onBeforeUnmount(() => {
  document.removeEventListener("click", collapsePanelsOnOutsideClick, true);
  cleanup();
});
</script>

<template>
  <div class="map-page">
    <div class="map-topleft">
      <div class="map-leftcol">
        <div class="map-topbar">
          <select ref="styleSelectEl" title="地图样式">
            <option value="">自动</option>
            <option value="svg">抽象图</option>
            <option value="tile">卫星图</option>
          </select>
          <span class="map-status">{{ status }}</span>
          <button v-if="track.points.length" class="track-btn" title="清除轨迹点" @click="track.clear()">
            清除轨迹
          </button>
          <template v-if="syncMode">
            <span class="sync-badge" :class="sync.clientStatus" :title="sync.clientHint">
              {{ sync.clientHint || syncStatusText }}
            </span>
            <button class="track-btn" title="断开位置同步" @click="disconnectSync">断开</button>
          </template>
          <button
            v-else
            class="track-btn"
            :class="{ active: sync.hosting }"
            title="同步玩家位置到手机（局域网直连）"
            @click="syncModal = true"
          >
            同步到手机
          </button>
        </div>
        <div ref="floorPanelEl" class="map-floor-panel" hidden></div>
        <div ref="objPanelEl" class="map-obj-panel" hidden></div>
      </div>
    </div>
    <div class="map-task-ui">
      <div class="map-task-search">
        <input
          v-model="searchText"
          type="text"
          placeholder="搜索任务（仅当前地图有目标的） ..."
          @input="runSearch"
          @focus="ensureTaskData().then(runSearch)"
          @keydown="onSearchKey"
          @blur="searchResults = []"
        />
        <div v-if="searchResults.length" class="task-search-results">
          <div
            v-for="(r, i) in searchResults"
            :key="r.id"
            class="task-search-card"
            :class="{ active: i === searchActive }"
            @mousedown.prevent="pickTask(r)"
            @mouseenter="searchActive = i"
          >
            <img v-if="r.img" :src="r.img" class="task-search-icon" loading="lazy" alt="" />
            <span class="task-search-name">{{ r.label }}</span>
          </div>
        </div>
      </div>
    </div>
    <div v-show="raidTime || cursorPos || zoomInfo" class="map-status-chip">
      <span class="map-zoom-info">{{ zoomInfo }}</span>
      <span v-if="cursorPos" class="map-cursor-pos">{{ cursorPos }}</span>
      <span class="map-raid-time">{{ raidTime }}</span>
    </div>
    <div ref="markerPanelEl" class="map-marker-panel" hidden></div>
    <div ref="mapEl" class="map-leaflet"></div>
    <SyncModal v-model:show="syncModal" :map-key="currentMapKey" />
  </div>
</template>

<style>
.map-page {
  position: relative;
  width: 100%;
  height: 100%;
  background: #1a1b1e;
}

.map-page .map-leaflet {
  width: 100%;
  height: 100%;
  background: #1a1b1e;
}

/* 左上角容器：顶栏 + 左列（楼层面板 + 目标面板）纵向堆叠，避免面板宽度不一致留出空洞 */
.map-page .map-topleft {
  position: absolute;
  top: 10px;
  left: 10px;
  z-index: 1000;
  display: flex;
  align-items: flex-start;
}

/* 左列：顶栏、楼层面板、目标面板上下排列，目标面板高度受视口约束（超出滚动） */
.map-page .map-leftcol {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
  max-height: calc(100dvh - 20px);
}

.map-page .map-topbar {
  display: flex;
  gap: 8px;
  align-items: center;
  background: rgba(20, 21, 24, 0.85);
  border: 1px solid #3a3b40;
  border-radius: 6px;
  padding: 6px 10px;
  color: #d8d8d8;
  font: 13px/1.4 sans-serif;
}

.map-page .map-topbar select {
  background: #24252a;
  color: #d8d8d8;
  border: 1px solid #3a3b40;
  border-radius: 4px;
  padding: 2px 4px;
}

.map-page .track-btn {
  background: transparent;
  border: 1px solid #3a3b40;
  color: #d8d8d8;
  border-radius: 4px;
  padding: 2px 8px;
  cursor: pointer;
  font: inherit;
}

.map-page .track-btn:hover {
  border-color: #63e2b7;
}

.map-page .track-btn.active {
  color: #63e2b7;
  border-color: #63e2b7;
}

/* 任务搜索 + 任务列表：桌面顶部居中；移动端挪到底部全宽（见媒体查询） */
.map-page .map-task-ui {
  position: absolute;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1002; /* 高于 Leaflet 控件（缩放按钮 1000），结果列表展开时不被压住 */
  width: 440px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.map-page .map-task-search {
  position: relative;
}

.map-page .map-task-search input {
  width: 100%;
  box-sizing: border-box;
  background: rgba(20, 21, 24, 0.85);
  border: 1px solid #3a3b40;
  border-radius: 6px;
  padding: 8px 12px;
  color: #d8d8d8;
  font: 14px/1.4 sans-serif;
  outline: none;
}

.map-page .map-task-search input:focus {
  border-color: #63e2b7;
}

.map-page .task-search-results {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  max-height: 40vh;
  overflow-y: auto;
  background: rgba(20, 21, 24, 0.95);
  border: 1px solid #3a3b40;
  border-radius: 6px;
  padding: 4px;
}

.map-page .task-search-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 10px;
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
  color: #d8d8d8;
  font: 14px/1.4 sans-serif;
}

.map-page .task-search-card.active {
  background: #2e2f35;
  outline: 1px solid #63e2b7;
}

/* 任务图片是长方形：固定宽度、高度自适应，上下居中 */
.map-page .task-search-icon {
  width: 96px;
  height: auto;
  border-radius: 4px;
  flex: none;
}

.map-page .task-search-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 位置同步状态徽章（接收模式） */
.map-page .sync-badge {
  border: 1px solid #3a3b40;
  border-radius: 4px;
  padding: 2px 8px;
  user-select: none;
}

.map-page .sync-badge.connected {
  color: #63e2b7;
  border-color: #63e2b7;
}

.map-page .sync-badge.connecting,
.map-page .sync-badge.reconnecting {
  color: #e2c08d;
  border-color: #e2c08d;
}

/* 截图追踪：当前位置箭头（self.png 默认朝下，按朝向旋转）+ 脉冲底圈 */
.track-self {
  position: relative;
}

.track-arrow {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.track-pulse {
  position: absolute;
  inset: 6px;
  border-radius: 50%;
  background: rgba(99, 226, 183, 0.45);
  animation: track-pulse 1.5s ease-out infinite;
}

@keyframes track-pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(99, 226, 183, 0.55);
  }
  100% {
    box-shadow: 0 0 0 14px rgba(99, 226, 183, 0);
  }
}

.map-page .map-status:empty {
  display: none;
}

.map-page .map-zoom-info,
.map-page .map-raid-time {
  white-space: nowrap;
  color: #9d9d9d;
  font-variant-numeric: tabular-nums;
}

/* 右下角状态块：指针游戏坐标 + 战局时间（不拦截地图交互） */
.map-page .map-status-chip {
  position: absolute;
  right: 10px;
  bottom: 10px;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  background: rgba(20, 21, 24, 0.85);
  border: 1px solid #3a3b40;
  border-radius: 6px;
  padding: 4px 8px;
  color: #d8d8d8;
  font: 12px/1.4 sans-serif;
  pointer-events: none;
}

.map-page .map-cursor-pos {
  color: #9d9d9d;
  font-variant-numeric: tabular-nums;
}

/* SVG 地图：非当前楼层的分组隐藏（移植自 tarkov-dev） */
.map-page .hidden-layer {
  display: none;
}

/* 楼层单选面板：在 .map-topleft 容器内（顶部栏左侧）；展开固定宽度，收起收缩到标题宽 */
.map-page .map-floor-panel {
  display: flex;
  flex-direction: column;
  background: rgba(20, 21, 24, 0.85);
  border: 1px solid #3a3b40;
  border-radius: 6px;
  padding: 4px;
  color: #d8d8d8;
  font: 13px/1.4 sans-serif;
  width: fit-content;
}

/* 展开时固定宽度，收起时收缩到标题宽度（与标记面板一致） */
.map-page .map-floor-panel:not(.collapsed) {
  width: 150px;
}

.map-page .map-floor-panel[hidden] {
  display: none;
}

.map-page .floor-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  font-weight: 700;
  padding: 2px 4px 6px;
  cursor: pointer;
  user-select: none;
}

.map-page .floor-toggle {
  color: #9d9d9d;
  font-size: 11px;
}

.map-page .map-floor-panel.collapsed .floor-item {
  display: none;
}

/* 任务目标列表：楼层面板下方（随左列文档流），点击单聚焦对应目标；头部行可收起 */
.map-page .map-obj-panel {
  width: 220px;
  overflow-y: auto;
  min-height: 0;
  background: rgba(20, 21, 24, 0.85);
  border: 1px solid #3a3b40;
  border-radius: 6px;
  padding: 4px;
  color: #d8d8d8;
  font: 12px/1.4 sans-serif;
}

.map-page .map-obj-panel[hidden] {
  display: none;
}

/* 收起时收缩到标题宽度（与楼层面板一致），避免顶栏被固定宽度顶出空白 */
.map-page .map-obj-panel.collapsed {
  width: fit-content;
}

.map-page .obj-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  font-weight: 700;
  padding: 2px 4px 6px;
  cursor: pointer;
  user-select: none;
}

.map-page .obj-toggle {
  color: #9d9d9d;
  font-size: 11px;
}

.map-page .map-obj-panel.collapsed .obj-item {
  display: none;
}

.map-page .obj-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
}

.map-page .obj-item input[type="checkbox"] {
  accent-color: #ffd54a;
  margin: 0;
  flex: none;
  cursor: pointer;
}

.map-page .obj-item .obj-body {
  flex: 1;
  min-width: 0;
}

/* 已完成目标：整行降透明度 */
.map-page .obj-item.done .obj-body {
  opacity: 0.45;
}

.map-page .obj-item .obj-remove {
  flex: none;
  color: #9d9d9d;
  padding: 0 2px;
}

.map-page .obj-item .obj-remove:hover {
  color: #ff5252;
}

.map-page .obj-item:hover {
  background: #2e2f35;
}

.map-page .obj-item.active {
  background: #2e2f35;
  outline: 1px solid #ffd54a;
}

.map-page .obj-item b {
  color: #ffd54a;
}

.map-page .obj-item hr {
  border: none;
  border-top: 1px solid #3a3b40;
  margin: 4px 0;
}

/* 标记分组面板：右上角；组行三态勾选，子项缩进 */
.map-page .map-marker-panel {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 1000;
  max-height: calc(100% - 20px);
  overflow-y: auto;
  background: rgba(20, 21, 24, 0.85);
  border: 1px solid #3a3b40;
  border-radius: 6px;
  padding: 6px 8px;
  color: #d8d8d8;
  font: 13px/1.4 sans-serif;
  min-width: 140px;
}

.map-page .map-marker-panel[hidden] {
  display: none;
}

.map-page .mk-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  font-weight: 700;
  padding: 2px 4px 6px;
  cursor: pointer;
  user-select: none;
}

.map-page .mk-toggle {
  color: #9d9d9d;
  font-size: 11px;
}

.map-page .map-marker-panel.collapsed .mk-body {
  display: none;
}

.map-page .mk-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 4px;
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
}

.map-page .mk-row:hover {
  background: #2e2f35;
}

.map-page .mk-group-row {
  font-weight: 600;
}

.map-page .mk-child-row {
  padding-left: 22px;
}

.map-page .mk-row input[type="checkbox"] {
  accent-color: #ffd54a;
  margin: 0;
}

.map-page .mk-swatch {
  width: 16px;
  height: 16px;
  flex: none;
}

/* 撤离点图标下方的常驻名称（Leaflet permanent tooltip） */
.map-page .mk-name.leaflet-tooltip {
  background: rgba(20, 21, 24, 0.78);
  border: 1px solid #3a3b40;
  border-radius: 4px;
  box-shadow: none;
  color: #e8e8e8;
  font: 11px/1.3 sans-serif;
  padding: 1px 5px;
  white-space: nowrap;
}

.map-page .mk-name.leaflet-tooltip-bottom::before {
  border-bottom-color: #3a3b40;
}

.map-page .floor-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
}

.map-page .floor-item:hover {
  background: #2e2f35;
}

.map-page .floor-item .dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1.5px solid #777;
  flex: none;
}

.map-page .floor-item.active .dot {
  background: #ffd54a;
  border-color: #ffd54a;
}

/* 切到非主层时，基底分组/瓦片调暗（移植自 tarkov-dev 的 off-level 样式） */
.map-page .map-leaflet svg.off-level g.base-layer {
  opacity: 0.2;
}

.map-page .leaflet-layer.off-level .leaflet-tile-container {
  opacity: 0.2;
}

/* 地图区域文字标签（基准 20px，标签 size 字段为百分比） */
.map-page .map-area-label {
  font-size: 20px;
  font-weight: 800;
  text-align: center;
}

.map-page .map-area-label .label {
  position: absolute;
  width: 200px;
  color: rgba(230, 230, 230, 0.75);
  font-family: sans-serif;
  white-space: nowrap;
  text-shadow: 0 0 3px #000;
  -webkit-text-stroke: 0.5px #000;
  pointer-events: none;
}

/* 聚焦目标样式 */
.map-page .zone-focus {
  filter: drop-shadow(0 0 6px rgba(255, 213, 74, 0.9));
}

.map-page .leaflet-popup-content-wrapper,
.map-page .leaflet-popup-tip {
  background: #24252a;
  color: #e8e8e8;
}

.map-page .leaflet-popup-content {
  font: 13px/1.5 sans-serif;
}

.map-page .leaflet-popup-content b {
  color: #ffd54a;
}

.map-page .leaflet-container a.leaflet-popup-close-button {
  color: #999;
}

/* 手机/窄屏：缩放按钮加大便于触摸；顶部栏独占第一行（不换行、超出横向滑动），
 * 楼层面板换行到第二行左侧；标记面板下移到顶部栏下方避免重叠；面板限高防遮挡 */
@media (max-width: 768px) {
  .map-page .leaflet-bar a {
    width: 36px;
    height: 36px;
    line-height: 36px;
    font-size: 18px;
  }

  .map-page .map-topleft {
    right: 10px;
  }

  .map-page .map-topbar {
    font-size: 12px;
    padding: 4px 8px;
    flex-wrap: nowrap;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
    max-width: 100%;
    box-sizing: border-box;
  }

  .map-page .map-topbar::-webkit-scrollbar {
    display: none;
  }

  .map-page .map-topbar > * {
    flex-shrink: 0;
    white-space: nowrap;
  }

  .map-page .map-marker-panel {
    top: 52px;
    max-height: 55%;
    min-width: 0;
  }

  .map-page .map-obj-panel {
    width: 180px;
  }

  /* 任务搜索栏放底部占满宽度；结果列表与任务列表向上展开 */
  .map-page .map-task-ui {
    top: auto;
    bottom: 10px;
    left: 10px;
    right: 10px;
    width: auto;
    transform: none;
    flex-direction: column-reverse;
  }

  .map-page .task-search-results {
    top: auto;
    bottom: calc(100% + 4px);
    max-height: 30vh;
  }

  /* 移动端结果卡片图片收小，给列表留出行数 */
  .map-page .task-search-icon {
    width: 64px;
  }

  /* 底部搜索栏占位：缩放按钮与右下状态块上移避让 */
  .map-page .leaflet-bottom.leaflet-left {
    bottom: 44px;
  }

  .map-page .map-status-chip {
    bottom: 54px;
  }
}
</style>
