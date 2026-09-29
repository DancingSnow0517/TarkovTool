"""同步地图页静态任务数据。

从 json.tarkov.dev 下载全部游戏模式的任务数据及所有语言翻译到 web/data/，
并刷新 map.js 中的 DATA_VERSION（用于让浏览器 localStorage 缓存失效）。

用法: python web/update_data.py
"""

import json
import re
import urllib.request
from datetime import date
from pathlib import Path

BASE = "https://json.tarkov.dev"
# 与 main.py 的 GAME_MODES / LANGUAGES 保持一致
MODES = ["regular", "pvp-season", "pve"]
LANGS = [
    "cs", "de", "en", "es", "fr", "hu", "id", "it", "ja", "ko",
    "pl", "pt", "ro", "ru", "sk", "th", "tr", "vn", "zh",
]

DATA_DIR = Path(__file__).parent / "data"
MAP_JS = Path(__file__).parent / "map.js"


def download(path, dest):
    print(f"下载 {path} -> {dest}")
    req = urllib.request.Request(f"{BASE}/{path}",
                                 headers={"User-Agent": "TarkovTool/1.0"})
    with urllib.request.urlopen(req) as r:
        body = r.read()
    parsed = json.loads(body)  # 校验是合法 JSON，损坏时直接报错
    if "data" not in parsed:
        raise SystemExit(f"{path} 响应缺少 data 字段")
    dest.write_bytes(body)


def main():
    for mode in MODES:
        d = DATA_DIR / mode
        d.mkdir(parents=True, exist_ok=True)
        download(f"{mode}/tasks", d / "tasks.json")
        for lang in LANGS:
            download(f"{mode}/tasks_{lang}", d / f"tasks_{lang}.json")

    version = date.today().strftime("%Y%m%d")
    src = MAP_JS.read_text(encoding="utf-8")
    src, n = re.subn(r'const DATA_VERSION = "\d{8}";',
                     f'const DATA_VERSION = "{version}";', src)
    if n != 1:
        raise SystemExit("map.js 中未找到唯一的 DATA_VERSION 定义")
    MAP_JS.write_text(src, encoding="utf-8")
    print(f"完成,数据版本 {version}")


if __name__ == "__main__":
    main()
