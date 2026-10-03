import { defineStore } from "pinia";
import { MARKER_GROUPS } from "@/utils/markers";

export const GAME_MODES = [
  { label: "PVP (regular)", value: "regular" },
  { label: "PVPS (赛季服 pvp-season)", value: "pvp-season" },
  { label: "PVE (pve)", value: "pve" },
] as const;

export type GameMode = (typeof GAME_MODES)[number]["value"];

export const LANGUAGES = [
  "cs", "de", "en", "es", "fr", "hu", "id", "it", "ja", "ko",
  "pl", "pt", "ro", "ru", "sk", "th", "tr", "vn", "zh",
] as const;

const STORAGE_KEY = "tarkov-tool-config";

/** 地图标记类别 key（地图页分组面板的子项，定义在 utils/markers） */
export const MAP_MARKER_KEYS = MARKER_GROUPS.flatMap((g) => g.children.map((c) => c.key));

interface Persisted {
  mode?: string;
  lang?: string;
  favorites?: string[];
  columns?: string[];
  /** 被取消勾选的标记类别（缺省/空 = 全部启用；新增类别对老用户默认启用） */
  mapMarkersOff?: string[];
}

function loadPersisted(): Persisted {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Persisted;
  } catch {
    return {};
  }
}

/** 用户配置：游戏模式、语言、收藏物品、物品列表列配置，持久化到 localStorage */
export const useConfigStore = defineStore("config", {
  state: () => {
    const p = loadPersisted();
    return {
      mode: (GAME_MODES.some((m) => m.value === p.mode) ? p.mode : "regular") as GameMode,
      lang: p.lang && (LANGUAGES as readonly string[]).includes(p.lang) ? p.lang : "zh",
      favorites: new Set<string>(p.favorites ?? []),
      /** 被取消勾选的地图标记类别；null 表示全部启用（默认） */
      mapMarkersOff: (p.mapMarkersOff?.length ? new Set<string>(p.mapMarkersOff) : null) as Set<string> | null,
      /** null 表示使用默认列 */
      columns: null as string[] | null,
      ...(p.columns?.length ? { columns: p.columns } : {}),
    };
  },
  actions: {
    toggleFavorite(id: string) {
      if (this.favorites.has(id)) this.favorites.delete(id);
      else this.favorites.add(id);
    },
    /** 更新地图标记勾选（传入启用的类别）；全部启用时归一为 null（默认态，不写入持久化） */
    setMapMarkers(enabled: string[]) {
      const off = MAP_MARKER_KEYS.filter((k) => !enabled.includes(k));
      this.mapMarkersOff = off.length ? new Set(off) : null;
      this.persist();
    },
    persist() {
      const data: Persisted = {
        mode: this.mode,
        lang: this.lang,
        favorites: [...this.favorites],
      };
      if (this.columns) data.columns = this.columns;
      if (this.mapMarkersOff) data.mapMarkersOff = [...this.mapMarkersOff];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    },
  },
});
