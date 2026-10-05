/** twikoo 无官方类型声明，仅声明本项目用到的 API 面 */
declare module "twikoo" {
  interface TwikooInitOptions {
    /** 环境 ID，即云函数地址（含 https://） */
    envId: string;
    /** 评论挂载点，CSS 选择器 */
    el: string;
    /** 评论串路径，用于区分不同页面的评论 */
    path?: string;
    /** 界面语言 */
    lang?: string;
  }

  const twikoo: {
    init(options: TwikooInitOptions): Promise<unknown>;
  };
  export default twikoo;
  /** UMD 产物的具名导出，与 default.init 为同一函数 */
  export function init(options: TwikooInitOptions): Promise<unknown>;
}
