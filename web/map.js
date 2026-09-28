"use strict";

/* 纯静态塔科夫任务地图：?map=<地图key>&q=<区域/任务物品id,逗号分隔>&mode=regular&lang=zh
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
let floorOverlay = null;   // 当前楼层的瓦片叠加层
let activeFloor = null;    // 当前楼层（null = 主层）
const focusLayers = [];    // 聚焦绘制物，_floor 记录所属楼层

function inExtentBounds(boundsEntry, position) {
  // bounds 条目是游戏坐标的对角点 [[x, z], [x, z], 名称?]
  const [c1, c2] = boundsEntry;
  return position.x >= Math.min(c1[0], c2[0]) && position.x <= Math.max(c1[0], c2[0])
      && position.z >= Math.min(c1[1], c2[1]) && position.z <= Math.max(c1[1], c2[1]);
}

function floorMatch(top, bottom, position, extents) {
  // 移植自 tarkov-dev markerIsOnLayer：高度重叠 + 水平 bounds 包含
  for (const ext of extents || []) {
    const [lo, hi] = ext.height || [-Infinity, Infinity];
    if (top >= lo && bottom < hi) {
      const full = bottom >= lo && top <= hi;
      if (ext.bounds) {
        for (const b of ext.bounds) {
          if (inExtentBounds(b, position)) return full ? "full" : "partial";
        }
      } else {
        return full ? "full" : "partial";
      }
    }
  }
  return false;
}

function layerForZone(top, bottom, position) {
  // 完全包含优先（官方会把完全落在某层的标记从主层隐藏）；否则归到首个部分重叠的楼层
  let partial = null;
  for (const layer of mapData.layers || []) {
    const m = floorMatch(top, bottom, position, layer.extents);
    if (m === "full") return layer;
    if (m === "partial" && !partial) partial = layer;
  }
  return partial;
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
  // 非当前楼层的聚焦绘制物调暗
  for (const l of focusLayers) {
    const onFloor = (l._floor || null) === layer;
    l.setStyle(onFloor ? l._normal : l._dim);
  }
  const select = document.getElementById("floor-select");
  if (select.options.length) {
    select.value = layer ? String(mapData.layers.indexOf(layer)) : "";
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
  L.tileLayer(mapData.tilePath, {
    tileSize: mapData.tileSize || 256,
    bounds,
    maxZoom: Math.max(7, mapData.maxZoom),
    maxNativeZoom: mapData.maxZoom,
  }).addTo(map);
}

function addLabels(mapData) {
  if (!mapData.labels || !mapData.labels.length) return;
  for (const label of mapData.labels) {
    L.marker(pos({ x: label.position[0], z: label.position[1] }), {
      icon: L.divIcon({
        html: `<div class="label" style="font-size: ${label.size || 100}%; transform: translate3d(-50%, -50%, 0) rotate(${label.rotation || 0}deg)">${label.text}</div>`,
        className: "map-area-label",
      }),
      interactive: false,
      zIndexOffset: -100000,
    }).addTo(map);
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

function popupHtml(task, ob, tr, floor) {
  const name = tr[task.name] || task.normalizedName || task.name;
  const desc = tr[ob.description] || ob.description;
  const floorLine = floor ? `<br><i>楼层: ${floor.name}</i>` : "";
  return `<b>${name}</b><br>${desc}${floorLine}`;
}

function trackFocus(layer, floor, normal, dim) {
  layer._floor = floor;
  layer._normal = normal;
  layer._dim = dim;
  focusLayers.push(layer);
  return layer;
}

function findAndDraw(tasksData, tr) {
  const missing = [];
  for (const qid of qIds) {
    let found = false;
    for (const task of Object.values(tasksData.tasks)) {
      for (const ob of task.objectives || []) {
        for (const zone of ob.zones || []) {
          if (zone.id !== qid || !mapData.apiIds.includes(zone.map)) continue;
          found = true;
          const top = zone.top ?? zone.position.y;
          const bottom = zone.bottom ?? zone.position.y;
          const floor = layerForZone(top, bottom, zone.position);
          const poly = L.polygon(zoneLatLngs(zone), {
            color: "#ffd54a",
            weight: 3,
            fillColor: "#ffd54a",
            fillOpacity: 0.15,
            className: "zone-focus",
          }).addTo(map).bindPopup(popupHtml(task, ob, tr, floor));
          trackFocus(poly, floor,
            { opacity: 1, fillOpacity: 0.15 },
            { opacity: 0.15, fillOpacity: 0.03 });
        }
        if (ob.questItem === qid) {
          for (const loc of ob.possibleLocations || []) {
            if (!mapData.apiIds.includes(loc.map)) continue;
            for (const p of loc.positions || []) {
              found = true;
              const floor = layerForZone(p.y, p.y, p);
              const marker = L.circleMarker(pos(p), {
                radius: 6,
                color: "#ff5252",
                weight: 2,
                fillColor: "#ff5252",
                fillOpacity: 0.8,
              }).addTo(map).bindPopup(popupHtml(task, ob, tr, floor));
              trackFocus(marker, floor,
                { opacity: 1, fillOpacity: 0.8 },
                { opacity: 0.15, fillOpacity: 0.1 });
            }
          }
        }
      }
    }
    if (!found) missing.push(qid);
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
  const floorSelect = document.getElementById("floor-select");
  if (mapData.layers && mapData.layers.length) {
    const baseName = (mapData.svgLayer || "Main").replace(/_/g, " ");
    floorSelect.appendChild(new Option(baseName, ""));
    mapData.layers.forEach((l, i) => floorSelect.appendChild(new Option(l.name, String(i))));
    floorSelect.hidden = false;
    floorSelect.onchange = () => {
      setFloor(floorSelect.value === "" ? null : mapData.layers[Number(floorSelect.value)]);
    };
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
  map.fitBounds(mapBounds);

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

  if (!qIds.length) {
    setStatus("");
    return;
  }

  setStatus("加载任务数据 ...");
  const tasksData = (await fetchCached(`${JSON_BASE}/${gameMode}/tasks`)).data;
  const tr = (await fetchCached(`${JSON_BASE}/${gameMode}/tasks_${lang}`)).data;
  const missing = findAndDraw(tasksData, tr);

  if (focusLayers.length) {
    // 自动切到第一个目标所在楼层
    setFloor(focusLayers[0]._floor || null);
    const group = L.featureGroup(focusLayers);
    map.fitBounds(group.getBounds().pad(2), { maxZoom: mapData.maxZoom });
    const first = focusLayers.find((l) => l.getPopup());
    if (first) first.openPopup();
    setStatus(missing.length ? `未找到: ${missing.join(", ")}` : "");
  } else {
    setStatus(`未找到目标: ${qIds.join(", ")}`);
  }
}

main().catch((e) => setStatus(`加载失败: ${e.message}`));
