/* WebRTC 位置同步的极简信令服务（Cloudflare Worker + Durable Object）。
 * 协议兼容 ntfy 子集：POST /:topic 发布，GET /:topic/sse 订阅（SSE 推送 ntfy 风格封套），
 * 前端 src/stores/sync.ts 只需把信令服务器地址指向本 Worker。
 * 消息纯内存转发，不落盘；无订阅者时消息直接丢弃（客户端会周期性重发 join，无需缓存）。 */

interface Env {
  ROOMS: DurableObjectNamespace;
}

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const m = new URL(request.url).pathname.match(/^\/([A-Za-z0-9_-]{4,64})(\/sse)?$/);
    if (!m) return new Response("not found", { status: 404, headers: CORS });
    if (request.method === "POST" && m[2]) {
      return new Response("bad request", { status: 400, headers: CORS });
    }
    const room = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
    return room.fetch(request);
  },
};

/** 一个 topic 一间房：持有该 topic 的全部 SSE 订阅者，publish 时扇出 */
export class SignalingRoom implements DurableObject {
  private writers = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private encoder = new TextEncoder();
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST") {
      const body = await request.text();
      // ntfy 封套格式：前端解析 env.message 为业务消息体
      const chunk = this.encoder.encode(
        `data: ${JSON.stringify({ event: "message", message: body })}\n\n`,
      );
      for (const w of this.writers) {
        w.write(chunk).catch((e: unknown) => {
          console.warn("SSE 写入失败，移除订阅:", e);
          this.writers.delete(w);
        });
      }
      return new Response("ok", { headers: CORS });
    }

    if (request.method === "GET" && url.pathname.endsWith("/sse")) {
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const writer = writable.getWriter();
      this.writers.add(writer);
      // 心跳防止中间代理断开空闲连接；无人订阅时停掉
      if (!this.heartbeat) {
        this.heartbeat = setInterval(() => {
          if (!this.writers.size && this.heartbeat) {
            clearInterval(this.heartbeat);
            this.heartbeat = null;
            return;
          }
          const ping = this.encoder.encode(": ka\n\n");
          for (const w of this.writers) {
            w.write(ping).catch(() => this.writers.delete(w));
          }
        }, 25_000);
      }
      return new Response(readable, {
        headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      });
    }

    return new Response("bad request", { status: 400, headers: CORS });
  }
}
