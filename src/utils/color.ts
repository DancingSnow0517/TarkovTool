/** hex 颜色与白色/黑色按比例混合，用于由主题色推算 hover/pressed 变体 */
function mix(hex: string, target: number, ratio: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const m = (c: number) => Math.round(c + (target - c) * ratio);
  return `#${((1 << 24) | (m(r) << 16) | (m(g) << 8) | m(b)).toString(16).slice(1)}`;
}

/** naive-ui common 主题覆盖所需的主色系：hover 偏亮、pressed 偏暗 */
export function primaryVariants(primary: string) {
  return {
    primaryColor: primary,
    primaryColorHover: mix(primary, 255, 0.15),
    primaryColorPressed: mix(primary, 0, 0.15),
    primaryColorSuppl: primary,
  };
}
