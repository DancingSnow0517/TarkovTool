<script setup lang="ts">
import { onMounted, ref, useId } from "vue";

const props = defineProps<{ path: string }>();

/** 评论云函数地址，默认自建 Cloudflare Worker */
const envId = import.meta.env.VITE_COMMENT_URL || "https://comment.dancingsnow.xyz";
const elId = `twikoo-${useId()}`;
const error = ref("");

onMounted(async () => {
  try {
    const { init } = await import("twikoo");
    await init({ envId, el: `#${elId}`, path: props.path, lang: "zh-CN" });
  } catch (e) {
    console.error("[comment] twikoo 加载失败", e);
    error.value = `评论区加载失败：${e instanceof Error ? e.message : String(e)}`;
  }
});
</script>

<template>
  <div class="comment-section">
    <h4>评论</h4>
    <p v-if="error" class="comment-error">{{ error }}</p>
    <div :id="elId"></div>
  </div>
</template>

<style>
.comment-section {
  margin-top: 16px;
}

.comment-section h4 {
  margin: 0 0 12px;
}

.comment-error {
  color: #e88080;
  font-size: 13px;
}
</style>
