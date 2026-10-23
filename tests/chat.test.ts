import { describe, it, expect } from 'vitest';
import { pairLines, parseForwardLines } from '../src/chat.ts';

describe('聊天记录解析', () => {
  it('跳过系统行,按「名字: 内容」拆行', () => {
    const text =
      '[系统] #123 引用的转发消息展开如下：\n' +
      '甲(10001): 你只是怕了\n' +
      '乙(10002): 这谁不怕\n' +
      '丙: 试试就试试';
    const lines = parseForwardLines(text);
    expect(lines).toEqual([
      { name: '甲', body: '你只是怕了' },
      { name: '乙', body: '这谁不怕' },
      { name: '丙', body: '试试就试试' },
    ]);
  });

  it('没有冒号或内容太短的行丢掉', () => {
    const lines = parseForwardLines('这一行没有冒号\n甲: x\n乙: 正常内容');
    expect(lines).toEqual([{ name: '乙', body: '正常内容' }]);
  });

  it('支持中文冒号', () => {
    const lines = parseForwardLines('甲：中文冒号也行');
    expect(lines).toEqual([{ name: '甲', body: '中文冒号也行' }]);
  });

  it('超过 maxLines 就停', () => {
    const text = Array.from({ length: 10 }, (_, i) => `甲: 第${i}句内容`).join('\n');
    expect(parseForwardLines(text, 3)).toHaveLength(3);
  });

  it('相邻不同人才配对,同一人连说不配', () => {
    const pairs = pairLines([
      { name: '甲', body: '一' },
      { name: '甲', body: '二' },
      { name: '乙', body: '三' },
      { name: '甲', body: '四' },
    ]);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toEqual({ a: { name: '甲', body: '二' }, b: { name: '乙', body: '三' } });
    expect(pairs[1]).toEqual({ a: { name: '乙', body: '三' }, b: { name: '甲', body: '四' } });
  });

  it('少于两行时没有对话对', () => {
    expect(pairLines([{ name: '甲', body: '只有一句' }])).toEqual([]);
  });
});
