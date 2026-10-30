import type { Character, PronounStyle } from '../shared/domain.ts';

/**
 * 回答文本的泄漏过滤。
 *
 * 核心问题：模型倾向于"把话说完整"，于是问"是唐朝之前吗"会答"不是，她是北宋至南宋时期的人物"——
 * 这等于把没被问到的维度直接报出来了，比泄露姓名更伤游戏。
 *
 * 做法：只要回答里出现人物的朝代 / 身份 / 籍贯 / 生卒年 / 姓名，就判定为越界，
 * 弃用模型原话、退回模板（"不是。"）。模板虽然干巴巴，但只说该说的。
 */

const MULTI_DYNASTY = [
  '南北朝', '北宋', '南宋', '西汉', '东汉', '西晋', '东晋',
  '春秋', '战国', '三国', '五代', '蒙古', '近代',
];
const SINGLE_DYNASTY = ['唐', '宋', '元', '明', '清', '秦', '汉', '晋', '周', '隋'];

/** 具体朝代 → 玩家/模型常用的泛称。只拦"北宋"会漏掉"宋朝"。 */
const GROUP_OF: Record<string, string> = {
  北宋: '宋',
  南宋: '宋',
  西汉: '汉',
  东汉: '汉',
  西晋: '晋',
  东晋: '晋',
  春秋: '周',
  战国: '周',
};

function dynastyMentions(c: Character): string[] {
  const out: string[] = [];
  const all = [c.polity, ...(c.polityAlt ?? [])];
  for (const name of all) {
    if (MULTI_DYNASTY.includes(name)) out.push(name);
    else if (SINGLE_DYNASTY.includes(name)) {
      // 单字朝代必须带"朝/代"，否则"明白""周末"都会误伤
      out.push(`${name}朝`, `${name}代`);
    }
    const group = GROUP_OF[name];
    if (group) out.push(`${group}朝`, `${group}代`);
  }
  return out;
}

function yearMentions(c: Character): string[] {
  const out: string[] = [];
  for (const y of [c.birth, c.death]) {
    if (y === null) continue;
    out.push(String(Math.abs(y)));
  }
  return out;
}

function birthplaceMentions(c: Character): string[] {
  const out: string[] = [];
  if (c.birthProvince) out.push(c.birthProvince);
  if (c.birthplace) {
    const city = c.birthplace.split(/[（(]/)[0]?.trim();
    if (city && city.length >= 2) out.push(city);
  }
  return out;
}

/** 回答里是否泄露了未被问到的资料维度 */
export function leaksProfile(text: string, c: Character): boolean {
  const t = String(text ?? '');
  if (!t) return false;

  const triggers = [
    ...dynastyMentions(c),
    ...c.roles,
    ...birthplaceMentions(c),
    ...yearMentions(c),
    c.name,
    ...c.aliases,
  ].filter((x) => x && x.length >= 2);

  return triggers.some((x) => t.includes(x));
}

/**
 * 性别词中性化。
 * 玩家问"他"，模型却回"她"——一个字就把性别卖了。开启后统一替换为 TA。
 */
export function neutralizePronoun(text: string, style: PronounStyle): string {
  if (style !== 'neutral') return text;
  return String(text ?? '')
    .replace(/她们/g, 'TA们')
    .replace(/他们/g, 'TA们')
    .replace(/[他她]/g, 'TA');
}
