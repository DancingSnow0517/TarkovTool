/** 地图标记的分组/类别定义：MapView 绘制与面板使用，config store 从中取全部 key 做持久化 */

/** 一个标记类别（面板子项），color 用于区域描边，icon 用于中心点图标 */
export interface MarkerCatDef {
  key: string;
  label: string;
  color: string;
  /** public/assets/interactive/ 下的文件名（本地图标） */
  icon?: string;
  /** 完整图标 URL（远程图标，优先级高于 icon） */
  iconUrl?: string;
}

/** 标记分组（面板一级行，三态勾选联动子项） */
export interface MarkerGroupDef {
  key: string;
  label: string;
  children: MarkerCatDef[];
}

/* 赛季文件：散图拾取的特殊文件物品（EFT 赛季收集品），
 * 图标直接用物品的 baseImageLink（https://assets.tarkov.dev/<id>-base-image.webp），
 * 排序按全图点位数量从多到少 */
export const SEASON_FILES = [
  { key: "file-blueprint", id: "6a31824878450ec91c0ea1ae", label: "蓝图与技术文档" },
  { key: "file-project", id: "6a3181f178450ec91c0ea1aa", label: "项目文件" },
  { key: "file-staff", id: "6a3182b72fd891345e047eef", label: "员工文档" },
  { key: "file-medical", id: "6a3182dc6cd8de21cf0a3a7d", label: "医疗文件" },
  { key: "file-financial", id: "6a31807f17005505b70d5827", label: "财务文件" },
  { key: "file-technical", id: "6a31830dde69ceafd805afa0", label: "技术文档" },
  { key: "file-pmc-profile", id: "6a317b9692cfdcddcb02a58e", label: "PMC 个人档案" },
  { key: "file-test", id: "6a31828557705071410ca00e", label: "测试文档" },
];

export const SEASON_FILE_IDS = new Set(SEASON_FILES.map((f) => f.id));

export const SEASON_FILES_BY_ID = new Map(SEASON_FILES.map((f) => [f.id, f]));

/* 分组与类别定义：key 与 config store 持久化的勾选状态对应；
 * 搜刮容器子项按 lootContainers 的 normalizedName 划分（同名不同 id 自动归并），
 * 排序按全图数量从多到少 */
export const MARKER_GROUPS: MarkerGroupDef[] = [
  {
    key: "extracts",
    label: "撤离点",
    children: [
      { key: "pmc-extract", label: "PMC撤离点", color: "#37b24d", icon: "extract_pmc.webp" },
      { key: "scav-extract", label: "Scav撤离点", color: "#f08c00", icon: "extract_scav.webp" },
      { key: "coop-extract", label: "共享撤离点", color: "#22b8cf", icon: "extract_shared.webp" },
      { key: "transit", label: "转移", color: "#e8590c", icon: "extract_transit.webp" },
    ],
  },
  {
    key: "hazards",
    label: "危险区",
    children: [
      { key: "minefield", label: "地雷", color: "#fab005", icon: "hazard.webp" },
      { key: "sniper", label: "狙击手", color: "#e64980", icon: "hazard.webp" },
    ],
  },
  {
    key: "interactive",
    label: "可交互",
    children: [
      { key: "locked-door", label: "上锁的门", color: "#d0bfff", icon: "lock.png" },
      { key: "stationary-weapon", label: "固定机炮", color: "#ff8787", icon: "stationarygun.webp" },
      { key: "switch", label: "开关", color: "#63e6be", icon: "switch.png" },
    ],
  },
  {
    key: "loot",
    label: "搜刮容器",
    children: [
      { key: "duffle-bag", label: "旅行包", color: "#9d9d9d", icon: "container_duffle-bag.webp" },
      { key: "drawer", label: "抽屉", color: "#9d9d9d", icon: "container_drawer.png" },
      { key: "weapon-box", label: "武器箱", color: "#9d9d9d", icon: "container_weapon-box.png" },
      { key: "toolbox", label: "工具箱", color: "#9d9d9d", icon: "container_toolbox.png" },
      { key: "wooden-crate", label: "木制板条箱", color: "#9d9d9d", icon: "container_wooden-crate.png" },
      { key: "jacket", label: "夹克", color: "#9d9d9d", icon: "container_jacket.png" },
      { key: "pc-block", label: "电脑机箱", color: "#9d9d9d", icon: "container_pc-block.png" },
      { key: "cash-register", label: "收银机", color: "#9d9d9d", icon: "container_cash-register.png" },
      { key: "grenade-box", label: "手榴弹箱", color: "#9d9d9d", icon: "container_grenade-box.webp" },
      { key: "dead-scav", label: "死去的Scav", color: "#9d9d9d", icon: "container_dead-scav.webp" },
      { key: "buried-barrel-cache", label: "物资埋藏桶", color: "#9d9d9d", icon: "container_buried-barrel-cache.png" },
      { key: "medbag", label: "SMU06 医疗包", color: "#9d9d9d", icon: "container_medbag.png" },
      { key: "pmc-body", label: "PMC尸体", color: "#9d9d9d", icon: "container_dead-scav.webp" },
      { key: "ground-cache", label: "物资埋藏箱", color: "#9d9d9d", icon: "container_ground-cache.png" },
      { key: "technical-supply-crate", label: "技术物资箱", color: "#9d9d9d", icon: "container_crate.png" },
      { key: "wooden-ammo-box", label: "木制弹药箱", color: "#9d9d9d", icon: "container_wooden-ammo-box.webp" },
      { key: "medcase", label: "医药箱", color: "#9d9d9d", icon: "container_medcase.png" },
      { key: "plastic-suitcase", label: "塑料手提箱", color: "#9d9d9d", icon: "container_plastic-suitcase.png" },
      { key: "safe", label: "保险箱", color: "#9d9d9d", icon: "container_safe.png" },
      { key: "ration-supply-crate", label: "配给物资箱", color: "#9d9d9d", icon: "container_crate.png" },
      { key: "medical-supply-crate", label: "医疗物资箱", color: "#9d9d9d", icon: "container_crate.png" },
      { key: "civilian-body", label: "死去的平民", color: "#9d9d9d", icon: "container_dead-scav.webp" },
      { key: "bank-safe", label: "银行保险箱", color: "#9d9d9d", icon: "container_safe.png" },
      { key: "bank-cash-register", label: "银行收银柜", color: "#9d9d9d", icon: "container_cash-register.png" },
      { key: "scav-body", label: "Scav尸体", color: "#9d9d9d", icon: "container_dead-scav.webp" },
      { key: "lab-technician-body", label: "实验室技术员尸体", color: "#9d9d9d", icon: "container_dead-scav.webp" },
      // 数据源无译名，保留 normalizedName（全图仅 1 个）
      { key: "shturmans-stash", label: "shturmans-stash", color: "#9d9d9d", icon: "container_weapon-box.png" },
    ],
  },
  {
    key: "season-files",
    label: "赛季文件",
    children: SEASON_FILES.map((f) => ({
      key: f.key,
      label: f.label,
      color: "#9d9d9d",
      iconUrl: `https://assets.tarkov.dev/${f.id}-base-image.webp`,
    })),
  },
];

export const MARKER_CATS = new Map(MARKER_GROUPS.flatMap((g) => g.children.map((c) => [c.key, c])));
