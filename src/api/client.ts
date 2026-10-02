/** json.tarkov.dev 数据拉取：静态数据走 localStorage 7 天缓存，实时价格直连 */

export const BASE_URL = "https://json.tarkov.dev";

const STATIC_TTL = 7 * 24 * 3600 * 1000;

export async function fetchJson<T = unknown>(path: string): Promise<T> {
  const resp = await fetch(`${BASE_URL}${path}`);
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
