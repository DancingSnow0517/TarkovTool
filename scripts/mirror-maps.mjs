/** 镜像地图文件到本地静态目录（移植自 web/mirror_maps.py，输出目录从 web/ 迁移到 public/）。
 *
 * - 所有地图的 SVG 底图 -> public/assets/maps/svg/
 * - 纯瓦片地图（无 SVG：实验室/破冰船/迷宫）的全部瓦片 -> public/assets/maps/<原路径>/
 *   （卫星图瓦片体积过大（估算约 1.2GB）超出 GitHub Pages 限制，有 SVG 的地图瓦片不镜像）
 * - 同步重写 public/maps.json 中对应路径为本地相对路径
 *
 * 瓦片坐标按 web/map.js 的 CRS 投影（移植自 tarkov-dev）复算。
 * 远端 404 的瓦片不落盘，本地同源 404 行为与远端一致。
 * 已存在的文件跳过，可中断后重跑续传。
 *
 * 用法: pnpm run mirror-maps
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const ASSETS_PREFIX = "https://assets.tarkov.dev/maps/";
const LOCAL_PREFIX = "assets/maps/";
// 无 SVG 底图、必须镜像瓦片才能显示的地图
const TILE_ONLY_MAPS = ["the-lab", "icebreaker", "the-labyrinth"];

const CONCURRENCY = 50;
const FETCH_TIMEOUT_MS = 60_000;

/** 按 map.js getCRS 的变换复算某缩放等级下的瓦片编号范围 */
function tileRange(md, z) {
  const [a, b, c, d] = md.transform || [1, 0, -1, 0];
  const rot = ((md.coordinateRotation || 0) * Math.PI) / 180;
  const ts = md.tileSize || 256;
  const [[x1, z1], [x2, z2]] = md.bounds;
  const xs = [];
  const ys = [];
  for (const [gx, gz] of [[x1, z1], [x1, z2], [x2, z1], [x2, z2]]) {
    const lat = gx * Math.sin(rot) + gz * Math.cos(rot);
    const lng = gx * Math.cos(rot) - gz * Math.sin(rot);
    xs.push((2 ** z) * (a * lng + b) / ts);
    ys.push((2 ** z) * (-c * lat + d) / ts);
  }
  return [Math.floor(Math.min(...xs)), Math.floor(Math.max(...xs)),
          Math.floor(Math.min(...ys)), Math.floor(Math.max(...ys))];
}

/**
 * jobs: [[url, dest]]；跳过已存在文件；404/失败的不落盘，返回缺漏数。
 * 手写并发池，同时最多 CONCURRENCY 个下载。
 */
async function downloadAll(jobs, label) {
  jobs = jobs.filter(([, dest]) => !existsSync(dest));
  if (!jobs.length) {
    console.log(`${label}: 全部已存在，跳过`);
    return 0;
  }
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < jobs.length) {
      const [url, dest] = jobs[next++];
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (res.ok) {
          await mkdir(path.dirname(dest), { recursive: true });
          await writeFile(dest, Buffer.from(await res.arrayBuffer()));
        }
        // HTTP 错误（如 404）：不落盘，与 curl -f 行为一致
      } catch (err) {
        // 网络错误：不落盘，交由下一遍重试
        console.warn(`${label}: 下载失败（稍后重试）: ${url} (${err.message})`);
      }
      done++;
      if (done % 200 === 0 || done === jobs.length) {
        console.log(`${label}: ${done}/${jobs.length}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return jobs.filter(([, dest]) => !existsSync(dest)).length;
}

async function mirrorSvg(md) {
  const svgPath = md.svgPath;
  if (!svgPath || !svgPath.startsWith(ASSETS_PREFIX)) return;
  const local = LOCAL_PREFIX + svgPath.slice(ASSETS_PREFIX.length);
  const dest = path.join(PUBLIC_DIR, local);
  if (await downloadAll([[svgPath, dest]], `SVG ${md.key}`)) {
    throw new Error(`SVG 下载失败: ${svgPath}`);
  }
  md.svgPath = local;
}

async function mirrorTiles(md) {
  const paths = [];
  if ((md.tilePath || "").startsWith(ASSETS_PREFIX)) paths.push(md.tilePath);
  for (const layer of md.layers || []) {
    if ((layer.tilePath || "").startsWith(ASSETS_PREFIX)) paths.push(layer.tilePath);
  }

  const jobs = [];
  for (const p of paths) {
    for (let z = md.minZoom; z <= md.maxZoom; z++) {
      const [xa, xb, ya, yb] = tileRange(md, z);
      for (let x = xa; x <= xb; x++) {
        for (let y = ya; y <= yb; y++) {
          const rel = p.slice(ASSETS_PREFIX.length)
            .replace("{z}", z).replace("{x}", x).replace("{y}", y);
          jobs.push([ASSETS_PREFIX + rel, path.join(PUBLIC_DIR, LOCAL_PREFIX, rel)]);
        }
      }
    }
  }

  // 两遍：第二遍重试网络错误，剩余缺漏即远端 404 的空白格（与远端行为一致）
  let missing = await downloadAll(jobs, md.key);
  if (missing) {
    console.log(`${md.key}: 重试 ${missing} 个缺漏瓦片`);
    missing = await downloadAll(jobs, md.key);
  }
  if (missing) {
    console.log(`${md.key}: ${missing} 个瓦片远端不存在(404)，跳过`);
  }

  for (const p of paths) {
    const local = LOCAL_PREFIX + p.slice(ASSETS_PREFIX.length);
    if (md.tilePath === p) md.tilePath = local;
    for (const layer of md.layers || []) {
      if (layer.tilePath === p) layer.tilePath = local;
    }
  }
}

async function main() {
  const mapsFile = path.join(PUBLIC_DIR, "maps.json");
  const maps = JSON.parse(await readFile(mapsFile, "utf-8"));
  for (const md of maps) {
    await mirrorSvg(md);
    if (TILE_ONLY_MAPS.includes(md.key)) {
      await mirrorTiles(md);
    } else {
      console.log(`${md.key}: 仅 SVG`);
    }
  }
  await writeFile(mapsFile, JSON.stringify(maps, null, 2), "utf-8");
  console.log("maps.json 已重写为本地路径");
}

await main();
