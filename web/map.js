"use strict";

/* 纯静态塔科夫任务地图：?map=<地图key>&q=<区域/任务物品id,逗号分隔>&task=<任务id>&mode=regular&lang=zh
 * 坐标系/投影与楼层分层逻辑移植自 the-hideout/tarkov-dev (src/pages/map/index.jsx)。 */

const MAP_ALIASES = {
  "ground-zero-21": "ground-zero",
  "night-factory": "factory",
  "the-lab-dark": "the-lab",
};
const CACHE_TTL = 7 * 24 * 3600 * 1000;
const JSON_BASE = "https://json.tarkov.dev";

const params = new URLSearchParams(location.search);
const mapParam = MAP_ALIASES[params.get("map")] || params.get("map") || "customs";
const qIds = (params.get("q") || "").split(",").filter(Boolean);
const taskParam = params.get("task") || "";  // 指定任务 id 时只匹配该任务的目标
const gameMode = params.get("mode") || "regular";
const lang = params.get("lang") || "zh";
const styleParam = params.get("style") || "";

const statusEl = document.getElementById("status");
const setStatus = (msg) => { statusEl.textContent = msg; };

/* ---- 坐标系（移植自 tarkov-dev） ---- */

function applyRotation(latLng, rotation) {
  if (!latLng.lng && !latLng.lat) return L.latLng(0, 0);
  if (!rotation) return latLng;
  const angle = (rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const { lng: x, lat: y } = latLng;
  return L.latLng(x * sin + y * cos, x * cos - y * sin);
}

function getCRS(mapData) {
  let scaleX = 1, scaleY = 1, marginX = 0, marginY = 0;
  if (mapData && mapData.transform) {
    scaleX = mapData.transform[0];
    scaleY = mapData.transform[2] * -1;
    marginX = mapData.transform[1];
    marginY = mapData.transform[3];
  }
  return L.extend({}, L.CRS.Simple, {
    transformation: new L.Transformation(scaleX, marginX, scaleY, marginY),
    projection: L.extend({}, L.Projection.LonLat, {
      project: (latLng) =>
        L.Projection.LonLat.project(applyRotation(latLng, mapData.coordinateRotation)),
      unproject: (point) =>
        applyRotation(L.Projection.LonLat.unproject(point), mapData.coordinateRotation * -1),
    }),
  });
}

function pos(position) {
  return [position.z, position.x];
}

function getBounds(bounds) {
  if (!bounds) return undefined;
  return L.latLngBounds([bounds[0][1], bounds[0][0]], [bounds[1][1], bounds[1][0]]);
}

function getScaledBounds(bounds, scale) {
  const cx = (bounds[0][0] + bounds[1][0]) / 2;
  const cy = (bounds[0][1] + bounds[1][1]) / 2;
  const w = (bounds[1][0] - bounds[0][0]) * scale;
  const h = (bounds[1][1] - bounds[0][1]) * scale;
  return [
    [cy - h / 2, cx - w / 2],
    [cy + h / 2, cx + w / 2],
  ];
}

/* ---- 数据加载（localStorage 缓存 7 天） ---- */

async function fetchCached(url) {
  const key = "cache:" + url;
  try {
    const hit = JSON.parse(localStorage.getItem(key));
    if (hit && Date.now() - hit.t < CACHE_TTL) return hit.d;
  } catch (e) { /* 缓存损坏则重新下载 */ }
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url} → HTTP ${resp.status}`);
  const data = await resp.json();
  try {
    localStorage.setItem(key, JSON.stringify({ t: Date.now(), d: data }));
  } catch (e) { /* 存储满则放弃缓存 */ }
  return data;
}

/* ---- 楼层状态 ---- */

let map = null;
let mapData = null;
let mapBounds = null;
let svgRoot = null;        // 内联 SVG 的根节点（仅 SVG 底图）
let baseTileLayer = null;  // 瓦片底图（仅瓦片底图）
let floorOverlay = null;   // 当前楼层的瓦片叠加层
let activeFloor = null;    // 当前楼层（null = 主层）
let floorPanel = null;     // 楼层单选面板
const focusLayers = [];    // 聚焦绘制物，_floor 记录所属楼层
const labelMarkers = [];   // 区域标签，_vis 记录楼层可见性

function inExtentBounds(boundsEntry, position) {
  // bounds 条目是游戏坐标的对角点 [[x, z], [x, z], 名称?]
  const [c1, c2] = boundsEntry;
  return position.x >= Math.min(c1[0], c2[0]) && position.x <= Math.max(c1[0], c2[0])
      && position.z >= Math.min(c1[1], c2[1]) && position.z <= Math.max(c1[1], c2[1]);
}

function floorMatch(top, bottom, position, extents) {
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

function layerForZone(position) {
  // 楼层归属按触发区域中心高度（position.y）判定：
  // 大体积触发区的 top/bottom 常横跨多层（部分重叠会误判），中心高度才是实际所在层
  for (const layer of mapData.layers || []) {
    if (floorMatch(position.y, position.y, position, layer.extents)) return layer;
  }
  return null;
}

function labelVisibility(top, bottom, position) {
  // 移植自 tarkov-dev markerIsOnActiveLayer 的标签可见性判定：
  // fullBounded: 完全落在该层（匹配 extent 带水平 bounds）→ 该层未激活时隐藏
  // matched: 与该层高度/bounds 有重叠 → 该层激活时显示
  // onBase: 高度落在主层 heightRange 内 → 主层视图显示
  const fullBounded = [], matched = [];
  for (const layer of mapData.layers || []) {
    const m = floorMatch(top, bottom, position, layer.extents);
    if (!m) continue;
    matched.push(layer);
    if (m.type === "full" && m.bounded) fullBounded.push(layer);
  }
  const hr = mapData.heightRange || [-Infinity, Infinity];
  const onBase = top >= hr[0] && bottom < hr[1];
  return { fullBounded, matched, onBase };
}

function labelVisible(v, layer) {
  for (const l of v.fullBounded) if (l !== layer) return false;
  return layer ? v.matched.includes(layer) : v.onBase;
}

function setFloor(layer) {
  activeFloor = layer;
  // SVG 底图：切换楼层分组显隐，非主层时基底分组调暗（样式移植自 tarkov-dev）
  if (svgRoot) {
    const svgEl = svgRoot.parentElement;
    svgEl.classList.toggle("off-level", !!layer);
    const activeId = layer ? layer.svgLayer : mapData.svgLayer;
    for (const g of svgRoot.children) {
      if (g.nodeName !== "g" || !g.id || g.classList.contains("base-layer")) continue;
      const show = g.id === activeId || (!!activeId && g.dataset.keepWithGroup === activeId);
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
      bounds: mapBounds,
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
  // 面板选中态
  if (floorPanel) {
    [...floorPanel.children].forEach((el, i) =>
      el.classList.toggle("active", mapData.layers[i] === layer));
  }
}

/* ---- 地图底层 ---- */

async function addSvgLayer(mapData, bounds) {
  const svgElement = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svgElement.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const text = await (await fetch(mapData.svgPath)).text();
  svgElement.innerHTML = text;
  svgRoot = svgElement.children[0];
  svgElement.setAttribute("viewBox", svgRoot.getAttribute("viewBox"));
  // 顶层 g 节点里只保留本图基准楼层，其余隐藏
  for (const g of [...svgRoot.children].filter((c) => c.nodeName === "g" && c.id)) {
    if (g.id === mapData.svgLayer || g.dataset["keepWithGroup"] === mapData.svgLayer) {
      g.classList.add("base-layer");
    } else {
      g.classList.add("hidden-layer", "overlay-layer");
    }
  }
  const svgBounds = mapData.svgBounds ? getBounds(mapData.svgBounds) : bounds;
  L.svgOverlay(svgElement, svgBounds, { className: "base-layer" }).addTo(map);
}

function addTileLayer(mapData, bounds) {
  baseTileLayer = L.tileLayer(mapData.tilePath, {
    tileSize: mapData.tileSize || 256,
    bounds,
    maxZoom: Math.max(7, mapData.maxZoom),
    maxNativeZoom: mapData.maxZoom,
  }).addTo(map);
}

function addLabels(mapData) {
  if (!mapData.labels || !mapData.labels.length) return;
  for (const label of mapData.labels) {
    const top = label.top ?? 1000;
    const bottom = label.bottom ?? -1000;
    const position = { x: label.position[0], z: label.position[1] };
    const marker = L.marker(pos(position), {
      icon: L.divIcon({
        html: `<div class="label" style="font-size: ${label.size || 100}%; transform: translate3d(-50%, -50%, 0) rotate(${label.rotation || 0}deg)">${label.text}</div>`,
        className: "map-area-label",
      }),
      interactive: false,
      zIndexOffset: -100000,
    }).addTo(map);
    marker._vis = labelVisibility(top, bottom, position);
    labelMarkers.push(marker);
  }
}

/* ---- 任务目标定位 ---- */

function zoneLatLngs(zone) {
  if (zone.outline && zone.outline.length) return zone.outline.map(pos);
  // 无轮廓时用 position + size 画矩形
  const { x, z } = zone.position;
  const sx = (zone.size && zone.size.x) / 2 || 3;
  const sz = (zone.size && zone.size.z) / 2 || 3;
  return [
    [z - sz, x - sx],
    [z - sz, x + sx],
    [z + sz, x + sx],
    [z + sz, x - sx],
  ];
}

function popupHtml(entries, tr, floor) {
  // 一个点位可能被多个任务/目标复用，气泡内逐条列出；
  // 不同目标译文相同时（如"找到"+"标记"译成同一句）只显示一次
  const bodies = [];
  for (const { task, ob } of entries) {
    const name = tr[task.name] || task.normalizedName || task.name;
    const desc = tr[ob.description] || ob.description;
    const s = `<b>${name}</b><br>${desc}`;
    if (!bodies.includes(s)) bodies.push(s);
  }
  const floorLine = floor ? `<br><i>楼层: ${floor.name}</i>` : "";
  return bodies.join("<hr>") + floorLine;
}

function trackFocus(layer, floor, normal, dim) {
  layer._floor = floor;
  layer._normal = normal;
  layer._dim = dim;
  focusLayers.push(layer);
  return layer;
}

function ringContains(ring, latlng) {
  // 射线法判断点是否在多边形内（平面坐标足够精确）
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].lng, yi = ring[i].lat;
    const xj = ring[j].lng, yj = ring[j].lat;
    if (((yi > latlng.lat) !== (yj > latlng.lat))
        && (latlng.lng < ((xj - xi) * (latlng.lat - yi)) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function layerContainsPoint(layer, latlng) {
  if (layer instanceof L.CircleMarker) {
    const d = map.latLngToLayerPoint(layer.getLatLng())
      .distanceTo(map.latLngToLayerPoint(latlng));
    return d <= layer.getRadius() + 4;
  }
  return ringContains(layer.getLatLngs()[0], latlng);
}

function bindFocusPopup(layer, entries, tr, floor) {
  // autoClose/closeOnClick:false:初始自动展开的多点气泡保持同时可见;
  // autoPan:false:打开气泡不拖动地图,保持按全部点位自适应的视图
  layer.bindPopup(popupHtml(entries, tr, floor), { autoClose: false, closeOnClick: false, autoPan: false });
  // 接管点击（去掉 bindPopup 默认的点击弹出）：
  // 同一位置叠了多个目标时，点击在它们之间循环切换（气泡 + 楼层）
  layer.off("click");
  layer.on("click", (e) => {
    const stack = focusLayers.filter((l) => l.getPopup() && layerContainsPoint(l, e.latlng));
    const openIdx = stack.findIndex((l) => l.isPopupOpen());
    const next = openIdx >= 0 ? stack[(openIdx + 1) % stack.length] : layer;
    for (const l of focusLayers) l.closePopup();
    next.openPopup();
    setFloor(next._floor || null);
  });
}

function findAndDraw(tasksData, tr) {
  const missing = [];
  const zoneHits = new Map();  // zone.id -> { zone, entries: [{task, ob}] }，跨任务去重
  const itemHits = new Map();  // "x,z" -> { p, entries }
  for (const qid of qIds) {
    let found = false;
    for (const task of Object.values(tasksData.tasks)) {
      if (taskParam && task.id !== taskParam) continue;
      for (const ob of task.objectives || []) {
        for (const zone of ob.zones || []) {
          if (zone.id !== qid || !mapData.apiIds.includes(zone.map)) continue;
          found = true;
          if (!zoneHits.has(zone.id)) zoneHits.set(zone.id, { zone, entries: [] });
          zoneHits.get(zone.id).entries.push({ task, ob });
        }
        if (ob.questItem === qid) {
          for (const loc of ob.possibleLocations || []) {
            if (!mapData.apiIds.includes(loc.map)) continue;
            for (const p of loc.positions || []) {
              found = true;
              const k = `${p.x},${p.z}`;
              if (!itemHits.has(k)) itemHits.set(k, { p, entries: [] });
              itemHits.get(k).entries.push({ task, ob });
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
    }).addTo(map);
    bindFocusPopup(poly, entries, tr, floor);
    trackFocus(poly, floor,
      { opacity: 1, fillOpacity: 0.15 },
      { opacity: 0.15, fillOpacity: 0.03 });
  }
  for (const { p, entries } of itemHits.values()) {
    const floor = layerForZone(p);
    const marker = L.circleMarker(pos(p), {
      radius: 6,
      color: "#ff5252",
      weight: 2,
      fillColor: "#ff5252",
      fillOpacity: 0.8,
    }).addTo(map);
    bindFocusPopup(marker, entries, tr, floor);
    trackFocus(marker, floor,
      { opacity: 1, fillOpacity: 0.8 },
      { opacity: 0.15, fillOpacity: 0.1 });
  }
  return missing;
}

/* ---- 主流程 ---- */

async function main() {
  const maps = await (await fetch("maps.json")).json();
  mapData = maps.find((m) => m.key === mapParam) || maps.find((m) => m.key === "customs");

  const select = document.getElementById("map-select");
  for (const m of maps) {
    const opt = document.createElement("option");
    opt.value = m.key;
    opt.textContent = m.key;
    select.appendChild(opt);
  }
  select.value = mapData.key;
  select.onchange = () => {
    params.set("map", select.value);
    params.delete("q");
    location.search = params.toString();
  };
  const styleSelect = document.getElementById("style-select");
  styleSelect.value = styleParam;
  styleSelect.onchange = () => {
    if (styleSelect.value) params.set("style", styleSelect.value);
    else params.delete("style");
    location.search = params.toString();
  };
  floorPanel = document.getElementById("floor-panel");
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
  map = L.map("map", {
    crs: getCRS(mapData),
    minZoom: mapData.minZoom,
    maxZoom: Math.max(7, mapData.maxZoom),
    maxBounds: getScaledBounds(mapData.bounds, 1.5),
    attributionControl: false,
    zoomControl: true,
  });
  map.fitBounds(mapBounds, { animate: false });

  const useSvg = mapData.svgPath && styleParam !== "tile";
  const useTile = mapData.tilePath && (styleParam === "tile" || !mapData.svgPath);
  try {
    if (useSvg) await addSvgLayer(mapData, mapBounds);
    else if (useTile) addTileLayer(mapData, mapBounds);
  } catch (e) {
    // SVG 加载失败时回退瓦片
    if (mapData.tilePath) addTileLayer(mapData, mapBounds);
  }
  addLabels(mapData);
  setFloor(null);  // 应用初始标签可见性：完全属于某楼层的标签在主层隐藏

  // 点击地图空白处关闭所有气泡。注意不能用 propagatedFrom 判断：
  // 点击高亮时地图容器也作为直接目标触发一次 click（无 propagatedFrom），
  // 所以统一用点击坐标是否落在某个高亮内来区分（与循环切换的几何判定一致）
  map.on("click", (e) => {
    if (e.latlng && focusLayers.some((l) => l.getPopup() && layerContainsPoint(l, e.latlng))) return;
    for (const l of focusLayers) l.closePopup();
  });

  if (!qIds.length) {
    setStatus("");
    return;
  }

  setStatus("加载任务数据 ...");
  const tasksData = (await fetchCached(`${JSON_BASE}/${gameMode}/tasks`)).data;
  const tr = (await fetchCached(`${JSON_BASE}/${gameMode}/tasks_${lang}`)).data;
  const missing = findAndDraw(tasksData, tr);

  if (focusLayers.length) {
    // 只有所有点位在同一楼层时才自动切层，否则保持主层视图
    const floors = new Set(focusLayers.map((l) => l._floor || null));
    setFloor(floors.size === 1 ? [...floors][0] : null);
    const group = L.featureGroup(focusLayers);
    // 单点小范围需要大 padding 避免过度放大；多点按点位分布自适应。
    // animate:false：缩放动画中气泡位置是变换中的中间值，去遮挡检测会拿到错误位置
    map.fitBounds(group.getBounds().pad(qIds.length > 1 ? 0.3 : 2), { maxZoom: mapData.maxZoom, animate: false });
    // 所有点位都弹出自说明气泡（autoClose:false 保证同时可见）；
    // 距离太近互相遮挡的气泡只保留先打开的，其余点击高亮区域查看
    const keptRects = [];
    for (const l of focusLayers) {
      const popup = l.getPopup();
      if (!popup) continue;
      l.openPopup();
      const el = popup.getElement();
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const overlap = keptRects.some((k) =>
        !(r.right < k.left || r.left > k.right || r.bottom < k.top || r.top > k.bottom));
      if (overlap) l.closePopup();
      else keptRects.push(r);
    }
    setStatus(missing.length ? `未找到: ${missing.join(", ")}` : "");
  } else {
    setStatus(`未找到目标: ${qIds.join(", ")}`);
  }
}

main().catch((e) => setStatus(`加载失败: ${e.message}`));
