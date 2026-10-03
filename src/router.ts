import { createWebHashHistory, createRouter } from "vue-router";

declare global {
  interface Window {
    /** index.html 中 GA4 gtag 注入；未加载（如本地开发被拦截）时跳过上报 */
    gtag?: (...args: unknown[]) => void;
  }
}

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", name: "home", component: () => import("@/views/HomeView.vue") },
    { path: "/deals", name: "arbitrage", component: () => import("@/views/ArbitrageView.vue") },
    { path: "/items", name: "items", component: () => import("@/views/ItemsView.vue") },
    { path: "/tasks", name: "tasks", component: () => import("@/views/TasksView.vue") },
    { path: "/map", name: "map", component: () => import("@/views/MapView.vue") },
  ],
});

// hash 路由切换不会触发浏览器历史事件，GA4 自动 page_view 只统计首次加载，需手动补报
router.afterEach((to) => {
  window.gtag?.("event", "page_view", { page_path: to.fullPath });
});
