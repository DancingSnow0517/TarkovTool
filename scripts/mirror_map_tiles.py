#!/usr/bin/env python3
"""把 maps.json 里引用 assets.tarkov.dev 的地图瓦片全量镜像到 Cloudflare R2。

用法：
  python scripts/mirror_map_tiles.py --stats   # 只探测统计（数量/体积），不下载不上传
  python scripts/mirror_map_tiles.py           # 正式镜像（需要 R2 环境变量）
  python scripts/mirror_map_tiles.py --force   # 忽略 R2 已存在的对象，强制重传

R2 环境变量：
  R2_ACCOUNT_ID        Cloudflare 账户 ID（ endpoint = https://<id>.r2.cloudflarestorage.com ）
  R2_ACCESS_KEY_ID     R2 API Token 的 Access Key
  R2_SECRET_ACCESS_KEY R2 API Token 的 Secret Key
  R2_BUCKET            目标 bucket 名，默认 tarkov-maps

瓦片在 R2 里的 key 保持源站路径结构，例如：
  maps/customs_0.16/main/6/40/30.png
前端只需把 https://assets.tarkov.dev/ 前缀替换为镜像域名。

瓦片范围不盲目枚举 2^z × 2^z：先按 maps.json 的 bounds + transform 复算
Leaflet 投影公式得到初始 x/y 区间，再逐条边向外探测（边上存在瓦片则扩一格），
直到四条边外都没有瓦片为止，保证覆盖源站实际存在的全部瓦片。
"""

import argparse
import concurrent.futures
import json
import math
import os
import sys
import threading
import time

import requests

# Windows 控制台默认 GBK，统一 UTF-8 输出
sys.stdout.reconfigure(encoding="utf-8")

ASSETS_BASE = "https://assets.tarkov.dev/"
MIRROR_BASE = "https://maps.tarkovkit.app/"  # maps.json 切换镜像域名后，重跑本脚本仍需识别这些模板
MAPS_JSON = os.path.join(os.path.dirname(__file__), "..", "public", "maps.json")
TILE_SIZE_DEFAULT = 256
CONCURRENCY = 32
PAD_TILES = 1
MAX_EXPAND = 16  # 边缘外扩上限，防止异常时无限扩张
RETRIES = 3


def load_tile_sets():
    """从 maps.json 收集所有指向 assets.tarkov.dev 的瓦片模板。

    返回 [{map_key, name, url_template, min_zoom, max_zoom, tile_size, bounds, transform, rotation}]
    """
    with open(MAPS_JSON, encoding="utf-8") as f:
        maps = json.load(f)
    sets = []
    for m in maps:
        bounds = m["bounds"]  # [[x1, z1], [x2, z2]] 游戏坐标
        transform = m.get("transform") or [1, 0, 1, 0]
        rotation = m.get("coordinateRotation") or 0
        min_zoom, max_zoom = m["minZoom"], m["maxZoom"]
        templates = []
        for tp_raw, owner, tile_size in (
            [(m.get("tilePath"), "main", m.get("tileSize"))]
            + [(layer.get("tilePath"), layer.get("key") or layer.get("name") or "layer", layer.get("tileSize")) for layer in (m.get("layers") or [])]
        ):
            if tp_raw and (tp_raw.startswith(ASSETS_BASE) or tp_raw.startswith(MIRROR_BASE)):
                # 统一下载源：镜像域名只是 R2 里的同一份数据，模板归一化到源站
                templates.append((owner, tp_raw.replace(MIRROR_BASE, ASSETS_BASE), tile_size))
        for name, tpl, tile_size in templates:
            sets.append({
                "map_key": m["key"],
                "name": name,
                "url_template": tpl,
                "min_zoom": min_zoom,
                "max_zoom": max_zoom,
                "tile_size": tile_size or TILE_SIZE_DEFAULT,
                "bounds": bounds,
                "transform": transform,
                "rotation": rotation,
            })
    return sets


def project_corners(ts):
    """复算 MapView.vue 的 CRS：rotation -> LonLat.project -> Transformation。

    返回投影后（未乘 zoom scale）的 min/max 坐标。
    """
    scale_x, margin_x = ts["transform"][0], ts["transform"][1]
    scale_y, margin_y = -ts["transform"][2], ts["transform"][3]
    rot = ts["rotation"]
    angle = math.radians(rot)
    cos_a, sin_a = math.cos(angle), math.sin(angle)

    xs, ys = [], []
    (x1, z1), (x2, z2) = ts["bounds"]
    for gx, gz in ((x1, z1), (x1, z2), (x2, z1), (x2, z2)):
        # getBounds: latLng(lat=z_game, lng=x_game)
        x, y = gx, gz
        if rot:
            # applyRotation: newLat = x*sin + y*cos, newLng = x*cos - y*sin
            new_lat = x * sin_a + y * cos_a
            new_lng = x * cos_a - y * sin_a
        else:
            new_lat, new_lng = y, x
        # LonLat.project -> (lng, lat)，再套 Transformation
        px = scale_x * new_lng + margin_x
        py = scale_y * new_lat + margin_y
        xs.append(px)
        ys.append(py)
    return min(xs), max(xs), min(ys), max(ys)


def tile_range(ts, zoom):
    """指定 zoom 下的瓦片 x/y 区间（含，已外扩并钳制到合法范围）。"""
    min_px, max_px, min_py, max_py = project_corners(ts)
    scale = 2 ** zoom  # CRS.Simple: scale(z) = 2^z
    n = 2 ** zoom - 1
    size = ts["tile_size"]
    x0 = max(0, math.floor(min_px * scale / size) - PAD_TILES)
    x1 = min(n, math.floor(max_px * scale / size) + PAD_TILES)
    y0 = max(0, math.floor(min_py * scale / size) - PAD_TILES)
    y1 = min(n, math.floor(max_py * scale / size) + PAD_TILES)
    return x0, x1, y0, y1


def tile_url(ts, z, x, y):
    return ts["url_template"].replace("{z}", str(z)).replace("{x}", str(x)).replace("{y}", str(y))


def r2_key(url):
    return url[len(ASSETS_BASE):]


_session_local = threading.local()


def session():
    s = getattr(_session_local, "s", None)
    if s is None:
        s = requests.Session()
        s.headers["User-Agent"] = "tarkovtool-mirror/1.0"
        _session_local.s = s
    return s


def fetch(url, method="GET"):
    """带重试的请求，返回 (status, content, headers)。网络错误重试后仍失败则抛异常。"""
    last_err = None
    for attempt in range(RETRIES):
        try:
            r = session().request(method, url, timeout=30)
            return r.status_code, (r.content if method == "GET" else b""), r.headers
        except requests.RequestException as e:
            last_err = e
            wait = 2 ** attempt
            print(f"  [重试 {attempt + 1}/{RETRIES}] {url}: {e}", flush=True)
            time.sleep(wait)
    raise RuntimeError(f"请求失败（{RETRIES} 次重试后放弃）: {url}: {last_err}")


def _any_200(ts, z, coords):
    """并发 HEAD 探测一组瓦片，任一存在即返回 True。"""
    with concurrent.futures.ThreadPoolExecutor(CONCURRENCY) as pool:
        results = pool.map(lambda c: fetch(tile_url(ts, z, *c), method="HEAD")[0], coords)
    return any(code == 200 for code in results)


def expanded_range(ts, z):
    """在投影区间基础上逐边外扩，直到四条边外都没有瓦片，覆盖源站实际范围。"""
    x0, x1, y0, y1 = tile_range(ts, z)
    n = 2 ** z - 1
    for _ in range(MAX_EXPAND):
        grew = False
        if x0 > 0 and _any_200(ts, z, [(x0 - 1, y) for y in range(y0, y1 + 1)]):
            x0 -= 1
            grew = True
        if x1 < n and _any_200(ts, z, [(x1 + 1, y) for y in range(y0, y1 + 1)]):
            x1 += 1
            grew = True
        if y0 > 0 and _any_200(ts, z, [(x, y0 - 1) for x in range(x0, x1 + 1)]):
            y0 -= 1
            grew = True
        if y1 < n and _any_200(ts, z, [(x, y1 + 1) for x in range(x0, x1 + 1)]):
            y1 += 1
            grew = True
        if not grew:
            return x0, x1, y0, y1
    print(f"  [警告] {ts['map_key']}/{ts['name']} z{z}: 外扩达到上限 {MAX_EXPAND}，区间可能仍不完整", flush=True)
    return x0, x1, y0, y1


def enumerate_tiles(ts):
    """产出该瓦片集全部候选 (z, x, y)，范围为边缘扩张后的实际覆盖区间。"""
    for z in range(ts["min_zoom"], ts["max_zoom"] + 1):
        x0, x1, y0, y1 = expanded_range(ts, z)
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                yield z, x, y


def make_r2_client():
    account = os.environ.get("R2_ACCOUNT_ID")
    ak = os.environ.get("R2_ACCESS_KEY_ID")
    sk = os.environ.get("R2_SECRET_ACCESS_KEY")
    if not (account and ak and sk):
        sys.exit("缺少环境变量：R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY")
    import boto3
    return boto3.client(
        "s3",
        endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
        aws_access_key_id=ak,
        aws_secret_access_key=sk,
        region_name="auto",
    )


class R2Uploader:
    def __init__(self, client, bucket, force=False):
        self.client = client
        self.bucket = bucket
        self.force = force
        self._exists_cache = set()
        self._lock = threading.Lock()
        if not force:
            paginator = client.get_paginator("list_objects_v2")
            for page in paginator.paginate(Bucket=bucket, Prefix="maps/"):
                for obj in page.get("Contents", []):
                    self._exists_cache.add(obj["Key"])
            print(f"R2 已有对象 {len(self._exists_cache)} 个，将跳过已存在瓦片", flush=True)

    def exists(self, key):
        with self._lock:
            return key in self._exists_cache

    def upload(self, key, data):
        self.client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType="image/png")
        with self._lock:
            self._exists_cache.add(key)


def main():
    ap = argparse.ArgumentParser(description="镜像 assets.tarkov.dev 地图瓦片到 Cloudflare R2")
    ap.add_argument("--stats", action="store_true", help="只统计瓦片数量和体积（HEAD 探测）")
    ap.add_argument("--force", action="store_true", help="强制重传，忽略 R2 已存在对象")
    args = ap.parse_args()

    tile_sets = load_tile_sets()
    print(f"共 {len(tile_sets)} 套瓦片（{len({s['map_key'] for s in tile_sets})} 张地图）", flush=True)

    uploader = None
    if not args.stats:
        bucket = os.environ.get("R2_BUCKET", "tarkov-maps")
        uploader = R2Uploader(make_r2_client(), bucket, force=args.force)

    total_files = 0
    total_bytes = 0
    total_skipped = 0
    failures = []
    t_start = time.time()

    for ts in tile_sets:
        candidates = list(enumerate_tiles(ts))
        label = f"{ts['map_key']}/{ts['name']}"
        print(f"[{label}] z{ts['min_zoom']}-{ts['max_zoom']} 候选 {len(candidates)} 块…", flush=True)
        set_files = 0
        set_bytes = 0
        set_skip = 0

        def work(zxy):
            z, x, y = zxy
            url = tile_url(ts, z, x, y)
            if args.stats:
                code, _, headers = fetch(url, method="HEAD")
                if code == 200:
                    return 1, int(headers.get("Content-Length") or 0), 0, None
                if code == 404:
                    return 0, 0, 0, None
                return 0, 0, 0, f"{url}: HTTP {code}"
            key = r2_key(url)
            if uploader.exists(key):
                return 0, 0, 1, None
            code, content, _ = fetch(url)
            if code == 404:
                return 0, 0, 0, None
            if code != 200:
                return 0, 0, 0, f"{url}: HTTP {code}"
            uploader.upload(key, content)
            return 1, len(content), 0, None

        with concurrent.futures.ThreadPoolExecutor(CONCURRENCY) as pool:
            for n_files, n_bytes, n_skip, err in pool.map(work, candidates):
                set_files += n_files
                set_bytes += n_bytes
                set_skip += n_skip
                if err:
                    failures.append(err)
                    print(f"  [失败] {err}", flush=True)
        print(
            f"[{label}] 完成：{'存在' if args.stats else '上传'} {set_files} 块"
            f"（{set_bytes / 1024 / 1024:.1f} MB）"
            + (f"，跳过已存在 {set_skip} 块" if set_skip else ""),
            flush=True,
        )
        total_files += set_files
        total_bytes += set_bytes
        total_skipped += set_skip

    elapsed = time.time() - t_start
    print(
        f"\n全部完成（{elapsed:.0f}s）：{total_files} 块瓦片，共 {total_bytes / 1024 / 1024:.1f} MB"
        + (f"，跳过 {total_skipped} 块" if total_skipped else ""),
        flush=True,
    )
    if failures:
        print(f"失败 {len(failures)} 个（见上方日志），修复网络后重跑即可（增量）", flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
