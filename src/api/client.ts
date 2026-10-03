/** json.tarkov.dev 数据拉取：静态数据走 localStorage 7 天缓存，实时价格直连 */

export const BASE_URL = "https://json.tarkov.dev";

const STATIC_TTL = 7 * 24 * 3600 * 1000;

export async function fetchJson<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${BASE_URL}${path}`, init);
  if (!resp.ok) throw new Error(`${path} → HTTP ${resp.status}`);
  return (await resp.json()) as T;
}

/** 带 TTL 的 localStorage 缓存拉取，仅用于翻译、商人、任务等静态数据 */
export async function fetchCached<T = unknown>(path: string, ttl = STATIC_TTL): Promise<T> {
  const key = `cache:${path}`;
  try {
    const hit = JSON.parse(localStorage.getItem(key) ?? "null") as { t: number; d: T } | null;
    if (hit && Date.now() - hit.t < ttl) return hit.d;
  } catch {
    // 缓存损坏则重新下载
  }
  const data = await fetchJson<T>(path);
  try {
    localStorage.setItem(key, JSON.stringify({ t: Date.now(), d: data }));
  } catch {
    // 存储满则放弃缓存
  }
  return data;
}

/**
 * 拉取后先裁剪再缓存（用于 /maps 等大体积接口，只存需要的字段，避免超出 localStorage 配额）。
 * 缓存键与 fetchCached 不同（cache-trim: 前缀），两者互不影响。
 * cacheVer：裁剪格式变更时递增，让旧格式缓存失效。
 */
export async function fetchCachedTrimmed<R, T>(
  path: string,
  trim: (raw: R) => T,
  ttl = STATIC_TTL,
  cacheVer = 1,
): Promise<T> {
  const key = `cache-trim:v${cacheVer}:${path}`;
  try {
    const hit = JSON.parse(localStorage.getItem(key) ?? "null") as { t: number; d: T } | null;
    if (hit && Date.now() - hit.t < ttl) return hit.d;
  } catch {
    // 缓存损坏则重新下载
  }
  const data = trim(await fetchJson<R>(path));
  try {
    localStorage.setItem(key, JSON.stringify({ t: Date.now(), d: data }));
  } catch {
    // 存储满则放弃缓存
  }
  return data;
}
