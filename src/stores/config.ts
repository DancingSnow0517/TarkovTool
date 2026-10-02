import { defineStore } from "pinia";

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

interface Persisted {
  mode?: string;
  lang?: string;
  favorites?: string[];
  columns?: string[];
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
    persist() {
      const data: Persisted = {
        mode: this.mode,
        lang: this.lang,
        favorites: [...this.favorites],
      };
      if (this.columns) data.columns = this.columns;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    },
  },
});
