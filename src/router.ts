import { createWebHashHistory, createRouter } from "vue-router";

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", name: "arbitrage", component: () => import("@/views/ArbitrageView.vue") },
    { path: "/items", name: "items", component: () => import("@/views/ItemsView.vue") },
    { path: "/tasks", name: "tasks", component: () => import("@/views/TasksView.vue") },
    { path: "/map", name: "map", component: () => import("@/views/MapView.vue") },
  ],
});
