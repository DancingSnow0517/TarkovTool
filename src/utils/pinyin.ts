import { pinyin } from "pinyin-pro";

const CJK = /[一-鿿]/;

/** 中文名生成拼音搜索索引：全拼 + 首字母（对应 CLI 的 pypinyin 逻辑） */
export function pinyinIndex(name: string): { py: string; pya: string } {
  if (!CJK.test(name)) return { py: "", pya: "" };
  return {
    py: pinyin(name, { toneType: "none", separator: "" }).toLowerCase(),
    pya: pinyin(name, { pattern: "first", toneType: "none", separator: "" }).toLowerCase(),
  };
}
