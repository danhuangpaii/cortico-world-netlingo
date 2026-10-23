/** QQ 分享的聊天记录:事件正文是「名字(QQ号): 内容」逐行,解析成可配对的对话行。 */

export interface ChatLine {
  /** 发言人,可能是昵称、QQ 号或「你」。 */
  name: string;
  /** 正文。 */
  body: string;
}

/**
 * 解析一条 `qq.forward` 事件的正文。第一行是「[系统] #id 引用的转发消息展开如下」,跳过;
 * 其余每行按「名字: 内容」拆开。没有冒号或内容太短的行丢掉。
 */
export function parseForwardLines(text: string, maxLines = 40): ChatLine[] {
  const out: ChatLine[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('[系统]')) continue;
    const match = /^([^:：]{1,40})[:：]\s*(.+)$/.exec(line);
    if (!match) continue;
    // 名字可能带 QQ 号:「甲(10001)」,去掉括号与数字只留称呼。
    const name = match[1].trim().replace(/\s*\(\d+\)$/, '');
    const body = match[2].trim();
    if (!name || body.length < 2) continue;
    out.push({ name, body: body.slice(0, 200) });
    if (out.length >= maxLines) break;
  }
  return out;
}

/** 相邻两条不同发言人的行配成一来一回;同一人连说的不配。 */
export function pairLines(lines: readonly ChatLine[]): Array<{ a: ChatLine; b: ChatLine }> {
  const pairs: Array<{ a: ChatLine; b: ChatLine }> = [];
  for (let i = 0; i < lines.length - 1; i += 1) {
    const a = lines[i];
    const b = lines[i + 1];
    if (!a || !b) continue;
    if (a.name === b.name) continue;
    pairs.push({ a, b });
  }
  return pairs;
}
