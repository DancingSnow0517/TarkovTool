import { defineStore } from "pinia";
import { acquireDir, checkFsSupport } from "@/utils/fs-watch";
import type { FSObserver } from "@/utils/fs-watch";

/** 截图位置追踪：FileSystemObserver 监听游戏截图目录，
 * 新截图文件名携带玩家位置与视角四元数，解析后在地图页标记。
 * 文件名示例：2025-10-18[11-39]_-437.00, 14.50, -26.20_0.00492, 0.78199, -0.00618, 0.62324_16.67 (0).png
 * 即 日期[时-分]_x, y, z_四元数 x, y, z, w_FOV (序号).png */

export interface TrackPoint {
  /** 文件名，作为唯一 id */
  id: string;
  /** 截图时间文本 yyyy-MM-dd HH:mm */
  time: string;
  /** 游戏坐标，y 为高度 */
  x: number;
  y: number;
  z: number;
  /** 视角朝向的水平单位向量（游戏坐标 x/z 平面） */
  fx: number;
  fz: number;
  fov: number;
}

const NAME_RE =
  /^(\d{4}-\d{2}-\d{2})\[(\d{2})-(\d{2})\]_(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)_(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)_([\d.]+)/;

/** 解析 EFT 截图文件名；格式不匹配返回 null */
export function parseScreenshotName(name: string): TrackPoint | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  // EFT（Unity 左手系，Y 轴向上）：朝向 = q * (0,0,1)，取 x/z 水平分量归一化
  const qx = +m[7];
  const qy = +m[8];
  const qz = +m[9];
  const qw = +m[10];
  const fx = 2 * (qx * qz + qw * qy);
  const fz = 1 - 2 * (qx * qx + qy * qy);
  const len = Math.hypot(fx, fz) || 1;
  return {
    id: name,
    time: `${m[1]} ${m[2]}:${m[3]}`,
    x: +m[4],
    y: +m[5],
    z: +m[6],
    fx: fx / len,
    fz: fz / len,
    fov: +m[11],
  };
}

/** 轨迹点上限，超出丢弃最旧的 */
const MAX_POINTS = 500;

// 非响应式内部状态（不进 state，避免深度代理 Observer 实例）
let observer: FSObserver | null = null;
const seen = new Set<string>();

export const useTrackStore = defineStore("track", {
  state: () => ({
    /** 是否正在监听 */
    enabled: false,
    /** 截图目录名 */
    dirName: "",
    /** 轨迹点，按截图时间先后排序 */
    points: [] as TrackPoint[],
    /** 最近一次新截图的时间戳（用于 UI 触发） */
    lastAt: 0,
  }),
  actions: {
    /** 开启监听；返回 null 表示成功，否则为错误文本（需在用户手势中调用）。
     * forcePicker 跳过已持久化的目录，强制重新选择 */
    async enable(forcePicker = false): Promise<string | null> {
      const unsupported = checkFsSupport();
      if (unsupported) return unsupported;
      const handle = await acquireDir("screenshotDir", "eft-screenshots", forcePicker);
      if (!handle) return "未选择截图目录或授权失败";
      await this.startWatching(handle);
      return null;
    },
    disable() {
      observer?.disconnect();
      observer = null;
      this.enabled = false;
    },
    clear() {
      this.points = [];
    },
    async startWatching(handle: FileSystemDirectoryHandle) {
      this.disable();
      // 基线：监听开启前的已有文件不补标
      seen.clear();
      for await (const h of handle.values()) {
        if (h.kind === "file") seen.add(h.name);
      }
      observer = new window.FileSystemObserver!((records) => {
        for (const r of records) {
          if (r.type !== "appeared" || r.changedHandle.kind !== "file") continue;
          const name = r.changedHandle.name;
          if (!name.toLowerCase().endsWith(".png") || seen.has(name)) continue;
          seen.add(name);
          const point = parseScreenshotName(name);
          if (!point) {
            console.warn("截图文件名无法解析:", name);
            continue;
          }
          this.points.push(point);
          if (this.points.length > MAX_POINTS) this.points.shift();
          this.lastAt = Date.now();
        }
      });
      await observer.observe(handle);
      this.dirName = handle.name;
      this.enabled = true;
    },
  },
});
