/** json.tarkov.dev 数据拉取：静态数据走 Cache Storage 7 天缓存（支持离线读取），实时价格直连 */

export const BASE_URL = "https://json.tarkov.dev";

const STATIC_TTL = 7 * 24 * 3600 * 1000;
const CACHE_NAME = "api-static-v1";

/** 写入时间放在自定义响应头上，读取时按 TTL 判断新鲜度 */
interface CacheEntry {
  text: string;
  fresh: boolean;
}

async function cacheGet(key: string, ttl: number): Promise<CacheEntry | null> {
  try {
    const cache = await caches.open(CACHE_NAME);
    const resp = await cache.match(key);
    if (!resp) return null;
    const t = Number(resp.headers.get("x-cached-at") ?? 0);
    const text = await resp.text();
    return { text, fresh: t > 0 && Date.now() - t < ttl };
  } catch (e) {
    console.warn("Cache Storage 读取失败:", key, e);
    return null;
  }
}

async function cachePut(key: string, text: string): Promise<void> {
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(
      key,
      new Response(text, {
        headers: { "content-type": "application/json", "x-cached-at": String(Date.now()) },
      }),
    );
  } catch (e) {
    console.warn("Cache Storage 写入失败:", key, e);
  }
}

export async function fetchJson<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${BASE_URL}${path}`, init);
  if (!resp.ok) throw new Error(`${path} → HTTP ${resp.status}`);
  return (await resp.json()) as T;
}

/** 拉取并写入缓存；网络失败时若有过期缓存则降级使用（离线兜底），同时记日志 */
async function fetchAndCache(key: string, path: string): Promise<string> {
  const resp = await fetch(`${BASE_URL}${path}`);
  if (!resp.ok) throw new Error(`${path} → HTTP ${resp.status}`);
  const text = await resp.text();
  void cachePut(key, text);
  return text;
}

async function cachedText(path: string, keySuffix: string, ttl: number): Promise<string> {
  const key = `${BASE_URL}${keySuffix}${path}`;
  const hit = await cacheGet(key, ttl);
  if (hit?.fresh) return hit.text;
  try {
    return await fetchAndCache(key, path);
  } catch (e) {
    if (hit) {
      console.warn("网络拉取失败，使用过期缓存:", path, e);
      return hit.text;
    }
    throw e;
  }
}

/** 带 TTL 的 Cache Storage 缓存拉取，仅用于翻译、商人、任务等静态数据 */
export async function fetchCached<T = unknown>(path: string, ttl = STATIC_TTL): Promise<T> {
  return JSON.parse(await cachedText(path, "", ttl)) as T;
}

/**
 * 拉取后先裁剪再缓存（用于 /maps 等大体积接口，只存需要的字段）。
 * 缓存键与 fetchCached 不同（/.trim/ 路径前缀），两者互不影响。
 * cacheVer：裁剪格式变更时递增，让旧格式缓存失效。
 */
export async function fetchCachedTrimmed<R, T>(
  path: string,
  trim: (raw: R) => T,
  ttl = STATIC_TTL,
  cacheVer = 1,
): Promise<T> {
  const key = `${BASE_URL}/.trim/v${cacheVer}${path}`;
  const hit = await cacheGet(key, ttl);
  if (hit?.fresh) return JSON.parse(hit.text) as T;
  let raw: R;
  try {
    raw = await fetchJson<R>(path);
  } catch (e) {
    if (hit) {
      console.warn("网络拉取失败，使用过期缓存:", path, e);
      return JSON.parse(hit.text) as T;
    }
    throw e;
  }
  const data = trim(raw);
  void cachePut(key, JSON.stringify(data));
  return data;
}

/** 清理旧版 localStorage 缓存键（已迁移到 Cache Storage） */
export function dropLegacyCache() {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    if (k.startsWith("cache:") || k.startsWith("cache-trim:")) keys.push(k);
  }
  for (const k of keys) localStorage.removeItem(k);
  if (keys.length) console.info(`已清理 ${keys.length} 个旧版 localStorage 缓存键`);
}
