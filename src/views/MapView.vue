<script setup lang="ts">
/* 纯静态塔科夫任务地图：?map=<地图key>&q=<区域/任务物品id,逗号分隔>&task=<任务id>
 * 模式/语言跟随导航栏下拉框（config store），不从 URL 读取。
 * 坐标系/投影与楼层分层逻辑移植自 the-hideout/tarkov-dev (src/pages/map/index.jsx)，
 * 页面行为对齐 web/map.js。 */
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { LocationQuery, LocationQueryValue } from "vue-router";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { fetchCached, fetchCachedTrimmed } from "@/api/client";
import { useConfigStore } from "@/stores/config";
import { MARKER_CATS, MARKER_GROUPS, SEASON_FILES_BY_ID, SEASON_FILE_IDS } from "@/utils/markers";
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

const mapEl = ref<HTMLDivElement>();
const floorPanelEl = ref<HTMLDivElement>();
const objPanelEl = ref<HTMLDivElement>();
const markerPanelEl = ref<HTMLDivElement>();
const styleSelectEl = ref<HTMLSelectElement>();
const status = ref("加载中 ...");
const zoomInfo = ref("");
const raidTime = ref("");

/* ---- json.tarkov.dev 任务数据（仅声明地图页用到的字段） ---- */

interface ZoneDef {
  id: string;
  map: string;
  outline?: TaskPosition[];
  position: TaskPosition;
  size?: { x?: number; z?: number };
}

interface ObjectiveDef {
  description?: string;
  zones?: ZoneDef[] | null;
  questItem?: string | null;
  possibleLocations?: TaskLocation[] | null;
}

interface TaskDef {
  id: string;
  name: string;
  normalizedName?: string;
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

type FocusLayer = L.Path & {
  _floor: MapLayer | null;
  _normal: L.PathOptions;
  _dim: L.PathOptions;
  _entries: ObjectiveEntry[];
  // Path 基类类型未声明 getBounds，实际绘制的 Polygon/CircleMarker 都有
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
let focusLayers: FocusLayer[] = []; // 聚焦绘制物，_floor 记录所属楼层
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
  // 面板选中态
  const panel = floorPanelEl.value;
  if (panel) {
    Array.from(panel.children).forEach((el, i) =>
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

/** 分组勾选面板：组行三态（全选/部分/全不选），子项缩进；只列出当前地图存在的类别 */
function buildMarkerPanel() {
  const panel = markerPanelEl.value!;
  panel.innerHTML = "";
  let any = false;
  const title = document.createElement("div");
  title.className = "mk-title";
  title.textContent = "标记";
  panel.appendChild(title);
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
    panel.appendChild(groupRow);
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
      panel.appendChild(row);
    }
  }
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
  layer: L.Path,
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

function layerContainsPoint(layer: L.Path, latlng: L.LatLng): boolean {
  if (layer instanceof L.CircleMarker) {
    const d = map!
      .latLngToLayerPoint(layer.getLatLng())
      .distanceTo(map!.latLngToLayerPoint(latlng));
    return d <= layer.getRadius() + 4;
  }
  const ring = (layer as L.Polygon).getLatLngs()[0] as unknown as L.LatLng[];
  return ringContains(ring, latlng);
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
    for (const l of focusLayers) l.closePopup();
    next.openPopup();
    setFloor(next._floor || null);
  });
}

/* ---- 目标列表面板 ---- */

function focusObjective(layer: FocusLayer, row: HTMLElement) {
  // 单聚焦一个目标：切到所在楼层、缩放到该目标并弹出气泡
  objPanelEl.value
    ?.querySelectorAll(".obj-item.active")
    .forEach((el) => el.classList.remove("active"));
  row.classList.add("active");
  for (const l of focusLayers) l.closePopup();
  setFloor(layer._floor || null);
  map!.fitBounds(layer.getBounds().pad(0.5), { maxZoom: mapData!.maxZoom, animate: false });
  layer.openPopup();
}

function buildObjectiveList(tr: TranslationMap) {
  const objPanel = objPanelEl.value!;
  const floorPanel = floorPanelEl.value!;
  objPanel.innerHTML = "";
  if (!focusLayers.length) return;
  for (const layer of focusLayers) {
    const row = document.createElement("div");
    row.className = "obj-item";
    row.innerHTML = entryBodies(layer._entries, tr).join("<hr>");
    row.onclick = () => focusObjective(layer, row);
    objPanel.appendChild(row);
  }
  // 面板贴在楼层选择器下面（无楼层地图则贴缩放按钮下面），最大高度按地图容器算
  const top = floorPanel.hidden ? 86 : floorPanel.offsetTop + floorPanel.offsetHeight + 8;
  objPanel.style.top = `${top}px`;
  objPanel.style.maxHeight = `${mapEl.value!.clientHeight - top - 16}px`;
  objPanel.hidden = false;
}

function findAndDraw(tasksData: TasksResponse["data"], tr: TranslationMap): string[] {
  const missing: string[] = [];
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
    const marker = L.circleMarker(pos(p), {
      radius: 6,
      color: "#ff5252",
      weight: 2,
      fillColor: "#ff5252",
      fillOpacity: 0.8,
    }).addTo(map!);
    bindFocusPopup(trackFocus(marker, floor, { opacity: 1, fillOpacity: 0.8 }, { opacity: 0.15, fillOpacity: 0.1 }), entries, tr, floor);
  }
  return missing;
}

/* ---- 生命周期：清理旧地图实例与状态 ---- */

function cleanup() {
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
  mapData = maps.find((m) => m.key === mapParam) || maps.find((m) => m.key === "customs")!;

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
    // 纵向单选楼层（不含地面层），再次点击已选楼层取消选择回到地面层
    mapData.layers.forEach((layer) => {
      const row = document.createElement("div");
      row.className = "floor-item";
      row.innerHTML = `<span class="dot"></span><span>${layer.name}</span>`;
      row.onclick = () => setFloor(activeFloor === layer ? null : layer);
      floorPanel.appendChild(row);
    });
    floorPanel.hidden = false;
  }

  mapBounds = getBounds(mapData.bounds);
  map = L.map(mapEl.value!, {
    crs: getCRS(mapData),
    minZoom: mapData.minZoom,
    maxZoom: Math.max(7, mapData.maxZoom),
    maxBounds: getScaledBounds(mapData.bounds, 1.5),
    attributionControl: false,
    zoomControl: true,
  });
  map.fitBounds(mapBounds, { animate: false });
  const updateZoom = () => {
    zoomInfo.value = `缩放: ${map!.getZoom().toFixed(1)}`;
  };
  map.on("zoomend", updateZoom);
  updateZoom();
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

  if (!qIds.length) {
    setStatus("");
    return;
  }

  setStatus("加载任务数据 ...");
  const tasksData = (await fetchCached<TasksResponse>(`/${gameMode}/tasks`)).data;
  const tr = (await fetchCached<TrResponse>(`/${gameMode}/tasks_${lang}`)).data;
  const missing = findAndDraw(tasksData, tr);
  buildObjectiveList(tr);

  if (focusLayers.length) {
    // 只有所有点位在同一楼层时才自动切层，否则保持主层视图
    const floors = new Set(focusLayers.map((l) => l._floor || null));
    setFloor(floors.size === 1 ? [...floors][0] : null);
    const group = L.featureGroup(focusLayers);
    // 单点小范围需要大 padding 避免过度放大；多点按点位分布自适应。
    // animate:false：缩放动画中气泡位置是变换中的中间值，去遮挡检测会拿到错误位置
    map.fitBounds(group.getBounds().pad(qIds.length > 1 ? 0.3 : 2), {
      maxZoom: mapData.maxZoom,
      animate: false,
    });
    // 所有点位都弹出自说明气泡（autoClose:false 保证同时可见）；
    // 距离太近互相遮挡的气泡只保留先打开的，其余点击高亮区域查看
    const keptRects: DOMRect[] = [];
    for (const l of focusLayers) {
      const popup = l.getPopup();
      if (!popup) continue;
      l.openPopup();
      const el = popup.getElement();
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const overlap = keptRects.some(
        (k) => !(r.right < k.left || r.left > k.right || r.bottom < k.top || r.top > k.bottom),
      );
      if (overlap) l.closePopup();
      else keptRects.push(r);
    }
    setStatus(missing.length ? `未找到: ${missing.join(", ")}` : "");
  } else {
    setStatus(`未找到目标: ${qIds.join(", ")}`);
  }
}

onMounted(() => {
  init().catch((e: unknown) => setStatus(`加载失败: ${e instanceof Error ? e.message : String(e)}`));
});

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
  cleanup();
});
</script>

<template>
  <div class="map-page">
    <div class="map-topbar">
      <select ref="styleSelectEl" title="地图样式">
        <option value="">自动</option>
        <option value="svg">抽象图</option>
        <option value="tile">卫星图</option>
      </select>
      <span class="map-status">{{ status }}</span>
      <span class="map-zoom-info">{{ zoomInfo }}</span>
      <span class="map-raid-time">{{ raidTime }}</span>
    </div>
    <div ref="floorPanelEl" class="map-floor-panel" hidden></div>
    <div ref="objPanelEl" class="map-obj-panel" hidden></div>
    <div ref="markerPanelEl" class="map-marker-panel" hidden></div>
    <div ref="mapEl" class="map-leaflet"></div>
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

.map-page .map-topbar {
  position: absolute;
  top: 10px;
  left: 50px;
  z-index: 1000;
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

.map-page .map-status:empty {
  display: none;
}

.map-page .map-zoom-info,
.map-page .map-raid-time {
  white-space: nowrap;
  color: #9d9d9d;
  font-variant-numeric: tabular-nums;
}

/* SVG 地图：非当前楼层的分组隐藏（移植自 tarkov-dev） */
.map-page .hidden-layer {
  display: none;
}

/* 楼层单选面板：缩放按钮下方纵向排列 */
.map-page .map-floor-panel {
  position: absolute;
  top: 86px;
  left: 10px;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  background: rgba(20, 21, 24, 0.85);
  border: 1px solid #3a3b40;
  border-radius: 6px;
  padding: 4px;
  color: #d8d8d8;
  font: 13px/1.4 sans-serif;
  min-width: 130px;
}

.map-page .map-floor-panel[hidden] {
  display: none;
}

/* 任务目标列表：楼层选择器下方，点击单聚焦对应目标 */
.map-page .map-obj-panel {
  position: absolute;
  left: 10px;
  z-index: 1000;
  width: 220px;
  overflow-y: auto;
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

.map-page .obj-item {
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
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
  font-weight: 700;
  padding: 2px 4px 6px;
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
</style>
