"""镜像地图文件到本地静态目录。

- 所有地图的 SVG 底图 -> web/assets/maps/svg/
- 纯瓦片地图（无 SVG：实验室/破冰船/迷宫）的全部瓦片 -> web/assets/maps/<原路径>/
  （卫星图瓦片体积过大（估算约 1.2GB）超出 GitHub Pages 限制，有 SVG 的地图瓦片不镜像）
- 同步重写 maps.json 中对应路径为本地相对路径

瓦片坐标按 web/map.js 的 CRS 投影（移植自 tarkov-dev）复算。
下载用 curl --parallel 连接复用；远端 404 的瓦片不落盘（curl -f），
本地同源 404 行为与远端一致。已存在的文件跳过，可中断后重跑续传。

用法: python web/mirror_maps.py
"""

import io
import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path

WEB_DIR = Path(__file__).parent
ASSETS_PREFIX = "https://assets.tarkov.dev/maps/"
LOCAL_PREFIX = "assets/maps/"
# 无 SVG 底图、必须镜像瓦片才能显示的地图
TILE_ONLY_MAPS = ["the-lab", "icebreaker", "the-labyrinth"]

CURL_PARALLEL = 50
CURL_CHUNK = 400  # 单次 curl 进程处理的瓦片数；大批量（2000+）并行会严重变慢


def tile_range(md, z):
    """按 map.js getCRS 的变换复算某缩放等级下的瓦片编号范围"""
    a, b, c, d = (md.get("transform") or [1, 0, -1, 0])
    rot = math.radians(md.get("coordinateRotation") or 0)
    ts = md.get("tileSize") or 256
    (x1, z1), (x2, z2) = md["bounds"]
    xs, ys = [], []
    for gx, gz in [(x1, z1), (x1, z2), (x2, z1), (x2, z2)]:
        lat = gx * math.sin(rot) + gz * math.cos(rot)
        lng = gx * math.cos(rot) - gz * math.sin(rot)
        xs.append((2 ** z) * (a * lng + b) / ts)
        ys.append((2 ** z) * (-c * lat + d) / ts)
    return math.floor(min(xs)), math.floor(max(xs)), math.floor(min(ys)), math.floor(max(ys))


def curl_download(jobs, label):
    """jobs: [(url, dest)]；跳过已存在文件；404/失败的不落盘，返回缺漏数"""
    jobs = [(u, d) for u, d in jobs if not d.exists()]
    if not jobs:
        print(f"{label}: 全部已存在，跳过")
        return 0
    for u, d in jobs:
        d.parent.mkdir(parents=True, exist_ok=True)
    for start in range(0, len(jobs), CURL_CHUNK):
        chunk = jobs[start:start + CURL_CHUNK]
        with tempfile.NamedTemporaryFile(
                "w", encoding="utf-8", newline="\n", suffix=".cfg", delete=False) as f:
            for u, d in chunk:
                # curl 配置文件里反斜杠是转义符，Windows 路径必须转正斜杠；
                # 布尔选项写 "fail = true" 会解析失败，只能单独一行 "fail"
                f.write(f'url = "{u}"\nfail\nconnect-timeout = 15\nmax-time = 60\n'
                        f'output = "{d.as_posix()}"\n')
            cfg = f.name
        # fail=true: HTTP 错误不写文件；任何失败都会使 curl 退出码非零，
        # 但并行模式下其余传输仍会完成，是否成功以文件是否落盘为准
        subprocess.run(["curl", "-s", "--parallel", "--parallel-max", str(CURL_PARALLEL),
                        "-K", cfg])
        Path(cfg).unlink()
        print(f"{label}: {min(start + CURL_CHUNK, len(jobs))}/{len(jobs)}")
    missing = sum(1 for _, d in jobs if not d.exists())
    return missing


def mirror_svg(md):
    svg_path = md.get("svgPath")
    if not svg_path or not svg_path.startswith(ASSETS_PREFIX):
        return
    local = LOCAL_PREFIX + svg_path[len(ASSETS_PREFIX):]
    dest = WEB_DIR / local
    if curl_download([(svg_path, dest)], f"SVG {md['key']}"):
        raise SystemExit(f"SVG 下载失败: {svg_path}")
    md["svgPath"] = local


def mirror_tiles(md):
    paths = []
    if md.get("tilePath", "").startswith(ASSETS_PREFIX):
        paths.append(md["tilePath"])
    for layer in md.get("layers") or []:
        if layer.get("tilePath", "").startswith(ASSETS_PREFIX):
            paths.append(layer["tilePath"])

    jobs = []
    for p in paths:
        for z in range(md["minZoom"], md["maxZoom"] + 1):
            xa, xb, ya, yb = tile_range(md, z)
            for x in range(xa, xb + 1):
                for y in range(ya, yb + 1):
                    rel = p[len(ASSETS_PREFIX):] \
                        .replace("{z}", str(z)).replace("{x}", str(x)).replace("{y}", str(y))
                    jobs.append((ASSETS_PREFIX + rel, WEB_DIR / LOCAL_PREFIX / rel))

    # 两遍：第二遍重试网络错误，剩余缺漏即远端 404 的空白格（与远端行为一致）
    missing = curl_download(jobs, md["key"])
    if missing:
        print(f"{md['key']}: 重试 {missing} 个缺漏瓦片")
        missing = curl_download(jobs, md["key"])
    if missing:
        print(f"{md['key']}: {missing} 个瓦片远端不存在(404)，跳过")

    for p in paths:
        local = LOCAL_PREFIX + p[len(ASSETS_PREFIX):]
        if md.get("tilePath") == p:
            md["tilePath"] = local
        for layer in md.get("layers") or []:
            if layer.get("tilePath") == p:
                layer["tilePath"] = local


def main():
    maps_file = WEB_DIR / "maps.json"
    maps = json.loads(maps_file.read_text(encoding="utf-8"))
    for md in maps:
        mirror_svg(md)
        if md["key"] in TILE_ONLY_MAPS:
            mirror_tiles(md)
        else:
            print(f"{md['key']}: 仅 SVG")
    maps_file.write_text(json.dumps(maps, ensure_ascii=False, indent=2), encoding="utf-8")
    print("maps.json 已重写为本地路径")


if __name__ == "__main__":
    sys.exit(main())
