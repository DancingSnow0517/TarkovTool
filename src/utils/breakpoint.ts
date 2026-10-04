import { onBeforeUnmount, ref, type Ref } from "vue";

/** 窄屏断点（≤768px），导航/布局切换用；网格等纯样式场景直接用 CSS media query */
export function useNarrow(): Ref<boolean> {
  const mq = window.matchMedia("(max-width: 768px)");
  const narrow = ref(mq.matches);
  const onChange = (e: MediaQueryListEvent) => {
    narrow.value = e.matches;
  };
  mq.addEventListener("change", onChange);
  onBeforeUnmount(() => mq.removeEventListener("change", onChange));
  return narrow;
}
