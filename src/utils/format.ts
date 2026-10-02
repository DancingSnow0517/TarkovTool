/** 价格/数字格式化 */

export function fmtPrice(v?: number | null): string {
  return v ? v.toLocaleString("en-US") : "-";
}

export function fmtPct(v?: number | null, digits = 1): string {
  return v == null ? "-" : `${v.toFixed(digits)}%`;
}

export function fmtSignedPct(v?: number | null): string {
  return v == null ? "-" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}
