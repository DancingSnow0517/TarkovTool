import { defineStore } from "pinia";
import { useSyncStore } from "@/stores/sync";

/** 地图页任务列表：被追踪任务 id + 已完成目标 id 集合。
 * 本地持久化（localStorage），并通过同步通道在 host/client 之间双向同步。
 * 本地变更（add/remove/setDone）会广播；远程应用（applyRemote）只更新本地，不再回传，避免回环。 */

const STORAGE_KEY = "map-tracked-tasks";

function loadState(): { tasks: string[]; done: string[] } {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as unknown;
    // 旧格式：纯任务 id 数组（无完成状态）
    if (Array.isArray(v)) return { tasks: v.filter((x): x is string => typeof x === "string"), done: [] };
    if (v && typeof v === "object") {
      const o = v as { tasks?: unknown; done?: unknown };
      return {
        tasks: Array.isArray(o.tasks) ? o.tasks.filter((x): x is string => typeof x === "string") : [],
        done: Array.isArray(o.done) ? o.done.filter((x): x is string => typeof x === "string") : [],
      };
    }
    console.error("任务列表缓存格式异常，已重置:", v);
  } catch (e) {
    console.error("读取任务列表缓存失败:", e);
  }
  return { tasks: [], done: [] };
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export const useMapTasksStore = defineStore("mapTasks", {
  state: () => {
    const saved = loadState();
    return {
      /** 被追踪的任务 id 列表（有序，先加在前） */
      ids: saved.tasks,
      /** 已完成的目标 id 列表（objective id，与任务是否被追踪无关，URL 进来的目标也可勾选） */
      done: saved.done,
    };
  },
  actions: {
    persist() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ tasks: this.ids, done: this.done }));
      } catch (e) {
        console.error("任务列表写入缓存失败:", e);
      }
    },

    notify() {
      useSyncStore().notifyTracked(this.ids, this.done);
    },

    add(id: string) {
      if (this.ids.includes(id)) return;
      this.ids.push(id);
      this.persist();
      this.notify();
    },

    remove(id: string) {
      const i = this.ids.indexOf(id);
      if (i < 0) return;
      this.ids.splice(i, 1);
      this.persist();
      this.notify();
    },

    /** 批量勾选/取消勾选目标（同一绘制点位的多个目标一起变） */
    setDone(obIds: string[], done: boolean) {
      const set = new Set(this.done);
      for (const id of obIds) {
        if (done) set.add(id);
        else set.delete(id);
      }
      const next = [...set];
      if (sameList(next, this.done)) return;
      this.done = next;
      this.persist();
      this.notify();
    },

    /** 应用远程下发的任务列表与完成状态（同步通道）；内容相同则跳过，避免无意义重绘 */
    applyRemote(ids: string[], done: string[]) {
      const cleanIds = ids.filter((x): x is string => typeof x === "string");
      const cleanDone = done.filter((x): x is string => typeof x === "string");
      const idsChanged = !sameList(cleanIds, this.ids);
      const doneChanged = !sameList(cleanDone, this.done);
      if (!idsChanged && !doneChanged) return;
      this.ids = cleanIds;
      this.done = cleanDone;
      this.persist();
    },
  },
});
