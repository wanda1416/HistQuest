import type { Character } from '../shared/domain.ts';
import type { RecordView } from '../shared/protocol.ts';

/**
 * 把对局记录导出成可读纯文本。
 * 格式固定为「提问：… / 回应：… / 提示：…」，方便贴到聊天窗口或论坛。
 *
 * 注意：对局进行中调用时绝不能带目标人物——那是答案。
 */
export interface TranscriptOptions {
  /** 标题行，例如「猜历史 · 对局记录」 */
  title?: string;
  /** 仅揭晓后允许传入 */
  character?: Character | null;
  turnsUsed?: number;
}

function fmtYear(year: number | null): string {
  if (year === null || year === undefined) return '不详';
  return year < 0 ? `公元前 ${Math.abs(year)} 年` : `${year} 年`;
}

export function formatTranscript(history: RecordView[], opts: TranscriptOptions = {}): string {
  const blocks: string[] = [];

  if (opts.title) {
    const head: string[] = [opts.title];
    if (opts.character) {
      const c = opts.character;
      const dyn = c.dynastyAlt?.length ? `${c.dynasty}（亦经历 ${c.dynastyAlt.join('、')}）` : c.dynasty;
      head.push(`目标：${c.name}（${dyn}）`);
      head.push(`生卒：${fmtYear(c.birth)} — ${fmtYear(c.death)}`);
      if (typeof opts.turnsUsed === 'number') head.push(`有效提问：${opts.turnsUsed} 次`);
    }
    blocks.push(head.join('\n'));
  }

  for (const r of history) {
    const lines = [`提问：${r.question}`, `回应：${r.text}`];
    if (r.hint) lines.push(`提示：${r.hint}`);
    blocks.push(lines.join('\n'));
  }

  return blocks.join('\n\n').trim();
}

/** 复制用：对局中只给问答，揭晓后才带人物卡 */
export function transcriptForGame(history: RecordView[]): string {
  return formatTranscript(history);
}

export function transcriptForReview(
  history: RecordView[],
  character: Character,
  turnsUsed: number,
): string {
  return formatTranscript(history, {
    title: '猜历史 · 对局记录',
    character,
    turnsUsed,
  });
}
