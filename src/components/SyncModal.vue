<script setup lang="ts">
/* 同步到手机弹窗：开启 WebRTC host，展示二维码/链接与连接状态。
 * 打开时自动 startHost；关闭弹窗不停止同步（工具栏按钮保持高亮），「停止同步」显式停止 */
import { computed, nextTick, ref, watch } from "vue";
import { NButton, NModal, useMessage } from "naive-ui";
import QRCode from "qrcode";
import { useSyncStore } from "@/stores/sync";

const props = defineProps<{ show: boolean; mapKey: string }>();
const emit = defineEmits<{ "update:show": [value: boolean] }>();

const sync = useSyncStore();
const message = useMessage();
const qrEl = ref<HTMLCanvasElement>();

const syncUrl = computed(() =>
  sync.hostId ? `${location.origin}${import.meta.env.BASE_URL}#/map?sync=${sync.hostId}` : "",
);

// 打开弹窗时若未在同步则开启 host
watch(
  () => props.show,
  (v) => {
    if (v && !sync.hosting) sync.startHost(props.mapKey);
  },
);

// hostId 就绪（且 canvas 已挂载）后生成二维码
watch(
  () => [props.show, sync.hostId],
  async () => {
    if (!props.show || !sync.hostId) return;
    await nextTick();
    if (!qrEl.value) return;
    try {
      await QRCode.toCanvas(qrEl.value, syncUrl.value, { width: 220, margin: 1 });
    } catch (e) {
      console.error("二维码生成失败:", e);
      message.error("二维码生成失败，请手动复制链接");
    }
  },
  { immediate: true },
);

async function copyUrl() {
  try {
    await navigator.clipboard.writeText(syncUrl.value);
    message.success("链接已复制");
  } catch (e) {
    console.error("复制链接失败:", e);
    message.error("复制失败，请手动选择链接复制");
  }
}

function stop() {
  sync.stopHost();
  emit("update:show", false);
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    title="同步到手机"
    style="width: min(360px, 92vw)"
    @update:show="emit('update:show', $event)"
  >
    <div v-if="sync.hostId" class="sync-body">
      <canvas ref="qrEl" class="sync-qr"></canvas>
      <div class="sync-url">{{ syncUrl }}</div>
      <NButton size="small" @click="copyUrl">复制链接</NButton>
      <div class="sync-state">
        {{ sync.hostConnCount ? `已连接 ${sync.hostConnCount} 台设备` : "等待手机连接 ..." }}
      </div>
      <div class="sync-hint">
        手机与电脑需在同一局域网；仅握手经过公共信令服务，位置数据点对点直连。
      </div>
      <NButton size="small" type="error" secondary @click="stop">停止同步</NButton>
    </div>
    <div v-else class="sync-state">{{ sync.hostError || "正在创建连接 ..." }}</div>
  </NModal>
</template>

<style scoped>
.sync-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.sync-qr {
  border-radius: 6px;
}

.sync-url {
  font-size: 12px;
  word-break: break-all;
  text-align: center;
  opacity: 0.8;
}

.sync-state {
  font-size: 13px;
}

.sync-hint {
  font-size: 12px;
  opacity: 0.6;
  text-align: center;
}
</style>
