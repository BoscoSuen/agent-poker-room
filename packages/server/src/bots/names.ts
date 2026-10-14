/** Agent display names. Picked at random, no duplicates at one table. */
export const BOT_LIST: string[] = [
  // Disney
  '米奇', '米妮', '唐老鸭', '黛西', '高飞', '布鲁托', '奇奇', '蒂蒂', '辛巴','小熊维尼', '跳跳虎', '史迪奇', '胡迪', '翠丝', '闪电麦昆', '板牙', '瓦力', '伊娃', '小美人鱼', '贝儿', '野兽', '灰姑娘', '白雪公主', '彼得潘', '小叮当','朱迪', '尼克', '米格', '小猪佩奇',
  // 花园宝宝
  '依古比古', '唔西迪西', '玛卡巴卡', '汤姆布利柏', '小点点', '哈呼呼', '叮叮车', '飞飞鱼',
];

/** Canned table talk per persona. LLM personas normally write their own line; these are fallbacks when the model stays quiet or its line is filtered. */
export const WEAK_TALK: string[] = ['我跟。', '看看翻牌再说。', '这把感觉不错。', '再便宜点我就跟了。', '随便玩玩。', '运气来了挡不住。', '哎呀，手滑。', '我就看一张。', '不能总是弃吧。', '今天手气一般。'];
export const DEFAULT_TALK: string[] = ['稳一点。', '看看翻牌。', '按规矩来。', '这把先观望。', '位置不错。', '慢慢打。', '等个好点。', '这价格可以。', '别急。', '继续。'];
export const AGGRESSIVE_TALK: string[] = ['加注！', '来点刺激的。', '谁怕谁。', '压力给到。', '跟不跟？', '全下也不是不行。', '这底池我要了。', '别想便宜看牌。', '再来。', '胆子大点。'];
export const GTO_TALK: string[] = ['频率打法。', '这是均衡策略。', '按范围出牌。', '平衡一下。', '数学不会骗人。', '长期期望为正。', '按 solver 来。', '混合频率。', '标准尺度。', '不剥削，只平衡。'];
export const TALK: Record<string, string[]> = { weak: WEAK_TALK, default: DEFAULT_TALK, aggressive: AGGRESSIVE_TALK, gto: GTO_TALK };
