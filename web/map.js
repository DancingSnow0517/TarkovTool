"use strict";

/* 纯静态塔科夫任务地图：?map=<地图key>&q=<区域/任务物品id,逗号分隔>&mode=regular&lang=zh
 * 坐标系/投影逻辑移植自 the-hideout/tarkov-dev (src/pages/map/index.jsx)。 */

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

/* ---- 地图底层 ---- */

async function addSvgLayer(map, mapData, bounds) {
  const svgElement = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svgElement.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const text = await (await fetch(mapData.svgPath)).text();
  svgElement.innerHTML = text;
  svgElement.setAttribute("viewBox", svgElement.children[0].getAttribute("viewBox"));
  // 顶层 g 节点里只保留本图基准楼层，其余隐藏
  for (const g of [...svgElement.children[0].children].filter((c) => c.nodeName === "g" && c.id)) {
    if (g.id === mapData.svgLayer || g.dataset["keepWithGroup"] === mapData.svgLayer) {
      g.classList.add("base-layer");
    } else {
      g.classList.add("hidden-layer", "overlay-layer");
    }
  }
  const svgBounds = mapData.svgBounds ? getBounds(mapData.svgBounds) : bounds;
  L.svgOverlay(svgElement, svgBounds, { className: "base-layer" }).addTo(map);
}

function addTileLayer(map, mapData, bounds) {
  L.tileLayer(mapData.tilePath, {
    tileSize: mapData.tileSize || 256,
    bounds,
    maxZoom: Math.max(7, mapData.maxZoom),
    maxNativeZoom: mapData.maxZoom,
  }).addTo(map);
}

function addLabels(map, mapData) {
  if (!mapData.labels || !mapData.labels.length) return;
  const range = mapData.heightRange || [-1000, 1000];
  const midY = (range[1] - range[0]) / 2 + range[0];
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

function popupHtml(task, ob, tr) {
  const name = tr[task.name] || task.normalizedName || task.name;
  const desc = tr[ob.description] || ob.description;
  return `<b>${name}</b><br>${desc}`;
}

function findAndDraw(map, mapData, tasksData, tr) {
  const drawn = [];
  const missing = [];
  for (const qid of qIds) {
    let found = false;
    for (const task of Object.values(tasksData.tasks)) {
      for (const ob of task.objectives || []) {
        for (const zone of ob.zones || []) {
          if (zone.id !== qid || !mapData.apiIds.includes(zone.map)) continue;
          found = true;
          const poly = L.polygon(zoneLatLngs(zone), {
            color: "#ffd54a",
            weight: 3,
            fillColor: "#ffd54a",
            fillOpacity: 0.15,
            className: "zone-focus",
          }).addTo(map).bindPopup(popupHtml(task, ob, tr));
          drawn.push(poly);
        }
        if (ob.questItem === qid) {
          for (const loc of ob.possibleLocations || []) {
            if (!mapData.apiIds.includes(loc.map)) continue;
            for (const p of loc.positions || []) {
              found = true;
              drawn.push(
                L.circleMarker(pos(p), {
                  radius: 6,
                  color: "#ff5252",
                  weight: 2,
                  fillColor: "#ff5252",
                  fillOpacity: 0.8,
                }).addTo(map).bindPopup(popupHtml(task, ob, tr))
              );
            }
          }
        }
      }
    }
    if (!found) missing.push(qid);
  }
  return { drawn, missing };
}

/* ---- 主流程 ---- */

async function main() {
  const maps = await (await fetch("maps.json")).json();
  const mapData = maps.find((m) => m.key === mapParam) || maps.find((m) => m.key === "customs");

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

  const bounds = getBounds(mapData.bounds);
  const map = L.map("map", {
    crs: getCRS(mapData),
    minZoom: mapData.minZoom,
    maxZoom: Math.max(7, mapData.maxZoom),
    maxBounds: getScaledBounds(mapData.bounds, 1.5),
    attributionControl: false,
    zoomControl: true,
  });
  map.fitBounds(bounds);

  const useSvg = mapData.svgPath && styleParam !== "tile";
  const useTile = mapData.tilePath && (styleParam === "tile" || !mapData.svgPath);
  try {
    if (useSvg) await addSvgLayer(map, mapData, bounds);
    else if (useTile) addTileLayer(map, mapData, bounds);
  } catch (e) {
    // SVG 加载失败时回退瓦片
    if (mapData.tilePath) addTileLayer(map, mapData, bounds);
  }
  addLabels(map, mapData);

  if (!qIds.length) {
    setStatus("");
    return;
  }

  setStatus("加载任务数据 ...");
  const tasksData = (await fetchCached(`${JSON_BASE}/${gameMode}/tasks`)).data;
  const tr = (await fetchCached(`${JSON_BASE}/${gameMode}/tasks_${lang}`)).data;
  const { drawn, missing } = findAndDraw(map, mapData, tasksData, tr);

  if (drawn.length) {
    const group = L.featureGroup(drawn);
    map.fitBounds(group.getBounds().pad(2), { maxZoom: mapData.maxZoom });
    const first = drawn.find((l) => l.getPopup());
    if (first) first.openPopup();
    setStatus(missing.length ? `未找到: ${missing.join(", ")}` : "");
  } else {
    setStatus(`未找到目标: ${qIds.join(", ")}`);
  }
}

main().catch((e) => setStatus(`加载失败: ${e.message}`));
