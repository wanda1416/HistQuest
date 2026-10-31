import { normalizeDynasty } from './index.ts';

/**
 * 朝代年代区间（史学分期，与索引口径一致）。
 * 用于回答"他生活在唐朝之前吗"这类相对时序问题。
 */
export interface Span {
  start: number;
  end: number;
}

const SPANS: Record<string, Span> = {
  史前: { start: -3000, end: -2070 },
  商: { start: -1600, end: -1046 },
  西周: { start: -1046, end: -771 },
  春秋: { start: -770, end: -476 },
  战国: { start: -475, end: -221 },
  秦: { start: -221, end: -207 },
  西汉: { start: -202, end: 9 },
  东汉: { start: 25, end: 220 },
  三国: { start: 220, end: 280 },
  西晋: { start: 265, end: 316 },
  东晋: { start: 317, end: 420 },
  南北朝: { start: 420, end: 589 },
  隋: { start: 581, end: 618 },
  唐: { start: 618, end: 907 },
  五代: { start: 907, end: 960 },
  北宋: { start: 960, end: 1127 },
  南宋: { start: 1127, end: 1279 },
  辽: { start: 907, end: 1125 },
  金: { start: 1115, end: 1234 },
  西夏: { start: 1038, end: 1227 },
  大理: { start: 937, end: 1253 },
  蒙古: { start: 1206, end: 1271 },
  元: { start: 1271, end: 1368 },
  明: { start: 1368, end: 1644 },
  清: { start: 1644, end: 1912 },
  近代: { start: 1840, end: 1949 },
};

/**
 * 从问句里取"玩家问的是哪个朝代"。
 * 模型返回的 dynasty.value 有歧义（可能是"人物所属朝代"），所以判罚口径必须靠问句本身定。
 * 单字朝代要求带"朝/代"后缀，避免"公元前"里的"元"、"元宵"之类误命中。
 */
export function extractDynasty(question: string): string | null {
  const q = String(question ?? '').replace(/公元前|公元/g, '');
  for (const name of MULTI) {
    if (q.includes(name)) return name;
  }
  for (const name of SINGLE) {
    if (new RegExp(`${name}(朝|代)`).test(q)) return name;
  }
  return null;
}

const MULTI = ['南北朝', '北宋', '南宋', '西汉', '东汉', '西晋', '东晋', '春秋', '战国', '三国', '五代', '蒙古', '西夏', '大理', '史前'];
const SINGLE = ['唐', '宋', '元', '明', '清', '汉', '晋', '周', '秦', '隋', '辽', '金'];

/**
 * 生卒年覆盖过的所有时期。
 * 这是"朝代归属"的唯一口径：只要与某个朝代的起止有重叠，就算经历过。
 * 曹操因此不算三国（卒于 220，三国始于同年）；蒲松龄因此算明（1640 年生）。
 */
export function periodsLived(birth: number | null, death: number | null): string[] {
  if (birth === null || death === null) return [];
  const out: string[] = [];
  for (const [name, span] of Object.entries(SPANS)) {
    if (birth < span.end && death > span.start) out.push(name);
  }
  return out;
}
