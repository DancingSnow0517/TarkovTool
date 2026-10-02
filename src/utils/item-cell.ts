import { h } from "vue";

/** 物品/任务名称单元格：懒加载图标 + 本地化名称外链（stopPropagation 防止触发行点击） */
export function renderItemName(row: { name: string; link: string; icon: string }) {
  return h("span", { class: "item-cell" }, [
    row.icon
      ? h("img", { src: row.icon, alt: row.name, loading: "lazy", class: "item-icon" })
      : null,
    h(
      "a",
      {
        href: row.link,
        target: "_blank",
        rel: "noopener noreferrer",
        class: "item-name",
        onClick: (e: MouseEvent) => e.stopPropagation(),
      },
      row.name,
    ),
  ]);
}
