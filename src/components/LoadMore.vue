<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { NSpin } from "naive-ui";

const props = defineProps<{
  /** 正在加载（加载中不重复触发） */
  loading: boolean;
  /** 是否还有更多数据 */
  hasMore: boolean;
}>();

const emit = defineEmits<{ load: [] }>();

const sentinel = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | null = null;

onMounted(() => {
  observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && props.hasMore && !props.loading) {
      emit("load");
    }
  });
  if (sentinel.value) observer.observe(sentinel.value);
});

// 数据不足一屏时哨兵可能一直在视口内：loading 结束后补触发一次
watch(
  () => props.loading,
  (loading) => {
    if (loading || !props.hasMore || !sentinel.value) return;
    const rect = sentinel.value.getBoundingClientRect();
    if (rect.top < window.innerHeight) emit("load");
  },
);

onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <div ref="sentinel" class="load-more">
    <NSpin v-if="loading" :size="18" />
    <span v-else-if="hasMore" class="load-more-hint">下拉加载更多</span>
    <span v-else class="load-more-hint">已加载全部</span>
  </div>
</template>

<style scoped>
.load-more {
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 16px 0 8px;
  min-height: 40px;
}

.load-more-hint {
  color: var(--text-dim);
  font-size: 13px;
}
</style>
