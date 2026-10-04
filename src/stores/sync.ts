import { defineStore } from "pinia";
import { useTrackStore } from "@/stores/track";
import type { TrackPoint } from "@/stores/track";

/** PC → 移动端位置同步：WebRTC DataChannel 局域网 P2P 直连，
 * 仅 SDP 握手经过公共信令服务（ntfy.sh，纯 HTTPS：SSE 订阅 + POST 发布，代理/防火墙友好）。
 * 不配置 TURN：位置数据不会经过任何第三方转发，连不上即一直等待，不绕行公网。
 *
 * 信令协议（两个 ntfy topic，消息为 JSON）：
 *   <topic>-req  client → host：join / answer
 *   <topic>-res  host → client：offer
 * 1. host 订阅 <topic>-req
 * 2. client 订阅 <topic>-res，并周期性发布 {join, cid} 直到收到自己的 offer
 * 3. host 收到 join → 建 RTCPeerConnection + DataChannel，ICE 收集完毕后发布 {offer, cid, sdp}
 * 4. client 收到自己 cid 的 offer → 应答 {answer, cid, sdp} 发布到 -req
 * 5. host 收到 answer → DataChannel 打开 → 下发全量快照，之后增量广播
 * cid 为 client 每次连接的随机标识，用于多设备区分与断线重连去重。 */

export type SyncMsg =
  /** 连接建立后 host 立即下发的全量快照 */
  | { type: "state"; map: string; points: TrackPoint[] }
  /** 新截图点增量广播 */
  | { type: "point"; point: TrackPoint }
  /** host 地图切换（手动或日志自动切图） */
  | { type: "map"; map: string };

export type ClientStatus = "off" | "connecting" | "connected" | "reconnecting";

/** 信令服务器：默认自建 Worker（ntfy 协议子集）；可用构建环境变量 VITE_SIGNALING_URL 覆盖（如回退公共 ntfy.sh） */
const SIGNALING: string =
  import.meta.env.VITE_SIGNALING_URL || "https://signal.dancingsnow.xyz";
const TOPIC_PREFIX = "ttk-sync-";
/** client 未连接时重新发布 join 的间隔 */
const JOIN_INTERVAL_MS = 8000;
/** 断线重连退避：1s/2s/4s…封顶 10s */
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 10000;
/** 无 TURN；STUN 仅用于跨网段兜底，同局域网走 host candidate */
const RTC_CONFIG: RTCConfiguration = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

function randomStr(len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 36).toString(36);
  return s;
}

/** 订阅信令 topic（SSE，断线由 EventSource 自动重连），解析出业务消息体（兼容 ntfy 封套与自建 Worker） */
function subscribe(topic: string, onMsg: (msg: unknown) => void): EventSource {
  const es = new EventSource(`${SIGNALING}/${topic}/sse`);
  es.onmessage = (e: MessageEvent<string>) => {
    try {
      const env = JSON.parse(e.data) as { event: string; message: string };
      if (env.event !== "message") return;
      onMsg(JSON.parse(env.message));
    } catch (err) {
      console.error("信令消息解析失败:", err);
    }
  };
  es.onerror = () => console.warn("信令订阅连接中断，等待自动重连:", topic);
  return es;
}

/** 发布信令消息到 topic */
async function publish(topic: string, msg: unknown): Promise<void> {
  const r = await fetch(`${SIGNALING}/${topic}`, { method: "POST", body: JSON.stringify(msg) });
  if (!r.ok) throw new Error(`信令发布失败: HTTP ${r.status}`);
}

/** 等待 ICE candidate 收集完毕（ SDP 内嵌全部候选，不做 trickle） */
function waitIceComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") resolve();
    });
  });
}

// ---- 非响应式内部状态（不进 state，避免深度代理 RTC/EventSource 实例） ----

// host 侧
let hostTopic = "";
let hostReqEs: EventSource | null = null;
let hostMap = "";
/** 每个 client（cid）一条连接 */
const hostPeers = new Map<string, { pc: RTCPeerConnection; dc: RTCDataChannel }>();

// client 侧
let clientResEs: EventSource | null = null;
let clientPc: RTCPeerConnection | null = null;
let clientDc: RTCDataChannel | null = null;
let clientTopic = "";
let clientCid = "";
let joinTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryCount = 0;

export const useSyncStore = defineStore("sync", {
  state: () => ({
    /** host：信令 id（topic 后缀；空 = 未开启） */
    hostId: "",
    /** host：已连接的设备数 */
    hostConnCount: 0,
    /** host：错误文本（空 = 正常） */
    hostError: "",
    /** client：连接状态 */
    clientStatus: "off" as ClientStatus,
    /** client：提示文本 */
    clientHint: "",
    /** client：收到的 host 当前地图 key（state/map 消息携带，供地图页切换） */
    remoteMap: "",
    /** remoteMap 最后更新戳：相同地图的重复切换事件也要触发 watcher */
    remoteMapAt: 0,
  }),
  getters: {
    hosting: (s) => s.hostId !== "",
  },
  actions: {
    /* ---- host 侧（PC） ---- */

    /** 开启同步：订阅信令 topic 等待移动端 join。互斥：会先停掉 client 角色 */
    startHost(currentMap: string) {
      this.disconnectClient();
      this.stopHost();
      hostMap = currentMap;
      hostTopic = TOPIC_PREFIX + randomStr(10);
      hostReqEs = subscribe(`${hostTopic}-req`, (msg) => {
        void this.handleReq(msg).catch((e: unknown) => {
          console.error("处理信令请求失败:", e);
          this.hostError = `信令处理失败: ${e instanceof Error ? e.message : String(e)}`;
        });
      });
      this.hostId = hostTopic.slice(TOPIC_PREFIX.length);
      this.hostError = "";
    },

    /** host：处理 -req 频道消息（join / answer） */
    async handleReq(msg: unknown) {
      const m = msg as { type?: string; cid?: string; sdp?: string };
      if (typeof m.cid !== "string" || !m.cid) return;
      const cid = m.cid;
      if (m.type === "join") {
        const existing = hostPeers.get(cid);
        if (existing && existing.dc.readyState === "open") return; // 已连接，忽略重复 join
        existing?.pc.close();
        const pc = new RTCPeerConnection(RTC_CONFIG);
        const dc = pc.createDataChannel("pos");
        hostPeers.set(cid, { pc, dc });
        dc.onopen = () => {
          this.hostConnCount = [...hostPeers.values()].filter(
            (p) => p.dc.readyState === "open",
          ).length;
          const track = useTrackStore();
          const snap: SyncMsg = { type: "state", map: hostMap, points: track.points };
          dc.send(JSON.stringify(snap));
        };
        const drop = () => {
          hostPeers.delete(cid);
          pc.close();
          this.hostConnCount = [...hostPeers.values()].filter(
            (p) => p.dc.readyState === "open",
          ).length;
        };
        dc.onclose = drop;
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === "failed" || pc.connectionState === "closed") drop();
        };
        await pc.setLocalDescription();
        await waitIceComplete(pc);
        await publish(`${hostTopic}-res`, {
          type: "offer",
          cid,
          sdp: pc.localDescription!.sdp,
        });
      } else if (m.type === "answer" && typeof m.sdp === "string") {
        const entry = hostPeers.get(cid);
        if (!entry) return; // 已断开或 cid 不属于本次会话
        await entry.pc.setRemoteDescription({ type: "answer", sdp: m.sdp });
      }
    },

    /** host：当前地图 key 变化（init 时调用）——更新快照并广播给已连接的移动端 */
    notifyMap(map: string) {
      if (!this.hosting) return;
      if (map === hostMap) return;
      hostMap = map;
      const msg = JSON.stringify({ type: "map", map } satisfies SyncMsg);
      for (const { dc } of hostPeers.values()) {
        if (dc.readyState === "open") dc.send(msg);
      }
    },

    /** host：广播新截图点 */
    notifyPoint(p: TrackPoint) {
      if (!hostPeers.size) return;
      const msg = JSON.stringify({ type: "point", point: p } satisfies SyncMsg);
      for (const { dc } of hostPeers.values()) {
        if (dc.readyState === "open") dc.send(msg);
      }
    },

    stopHost() {
      for (const { pc } of hostPeers.values()) pc.close();
      hostPeers.clear();
      hostReqEs?.close();
      hostReqEs = null;
      this.hostId = "";
      this.hostConnCount = 0;
      this.hostError = "";
    },

    /* ---- client 侧（手机） ---- */

    /** 连接到 PC 的同步 id。互斥：会先停掉 host 角色。未收到应答会周期性 join 等待 */
    connectClient(id: string) {
      this.stopHost();
      this.disconnectClient();
      clientTopic = TOPIC_PREFIX + id;
      clientCid = randomStr(8);
      retryCount = 0;
      this.clientStatus = "connecting";
      this.clientHint = "等待 PC 端开启同步 ...";
      clientResEs = subscribe(`${clientTopic}-res`, (msg) => {
        void this.handleRes(msg).catch((e: unknown) => {
          console.error("处理信令应答失败:", e);
        });
      });
      this.startJoinLoop();
    },

    /** client：周期性发布 join，直到 DataChannel 打开 */
    startJoinLoop() {
      if (joinTimer) return;
      const tick = () => {
        joinTimer = null;
        if (this.clientStatus !== "connecting" && this.clientStatus !== "reconnecting") return;
        publish(`${clientTopic}-req`, { type: "join", cid: clientCid }).catch((e: unknown) => {
          console.error("join 发布失败:", e);
          this.clientHint = "信令服务连接失败，重试中 ...";
        });
        joinTimer = setTimeout(tick, JOIN_INTERVAL_MS);
      };
      tick();
    },

    stopJoinLoop() {
      if (joinTimer) {
        clearTimeout(joinTimer);
        joinTimer = null;
      }
    },

    /** client：处理 -res 频道消息（offer） */
    async handleRes(msg: unknown) {
      const m = msg as { type?: string; cid?: string; sdp?: string };
      if (m.type !== "offer" || m.cid !== clientCid || typeof m.sdp !== "string") return;
      clientPc?.close();
      const pc = new RTCPeerConnection(RTC_CONFIG);
      clientPc = pc;
      pc.ondatachannel = (e) => {
        clientDc = e.channel;
        clientDc.onopen = () => {
          retryCount = 0;
          this.stopJoinLoop();
          this.clientStatus = "connected";
          this.clientHint = "";
        };
        clientDc.onmessage = (ev) => {
          try {
            this.handleMsg(JSON.parse(ev.data as string) as SyncMsg);
          } catch (err) {
            console.error("同步消息解析失败:", err);
          }
        };
        clientDc.onclose = () => this.scheduleReconnect();
      };
      pc.onconnectionstatechange = () => {
        console.warn("同步连接状态变化:", pc.connectionState, "ice:", pc.iceConnectionState);
        if (pc.connectionState === "failed") {
          this.scheduleReconnect(`连接失败（${pc.iceConnectionState}）`);
        }
      };
      pc.oniceconnectionstatechange = () => {
        console.warn("ICE 状态变化:", pc.iceConnectionState);
      };
      await pc.setRemoteDescription({ type: "offer", sdp: m.sdp });
      await pc.setLocalDescription();
      await waitIceComplete(pc);
      await publish(`${clientTopic}-req`, {
        type: "answer",
        cid: clientCid,
        sdp: pc.localDescription!.sdp,
      });
    },

    /** client：DataChannel 断开后退避重连（重新走 join 流程）；reason 为诊断信息（如 ICE 状态） */
    scheduleReconnect(reason = "") {
      if (retryTimer) return;
      if (this.clientStatus !== "connected" && this.clientStatus !== "connecting") return;
      this.clientStatus = "reconnecting";
      this.clientHint = reason ? `${reason}，重连中 ...` : "连接已断开，重连中 ...";
      const delay = Math.min(RETRY_BASE_MS * 2 ** retryCount, RETRY_MAX_MS);
      retryCount++;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (this.clientStatus !== "reconnecting") return;
        clientCid = randomStr(8); // 新 cid，避免与旧会话的信令混淆
        this.startJoinLoop();
      }, delay);
    },

    handleMsg(msg: SyncMsg) {
      const track = useTrackStore();
      if (msg.type === "state") {
        track.applyRemoteState(msg.points);
        this.remoteMap = msg.map;
        this.remoteMapAt = Date.now();
      } else if (msg.type === "point") {
        track.pushRemotePoint(msg.point);
      } else if (msg.type === "map") {
        this.remoteMap = msg.map;
        this.remoteMapAt = Date.now();
      }
    },

    disconnectClient() {
      this.stopJoinLoop();
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      clientPc?.close();
      clientPc = null;
      clientDc = null;
      clientResEs?.close();
      clientResEs = null;
      this.clientStatus = "off";
      this.clientHint = "";
      this.remoteMap = "";
      this.remoteMapAt = 0;
    },
  },
});
