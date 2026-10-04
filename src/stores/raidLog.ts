import { defineStore } from "pinia";
import { acquireDir, checkFsSupport } from "@/utils/fs-watch";
import type { FSObserver } from "@/utils/fs-watch";

/** 战局日志同步：FileSystemObserver 递归监听 EFT Logs 目录，
 * application_*.log 中 NetworkGameCreate 行的 Location 字段即进战局的地图，
 * 解析后供地图页自动切换到对应地图。
 * 日志结构：Logs/log_<日期>_<时间>_<版本>/<前缀> application_000.log（写满后轮转为 _001） */

/** EFT 内部地图名（小写）→ 本站地图 key（线上战局 Location 字段） */
const LOCATION_TO_MAP: Record<string, string> = {
  bigmap: "customs",
  factory4_day: "factory",
  factory4_night: "factory",
  woods: "woods",
  shoreline: "shoreline",
  interchange: "interchange",
  rezervbase: "reserve",
  lighthouse: "lighthouse",
  tarkovstreets: "streets-of-tarkov",
  sandbox: "ground-zero",
  sandbox_high: "ground-zero",
  laboratory: "the-lab",
  labyrinth: "the-labyrinth",
  terminal: "terminal",
  icebreaker: "icebreaker",
};

/** 场景 bundle 名（小写，去掉 _preset 后缀）→ 本站地图 key。
 * PVE/本地战局没有 Location 行，但所有模式进图都会写 scene preset 日志 */
const BUNDLE_TO_MAP: Record<string, string> = {
  customs: "customs",
  city: "streets-of-tarkov",
  shopping_mall: "interchange",
  rezerv_base: "reserve",
  woods: "woods",
  shoreline: "shoreline",
  factory_day: "factory",
  factory_night: "factory",
  sandbox: "ground-zero",
  sandbox_high: "ground-zero",
  sandbox_start: "ground-zero",
  lighthouse: "lighthouse",
  labyrinth: "the-labyrinth",
  laboratory: "the-lab",
  terminal: "terminal",
  icebreaker: "icebreaker",
};

const LOCATION_RE = /Location: ([A-Za-z0-9_]+)/g;
const SCENE_RE = /scene preset path:maps\/([a-z0-9_]+?)(?:_preset)?\.bundle/gi;
const APP_LOG_RE = /application_\d+\.log$/i;
const SESSION_DIR_RE = /^log_\d{4}\.\d{2}\.\d{2}_/;

// 非响应式内部状态
let observer: FSObserver | null = null;
/** 各日志文件已读取的字节偏移，key 为相对 Logs 根的路径 */
const offsets = new Map<string, number>();

export const useRaidLogStore = defineStore("raidLog", {
  state: () => ({
    /** 是否正在监听 */
    enabled: false,
    dirName: "",
    /** 最近一次解析到的 Location 原始名 */
    location: "",
    /** 对应的本站地图 key；未知地图为空字符串 */
    mapKey: "",
    /** 最近一次地图变化的时间戳 */
    lastAt: 0,
  }),
  actions: {
    /** 开启监听；返回 null 表示成功，否则为错误文本（需在用户手势中调用）。
     * forcePicker 跳过已持久化的目录，强制重新选择 */
    async enable(forcePicker = false): Promise<string | null> {
      const unsupported = checkFsSupport();
      if (unsupported) return unsupported;
      const handle = await acquireDir("eftLogsDir", "eft-logs", forcePicker);
      if (!handle) return "未选择 Logs 目录或授权失败";
      try {
        await this.startWatching(handle);
      } catch (e) {
        console.error("监听 Logs 目录失败:", e);
        return `监听 Logs 目录失败：${e instanceof Error ? e.message : String(e)}`;
      }
      return null;
    },
    disable() {
      observer?.disconnect();
      observer = null;
      this.enabled = false;
    },
    /** 从日志文本中提取最新的地图信息并更新状态。
     * 两种来源取文本中出现位置较后的一个：
     * - 线上战局：NetworkGameCreate 行的 Location 字段
     * - 所有模式（含 PVE/训练）：scene preset 场景加载行的 bundle 名 */
    applyLogText(text: string) {
      let location = "";
      let locationAt = -1;
      for (const m of text.matchAll(LOCATION_RE)) {
        location = m[1];
        locationAt = m.index;
      }
      let bundle = "";
      let bundleAt = -1;
      for (const m of text.matchAll(SCENE_RE)) {
        bundle = m[1];
        bundleAt = m.index;
      }
      if (locationAt < 0 && bundleAt < 0) return;
      let mapKey: string;
      let raw: string;
      if (locationAt > bundleAt) {
        mapKey = LOCATION_TO_MAP[location.toLowerCase()] ?? "";
        raw = `Location:${location}`;
        if (!mapKey) console.warn("未知地图 Location:", location);
      } else {
        mapKey = BUNDLE_TO_MAP[bundle.toLowerCase()] ?? "";
        raw = `bundle:${bundle}`;
        if (!mapKey) console.warn("未知地图 bundle:", bundle);
      }
      if (!mapKey || mapKey === this.mapKey) return;
      this.location = raw;
      this.mapKey = mapKey;
      this.lastAt = Date.now();
    },
    async startWatching(handle: FileSystemDirectoryHandle) {
      this.disable();
      offsets.clear();
      // 基线：读最新会话目录的 application 日志，恢复当前战局地图（中途打开页面也能对上）
      let newest: FileSystemDirectoryHandle | null = null;
      for await (const h of handle.values()) {
        if (h.kind === "directory" && SESSION_DIR_RE.test(h.name)) {
          if (!newest || h.name > newest.name) newest = h as FileSystemDirectoryHandle;
        }
      }
      if (newest) {
        for await (const h of newest.values()) {
          if (h.kind !== "file" || !APP_LOG_RE.test(h.name)) continue;
          const file = await (h as FileSystemFileHandle).getFile();
          this.applyLogText(await file.text());
          offsets.set(`${newest.name}/${h.name}`, file.size);
        }
      } else {
        console.warn("Logs 目录下没有找到会话日志目录");
      }
      // 递归监听：新会话目录、日志轮转新文件、追加写入都会触发
      observer = new window.FileSystemObserver!((records) => {
        for (const r of records) {
          if (r.changedHandle.kind !== "file") continue;
          if (r.type !== "modified" && r.type !== "appeared") continue;
          if (!APP_LOG_RE.test(r.changedHandle.name)) continue;
          const fh = r.changedHandle as FileSystemFileHandle;
          const path = r.relativePathComponents.join("/");
          // 异步读取追加部分；失败只记日志，等待下次事件
          fh.getFile()
            .then(async (file) => {
              let offset = offsets.get(path) ?? 0;
              if (file.size < offset) offset = 0; // 文件被截断/轮转
              if (file.size <= offset) return;
              const text = await file.slice(offset).text();
              offsets.set(path, file.size);
              this.applyLogText(text);
            })
            .catch((e) => console.error("读取日志增量失败:", path, e));
        }
      });
      await observer.observe(handle, { recursive: true });
      this.dirName = handle.name;
      this.enabled = true;
    },
  },
});
