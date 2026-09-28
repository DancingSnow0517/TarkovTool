"""塔科夫套利 CLI：从跳蚤市场买入、卖给商人赚差价，按利润排序。"""

import argparse
import contextlib
import json
import msvcrt
import os
import shutil
import sys
import threading
import time
import urllib.request
from io import StringIO

import questionary
from pypinyin import Style, lazy_pinyin
from rich.console import Console
from rich.table import Table
from rich.text import Text

BASE_URL = "https://json.tarkov.dev"

GAME_MODES = {
    "PVP (regular)": "regular",
    "PVPS (赛季服 pvp-season)": "pvp-season",
    "PVE (pve)": "pve",
}

LANGUAGES = [
    "cs", "de", "en", "es", "fr", "hu", "id", "it", "ja", "ko",
    "pl", "pt", "ro", "ru", "sk", "th", "tr", "vn", "zh",
]

if sys.platform == "win32":
    CONFIG_PATH = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")),
                               "TarkovTool", "config.json")
else:
    CONFIG_PATH = os.path.join(os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config")),
                               "tarkov-tool", "config.json")

CACHE_DIR = os.path.join(os.path.dirname(CONFIG_PATH), "cache")
CACHE_TTL = 7 * 24 * 3600  # 静态数据（翻译、商人）缓存 7 天

console = Console()


def load_config() -> dict:
    if not os.path.exists(CONFIG_PATH):
        return {}
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


def save_config(config: dict):
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)


def update_config(**kv):
    config = load_config()
    config.update(kv)
    save_config(config)


def fetch_raw(path: str) -> str:
    url = f"{BASE_URL}{path}"
    req = urllib.request.Request(url, headers={"User-Agent": "tarkov-flea-cli/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.read().decode("utf-8")
    except Exception as e:
        raise SystemExit(f"请求失败 {url}: {e}")


def parse_json(raw: str, path: str, strict: bool = True):
    try:
        return json.loads(raw, strict=strict)
    except json.JSONDecodeError as e:
        raise SystemExit(f"JSON 解析失败 {BASE_URL}{path}: {e}")


def fetch_json(path: str, strict: bool = True):
    return parse_json(fetch_raw(path), path, strict)


def fetch_cached(path: str, strict: bool = True):
    """带 7 天 TTL 的缓存拉取，仅用于翻译、商人等静态数据。"""
    cache_file = os.path.join(CACHE_DIR, path.strip("/").replace("/", "_") + ".json")
    if os.path.exists(cache_file) and time.time() - os.path.getmtime(cache_file) < CACHE_TTL:
        with open(cache_file, encoding="utf-8") as f:
            raw = f.read()
    else:
        raw = fetch_raw(path)
        os.makedirs(CACHE_DIR, exist_ok=True)
        with open(cache_file, "w", encoding="utf-8") as f:
            f.write(raw)
    return parse_json(raw, path, strict)


def translate(placeholder: str, translations: dict) -> str:
    return translations.get(placeholder, placeholder)


def clear_screen():
    os.system("cls" if sys.platform == "win32" else "clear")


def pick_mode() -> str:
    clear_screen()
    label = questionary.select(
        "选择游戏模式:", choices=list(GAME_MODES.keys())
    ).ask()
    if label is None:
        raise SystemExit("已取消")
    return GAME_MODES[label]


def pick_language() -> str:
    clear_screen()
    lang = questionary.select(
        "选择语言:", choices=LANGUAGES, default="zh"
    ).ask()
    if lang is None:
        raise SystemExit("已取消")
    return lang


def load_data(mode: str, lang: str, quiet: bool = False):
    # 全屏表格刷新时 quiet=True：rich 的加载动画会直接写 stdout，与全屏视图冲突
    def step(msg: str):
        return contextlib.nullcontext() if quiet else console.status(msg)

    with step(f"正在下载物品数据 ({mode}) ..."):
        items = fetch_json(f"/{mode}/items")["data"]["items"]
    with step(f"正在加载翻译 ({lang}) ..."):
        item_tr = fetch_cached(f"/{mode}/items_{lang}", strict=False)["data"]
        trader_tr = fetch_cached(f"/{mode}/traders_{lang}", strict=False)["data"]
        # 英文译名始终加载，保证任何界面语言下都能用英文搜索
        en_tr = item_tr if lang == "en" else fetch_cached(f"/{mode}/items_en", strict=False)["data"]
    with step("正在加载商人数据 ..."):
        traders = fetch_cached(f"/{mode}/traders")["data"]
    return items, item_tr, trader_tr, traders, en_tr


def find_deals(items: dict, item_tr: dict, trader_tr: dict, traders: dict,
               price_field: str, min_diff: int) -> list:
    deals = []
    for item in items.values():
        flea_price = item.get(price_field)
        offers = item.get("sellToTrader") or []
        if not flea_price or not offers:
            continue
        best = max(offers, key=lambda o: o["priceRUB"])
        profit = best["priceRUB"] - flea_price
        if profit < min_diff:
            continue
        trader = traders.get(best["trader"], {})
        deals.append({
            "name": translate(item["name"], item_tr),
            "link": item.get("link", ""),
            "flea": flea_price,
            "trader_price": best["priceRUB"],
            "trader": translate(trader.get("name", best["trader"]), trader_tr),
            "flea_level": item.get("minLevelForFlea") or 0,
            "profit": profit,
            "profit_pct": profit / flea_price * 100,
        })
    deals.sort(key=lambda d: d["profit"], reverse=True)
    return deals


def build_table(deals: list, start: int, mode: str, price_label: str) -> Table:
    table = Table(title=f"跳蚤买入 → 商人卖出 套利表 ({mode.upper()}, 跳蚤价口径: {price_label})",
                  expand=True)
    table.add_column("#", justify="right", no_wrap=True)
    table.add_column("物品", no_wrap=True, overflow="ellipsis", ratio=1, min_width=12)
    table.add_column("跳蚤价 ₽", justify="right", no_wrap=True)
    table.add_column("商人回收价 ₽", justify="right", no_wrap=True)
    table.add_column("商人", no_wrap=True, overflow="ellipsis")
    table.add_column("跳蚤等级", justify="center", no_wrap=True)
    table.add_column("利润 ₽", justify="right", style="green", no_wrap=True)
    table.add_column("利润率", justify="right", style="green", no_wrap=True)
    for i, d in enumerate(deals, start + 1):
        table.add_row(
            str(i), Text.assemble((d["name"], f"link {d['link']}")), f"{d['flea']:,}", f"{d['trader_price']:,}",
            d["trader"],
            f"Lv.{d['flea_level']}" if d["flea_level"] else "-",
            f"{d['profit']:,}", f"{d['profit_pct']:.1f}%",
        )
    return table


EXTENDED_KEYS = {
    "\x00H": "up", "\xe0H": "up",
    "\x00P": "down", "\xe0P": "down",
    "\x00K": "left", "\xe0K": "left",
    "\x00M": "right", "\xe0M": "right",
    "\x00=": "f3",
    "\x00?": "f5",
}


def read_key():
    """从控制台读取一个按键，返回键名（up/enter/f5...）或单个可打印字符。"""
    ch = msvcrt.getwch()
    if ch in ("\x00", "\xe0"):
        return EXTENDED_KEYS.get(ch + msvcrt.getwch())
    if ch == "\r":
        return "enter"
    if ch == "\x1b":
        return "escape"
    if ch == "\x08":
        return "backspace"
    return ch if ch.isprintable() else None


class TablePager:
    """全屏表格视图：←/→ 翻页，F5 刷新数据，Esc 返回。直接写 stdout（保留 OSC8 超链接），msvcrt 读键。"""

    SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
    FOOTER_LINES = 1

    def __init__(self, rows: list, table_builder, refresh):
        self.rows = rows
        self.table_builder = table_builder  # (当前页行, 起始序号) -> rich.Table
        self.refresh_data = refresh
        self.page = 0
        self.message = ""
        self.refreshing = False
        self._dirty = False
        self._size = shutil.get_terminal_size()

    def per_page(self, height: int) -> int:
        # 表格固定开销：标题 + 上下边框 + 表头两行 + 底栏
        return max(5, height - 7 - self.FOOTER_LINES)

    def page_count(self, height: int) -> int:
        return max(1, -(-len(self.rows) // self.per_page(height)))

    def turn(self, delta: int):
        count = self.page_count(self._size.lines)
        self.page = min(max(self.page + delta, 0), count - 1)

    def refresh(self):
        if self.refreshing:
            return
        self.refreshing = True

        def work():
            try:
                self.rows = self.refresh_data()
            except Exception as e:
                self.message = f"刷新失败: {e}"
            else:
                self.page = 0
                self.message = f"已刷新 {time.strftime('%H:%M:%S')}"
            finally:
                self.refreshing = False
                self._dirty = True

        threading.Thread(target=work, daemon=True).start()

    def handle_key(self, key: str):
        """返回 True 表示状态变化需重绘，"exit" 表示退出视图。"""
        if key == "escape":
            return "exit"
        if key == "left":
            self.turn(-1)
        elif key == "right":
            self.turn(1)
        elif key == "f5":
            self.refresh()
        else:
            return False
        return True

    def render(self, width: int, height: int) -> str:
        per_page = self.per_page(height)
        count = self.page_count(height)
        self.page = min(self.page, count - 1)
        page_rows = self.rows[self.page * per_page:(self.page + 1) * per_page]
        buf = StringIO()
        if page_rows:
            out = Console(file=buf, width=width, force_terminal=True,
                          color_system="truecolor", no_color=False, legacy_windows=False)
            out.print(self.table_builder(page_rows, self.page * per_page))
        else:
            buf.write("没有找到符合条件的物品\n")
        buf.write(self.footer(count))
        return buf.getvalue()

    def footer(self, count: int) -> str:
        if self.refreshing:
            frame = self.SPINNER[int(time.time() * 10) % len(self.SPINNER)]
            status = f"{frame} 正在刷新数据 ..."
        else:
            status = self.message
        return (f"← → 翻页 | F5 刷新 | Esc 返回    "
                f"第 {self.page + 1}/{count} 页  共 {len(self.rows)} 条  {status}")

    def draw(self):
        self._size = os.get_terminal_size()
        body = self.render(self._size.columns, self._size.lines)
        # 逐行清到行尾（\x1b[K），否则新内容较短的行会残留上一帧的行尾字符
        body = body.replace("\n", "\x1b[K\n")
        sys.stdout.write("\x1b[H" + body + "\x1b[J")
        sys.stdout.flush()

    def run(self):
        sys.stdout.write("\x1b[?1049h\x1b[?25l")  # 备用屏幕 + 隐藏光标
        dirty = True
        try:
            while True:
                if os.get_terminal_size() != self._size:
                    dirty = True
                if self._dirty:
                    dirty, self._dirty = True, False
                if dirty or self.refreshing:
                    self.draw()
                    dirty = False
                if msvcrt.kbhit():
                    key = read_key()
                    if key is None:
                        continue
                    result = self.handle_key(key)
                    if result == "exit":
                        break
                    dirty = dirty or bool(result)
                else:
                    time.sleep(0.05 if self.refreshing else 0.1)
        finally:
            sys.stdout.write("\x1b[?25h\x1b[?1049l")  # 恢复光标 + 主屏幕


def tool_flea_to_trader(ctx: dict, args):
    def compute():
        items, item_tr, trader_tr, traders, _ = ctx["data"]
        price_field = "lastLowPrice" if args.price == "last" else "avg24hPrice"
        return find_deals(items, item_tr, trader_tr, traders, price_field, args.min_diff)

    def refresh():
        ctx["data"] = load_data(ctx["mode"], ctx["lang"], quiet=True)
        return compute()

    price_label = "lastLowPrice" if args.price == "last" else "avg24hPrice"
    builder = lambda rows, start: build_table(rows, start, ctx["mode"], price_label)
    TablePager(compute()[:args.limit], builder, refresh).run()


def _price(v):
    return Text(f"{v:,}", style="green") if v else "-"


LIST_COLUMNS = {
    "flea": ("跳蚤价 ₽", "right", lambda r: _price(r["flea"])),
    "avg24h": ("24h均价 ₽", "right", lambda r: _price(r["avg24h"])),
    "low24h": ("24h最低 ₽", "right", lambda r: _price(r["low24h"])),
    "high24h": ("24h最高 ₽", "right", lambda r: _price(r["high24h"])),
    "change48h": ("48h涨跌", "right",
                  lambda r: Text(f"{r['change48h']:+.1f}%",
                                 style="green" if r["change48h"] >= 0 else "red")
                  if r["change48h"] is not None else "-"),
    "offers": ("挂单数", "right", lambda r: str(r["offers"]) if r["offers"] is not None else "-"),
    "trader": ("商人回收", "left",
               lambda r: Text.assemble((f"{r['trader_price']:,}", "green"), f" ({r['trader']})")
               if r["trader_price"] else "-"),
    "flea_level": ("跳蚤等级", "center", lambda r: f"Lv.{r['flea_level']}" if r["flea_level"] else "-"),
    "base": ("基准价 ₽", "right", lambda r: _price(r["base"])),
}

DEFAULT_LIST_COLUMNS = ["flea", "avg24h", "trader", "flea_level"]


def get_list_columns() -> list:
    cols = [c for c in load_config().get("columns", []) if c in LIST_COLUMNS]
    return cols or DEFAULT_LIST_COLUMNS


def make_item_row(item: dict, item_tr: dict, trader_tr: dict, traders: dict, en_tr: dict) -> dict:
    offers = item.get("sellToTrader") or []
    best = max(offers, key=lambda o: o["priceRUB"]) if offers else None
    trader = traders.get(best["trader"], {}) if best else {}
    name = translate(item["name"], item_tr)
    en_name = translate(item["name"], en_tr)
    py = pya = ""
    if any("\u4e00" <= c <= "\u9fff" for c in name):
        py = "".join(lazy_pinyin(name, style=Style.NORMAL)).replace(" ", "").lower()
        pya = "".join(lazy_pinyin(name, style=Style.FIRST_LETTER)).replace(" ", "").lower()
    return {
        "id": item["id"],
        "name": name,
        "norm": item.get("normalizedName", ""),
        "en": en_name.lower(),
        "py": py,
        "pya": pya,
        "link": item.get("link", ""),
        "flea": item.get("lastLowPrice"),
        "avg24h": item.get("avg24hPrice"),
        "low24h": item.get("low24hPrice"),
        "high24h": item.get("high24hPrice"),
        "change48h": item.get("changeLast48hPercent"),
        "offers": item.get("lastOfferCount"),
        "trader_price": best["priceRUB"] if best else None,
        "trader": translate(trader.get("name", ""), trader_tr) if best else "",
        "flea_level": item.get("minLevelForFlea") or 0,
        "base": item.get("basePrice"),
    }


class SearchPager(TablePager):
    """可打字搜索的表格列表：↑↓ 选择，←/→ 翻页，退格删字，支持中文/英文/拼音/首字母搜索。"""

    FOOTER_LINES = 2

    def __init__(self, rows: list, title: str, refresh):
        self.all_rows = rows
        self.title_base = title
        self.query = ""
        self.selected = 0
        super().__init__(rows, self.build_table, refresh)

    def match(self, row: dict, q: str) -> bool:
        return (q in row["name"].lower() or q in row["en"] or q in row["norm"]
                or q in row["py"] or q in row["pya"])

    def handle_key(self, key: str):
        if key == "up":
            self.move(-1)
        elif key == "down":
            self.move(1)
        elif key == "backspace":
            self.backspace()
        elif len(key) == 1 and key.isprintable():
            self.type_char(key)
        else:
            return super().handle_key(key)
        return True

    def type_char(self, data):
        if data and data.isprintable():
            self.query += data
            self.apply_filter()

    def backspace(self):
        if self.query:
            self.query = self.query[:-1]
            self.apply_filter()

    def apply_filter(self):
        rows = self.all_rows
        q = self.query.lower()
        if q:
            rows = [r for r in rows if self.match(r, q)]
        self.rows = rows
        self.selected = 0
        self.page = 0

    def move(self, delta: int):
        if not self.rows:
            return
        self.selected = min(max(self.selected + delta, 0), len(self.rows) - 1)
        self.page = self.selected // self.per_page(self._size.lines)

    def turn(self, delta: int):
        super().turn(delta)
        if self.rows:
            self.selected = min(self.page * self.per_page(self._size.lines), len(self.rows) - 1)


class ItemListPager(SearchPager):
    """物品列表：回车收藏（收藏排最前），F3 列设置。"""

    def __init__(self, rows: list, columns: list, title: str, refresh, favs: set):
        self.columns = columns
        self.favs = favs
        self.open_settings = False
        super().__init__(rows, title, refresh)
        self.sort_rows()  # all_rows 与 self.rows 是同一列表，原地排序即可

    def handle_key(self, key: str):
        if key == "enter":
            self.toggle_fav()
            return True
        if key == "f3":
            self.open_settings = True
            return "exit"
        return super().handle_key(key)

    def sort_rows(self):
        # 收藏排最前，其余按跳蚤价降序（无价格的垫底）
        self.all_rows.sort(key=lambda r: (r["id"] not in self.favs,
                                          r["flea"] is None, -(r["flea"] or 0)))

    def toggle_fav(self):
        if not self.rows:
            return
        item_id = self.rows[self.selected]["id"]
        if item_id in self.favs:
            self.favs.remove(item_id)
        else:
            self.favs.add(item_id)
        update_config(favorites=list(self.favs))
        self.sort_rows()
        self.apply_filter()
        # 收藏状态变化导致重新排序后，保持选中同一物品
        for idx, r in enumerate(self.rows):
            if r["id"] == item_id:
                self.selected = idx
                self.page = idx // self.per_page(self._size.lines)
                break

    def build_table(self, page_rows: list, start: int) -> Table:
        table = Table(title=self.title_base, expand=True)
        table.add_column("★", no_wrap=True)
        table.add_column("#", justify="right", no_wrap=True)
        table.add_column("物品", no_wrap=True, overflow="ellipsis", ratio=1, min_width=12)
        for key in self.columns:
            header, justify, _ = LIST_COLUMNS[key]
            table.add_column(header, justify=justify, no_wrap=True, overflow="ellipsis")
        for i, r in enumerate(page_rows, start):
            style = "reverse" if i == self.selected else None
            table.add_row(
                "★" if r["id"] in self.favs else "", str(i + 1),
                Text.assemble((r["name"], f"link {r['link']}")),
                *[LIST_COLUMNS[k][2](r) for k in self.columns],
                style=style,
            )
        return table

    def footer(self, count: int) -> str:
        if self.refreshing:
            frame = self.SPINNER[int(time.time() * 10) % len(self.SPINNER)]
            status = f"{frame} 正在刷新数据 ..."
        else:
            status = self.message
        return (f"↑↓ 选择 | 回车 收藏 | F5 刷新 | F3 列设置 | ← → 翻页 | Esc 返回\n"
                f"搜索: {self.query}▌    第 {self.page + 1}/{count} 页  "
                f"共 {len(self.rows)} 条  {status}")


def tool_item_list(ctx: dict, args):
    def compute_rows():
        items, item_tr, trader_tr, traders, en_tr = ctx["data"]
        return [make_item_row(it, item_tr, trader_tr, traders, en_tr) for it in items.values()]

    def refresh():
        ctx["data"] = load_data(ctx["mode"], ctx["lang"], quiet=True)
        pager.all_rows = compute_rows()
        pager.sort_rows()
        pager.apply_filter()
        return pager.rows

    while True:
        favs = set(load_config().get("favorites", []))
        pager = ItemListPager(compute_rows(), get_list_columns(),
                              f"物品列表 ({ctx['mode'].upper()})", refresh, favs)
        pager.run()
        if not pager.open_settings:
            break
        tool_list_columns(ctx, args)


def tool_list_columns(ctx: dict, args):
    current = get_list_columns()
    selected = questionary.checkbox(
        "选择物品列表显示的列 (空格勾选, 回车确认):",
        choices=[questionary.Choice(label, value=key, checked=key in current)
                 for key, (label, _, _) in LIST_COLUMNS.items()],
        validate=lambda xs: len(xs) >= 1 or "至少保留一列",
    ).ask()
    if selected is None:
        return
    update_config(columns=selected)


def load_tasks(mode: str, lang: str, quiet: bool = False) -> dict:
    """任务/地图数据无实时性，与翻译一样走 7 天缓存。"""
    def step(msg: str):
        return contextlib.nullcontext() if quiet else console.status(msg)

    with step(f"正在加载任务数据 ({mode}) ..."):
        data = fetch_cached(f"/{mode}/tasks", strict=False)["data"]
    with step(f"正在加载任务翻译 ({lang}) ..."):
        task_tr = fetch_cached(f"/{mode}/tasks_{lang}", strict=False)["data"]
        # 英文始终加载，保证任何界面语言下都能用英文搜索
        task_en = task_tr if lang == "en" else fetch_cached(f"/{mode}/tasks_en", strict=False)["data"]
    with step("正在加载地图数据 ..."):
        maps = fetch_cached(f"/{mode}/maps", strict=False)["data"]["maps"]
        map_tr = fetch_cached(f"/{mode}/maps_{lang}", strict=False)["data"]
    return {
        "tasks": data["tasks"],
        "tr": task_tr,
        "en": task_en,
        "map_keys": {mid: m.get("normalizedName", "") for mid, m in maps.items()},
        "map_tr": map_tr,
        "mode": mode,
        "lang": lang,
    }


MAP_PAGE_URL = "https://map.dancingsnow.xyz"


def map_link(map_key: str, qid: str, mode: str, lang: str, task_id: str = "") -> str:
    """目标定位链接：默认指向自建静态地图页，可用 --map-url 覆盖。task_id 让地图页只显示该任务的目标。"""
    base = (load_config().get("map_url") or "").strip() or MAP_PAGE_URL
    sep = "&" if "?" in base else "?"
    url = f"{base}{sep}map={map_key}&q={qid}&mode={mode}&lang={lang}"
    if task_id:
        url += f"&task={task_id}"
    return url


def make_task_row(task: dict, td: dict, trader_tr: dict, traders: dict) -> dict:
    name = translate(task["name"], td["tr"])
    en_name = translate(task["name"], td["en"])
    py = pya = ""
    if any("一" <= c <= "鿿" for c in name):
        py = "".join(lazy_pinyin(name, style=Style.NORMAL)).replace(" ", "").lower()
        pya = "".join(lazy_pinyin(name, style=Style.FIRST_LETTER)).replace(" ", "").lower()
    trader = traders.get(task.get("trader") or "", {})
    map_id = task.get("map")
    return {
        "id": task["id"],
        "task": task,
        "name": name,
        "norm": task.get("normalizedName", ""),
        "en": en_name.lower(),
        "py": py,
        "pya": pya,
        "trader": translate(trader.get("name", ""), trader_tr),
        "map": translate(f"{map_id} Name", td["map_tr"]) if map_id else "",
        "level": task.get("minPlayerLevel") or 0,
        "kappa": task.get("kappaRequired", False),
        "wiki": task.get("wikiLink", ""),
    }


class TaskListPager(SearchPager):
    """任务列表：回车查看详情（标题/目标/地图链接），详情内 ↑↓ 滚动，回车/Esc 返回列表。"""

    def __init__(self, rows: list, title: str, refresh, td: dict):
        self.td = td
        self.detail = None
        self.detail_scroll = 0
        super().__init__(rows, title, refresh)

    def handle_key(self, key: str):
        if self.detail is not None:
            if key in ("escape", "enter"):
                self.detail = None
                return True
            if key == "up":
                self.detail_scroll = max(0, self.detail_scroll - 1)
                return True
            if key == "down":
                self.detail_scroll += 1
                return True
            return False
        if key == "enter":
            if self.rows:
                self.detail = self.rows[self.selected]
                self.detail_scroll = 0
            return True
        return super().handle_key(key)

    def build_table(self, page_rows: list, start: int) -> Table:
        table = Table(title=self.title_base, expand=True)
        table.add_column("#", justify="right", no_wrap=True)
        table.add_column("任务", no_wrap=True, overflow="ellipsis", ratio=1, min_width=12)
        table.add_column("商人", no_wrap=True, overflow="ellipsis")
        table.add_column("地图", no_wrap=True, overflow="ellipsis")
        table.add_column("等级", justify="center", no_wrap=True)
        table.add_column("Kappa", justify="center", no_wrap=True)
        for i, r in enumerate(page_rows, start):
            table.add_row(
                str(i + 1),
                Text.assemble((r["name"], f"link https://tarkov.dev/task/{r['norm']}")),
                r["trader"], r["map"],
                f"Lv.{r['level']}" if r["level"] else "-",
                "✔" if r["kappa"] else "",
                style="reverse" if i == self.selected else None,
            )
        return table

    def task_map_links(self, task: dict) -> list:
        """汇总任务所有目标的坐标点，按地图分组：每张地图一条链接，q 携带该图全部点位。"""
        map_keys, map_tr = self.td["map_keys"], self.td["map_tr"]
        mode, lang = self.td["mode"], self.td["lang"]
        by_map = {}
        for ob in task.get("objectives", []):
            for z in ob.get("zones") or []:
                key = map_keys.get(z.get("map"))
                if key:
                    qids = by_map.setdefault(z["map"], (key, []))[1]
                    if z["id"] not in qids:
                        qids.append(z["id"])
            quest_item = ob.get("questItem")
            if quest_item:
                for loc in ob.get("possibleLocations") or []:
                    key = map_keys.get(loc.get("map"))
                    if key:
                        qids = by_map.setdefault(loc["map"], (key, []))[1]
                        if quest_item not in qids:
                            qids.append(quest_item)
        return [(translate(f"{mid} Name", map_tr), map_link(key, ",".join(qids), mode, lang, task["id"]))
                for mid, (key, qids) in by_map.items()]

    def build_detail(self, row: dict, width: int) -> str:
        task = row["task"]
        buf = StringIO()
        out = Console(file=buf, width=width, force_terminal=True,
                      color_system="truecolor", no_color=False, legacy_windows=False)
        out.print(Text.assemble((row["name"], f"bold link https://tarkov.dev/task/{row['norm']}")))
        info = []
        if row["trader"]:
            info.append(f"商人: {row['trader']}")
        if row["map"]:
            info.append(f"地图: {row['map']}")
        if row["level"]:
            info.append(f"等级: Lv.{row['level']}")
        if row["kappa"]:
            info.append("需要 3x4 (Kappa)")
        out.print("  ".join(info))
        if row["wiki"]:
            out.print(Text.assemble("Wiki: ", (row["wiki"], f"link {row['wiki']}")))
        out.print("")
        out.print("任务目标:", style="bold")
        for ob in task.get("objectives", []):
            text = translate(ob.get("description", ""), self.td["tr"])
            if ob.get("optional"):
                text += " (可选)"
            out.print(f"• {text}")
        links = self.task_map_links(task)
        if links:
            out.print("")
            line = Text("地图: ", style="bold")
            for i, (map_name, url) in enumerate(links):
                if i:
                    line.append(" | ")
                line.append(map_name, style=f"link {url}")
            out.print(line)
        return buf.getvalue()

    def render(self, width: int, height: int) -> str:
        if self.detail is None:
            return super().render(width, height)
        lines = self.build_detail(self.detail, width).splitlines()
        usable = max(1, height - self.FOOTER_LINES)
        self.detail_scroll = min(self.detail_scroll, max(0, len(lines) - usable))
        view = lines[self.detail_scroll:self.detail_scroll + usable]
        return "\n".join(view) + "\n" + self.footer(0)

    def footer(self, count: int) -> str:
        if self.detail is not None:
            return "↑↓ 滚动 | 回车/Esc 返回列表    (链接可 Ctrl+点击 在浏览器打开)"
        if self.refreshing:
            frame = self.SPINNER[int(time.time() * 10) % len(self.SPINNER)]
            status = f"{frame} 正在刷新数据 ..."
        else:
            status = self.message
        return (f"↑↓ 选择 | 回车 任务详情 | F5 刷新 | ← → 翻页 | Esc 返回\n"
                f"搜索: {self.query}▌    第 {self.page + 1}/{count} 页  "
                f"共 {len(self.rows)} 条  {status}")


def tool_task_list(ctx: dict, args):
    _, _, trader_tr, traders, _ = ctx["data"]
    td = load_tasks(ctx["mode"], ctx["lang"])

    def compute_rows():
        rows = [make_task_row(t, td, trader_tr, traders) for t in td["tasks"].values()]
        rows.sort(key=lambda r: (r["level"], r["name"]))
        return rows

    def refresh():
        nonlocal td
        td = load_tasks(ctx["mode"], ctx["lang"], quiet=True)
        pager.td = td
        pager.all_rows = compute_rows()
        pager.apply_filter()
        return pager.rows

    pager = TaskListPager(compute_rows(), f"任务列表 ({ctx['mode'].upper()})", refresh, td)
    pager.run()


TOOLS = {
    "跳蚤买入 → 商人卖出 套利表": tool_flea_to_trader,
    "物品列表 (搜索/收藏)": tool_item_list,
    "任务列表 (搜索/详情/地图链接)": tool_task_list,
    "物品列表设置 (编辑显示列)": tool_list_columns,
}


def main():
    parser = argparse.ArgumentParser(description="塔科夫跳蚤市场套利工具")
    parser.add_argument("--mode", choices=["pvp", "pvps", "pve"], help="游戏模式（覆盖已保存配置）")
    parser.add_argument("--lang", choices=LANGUAGES, help="显示语言（覆盖已保存配置）")
    parser.add_argument("--reset", action="store_true", help="清除已保存的模式/语言配置并重新选择")
    parser.add_argument("--limit", type=int, default=50, help="显示条数 (默认 50)")
    parser.add_argument("--min-diff", type=int, default=1, help="最小利润 ₽ (默认 1)")
    parser.add_argument("--price", choices=["last", "avg"], default="last",
                        help="跳蚤价口径: last=最新最低挂单价, avg=24h均价 (默认 last)")
    parser.add_argument("--map-url", help="自建任务地图页地址（持久化到配置），如 https://<user>.github.io/<repo>/index.html")
    args = parser.parse_args()

    if args.map_url is not None:
        update_config(map_url=args.map_url.strip())

    if args.reset and os.path.exists(CONFIG_PATH):
        os.remove(CONFIG_PATH)
    config = load_config()

    if args.mode:
        mode = {"pvp": "regular", "pvps": "pvp-season", "pve": "pve"}[args.mode]
    elif config.get("mode") in GAME_MODES.values():
        mode = config["mode"]
    else:
        mode = pick_mode()

    if args.lang:
        lang = args.lang
    elif config.get("lang") in LANGUAGES:
        lang = config["lang"]
    else:
        lang = pick_language()

    update_config(mode=mode, lang=lang)

    mode_labels = {v: k for k, v in GAME_MODES.items()}
    ctx = {"mode": mode, "lang": lang, "data": load_data(mode, lang)}
    while True:
        clear_screen()
        choice = questionary.select(
            f"选择工具: (当前模式: {mode_labels[ctx['mode']]} | 语言: {ctx['lang']})",
            choices=[*TOOLS.keys(), "设置 (重新配置模式/语言)", "退出"]
        ).ask()
        if choice is None or choice == "退出":
            break
        if choice == "设置 (重新配置模式/语言)":
            ctx["mode"] = pick_mode()
            ctx["lang"] = pick_language()
            update_config(mode=ctx["mode"], lang=ctx["lang"])
            ctx["data"] = load_data(ctx["mode"], ctx["lang"])
            continue
        TOOLS[choice](ctx, args)


def enable_virtual_terminal():
    """启用控制台 ANSI/OSC 转义处理（老 conhost 默认关闭，Windows Terminal 已开启）。"""
    import ctypes
    handle = ctypes.windll.kernel32.GetStdHandle(-11)  # STD_OUTPUT_HANDLE
    mode = ctypes.c_ulong()
    if not ctypes.windll.kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
        raise SystemExit("无法获取控制台模式：请在终端中运行本工具")
    ctypes.windll.kernel32.SetConsoleMode(handle, mode.value | 0x4)  # ENABLE_VIRTUAL_TERMINAL_PROCESSING


if __name__ == "__main__":
    if sys.platform == "win32":
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
        if sys.stdout.isatty():
            enable_virtual_terminal()
    main()
