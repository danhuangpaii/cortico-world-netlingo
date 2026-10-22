import { describe, it, expect } from 'vitest';
import {
  findPageImage,
  parseBingHtml,
  parseBingRss,
  parseDuckDuckGoHtml,
  parseGenericHtml,
  parseJsonHits,
  parseSo360Html,
  parseSogouHtml,
} from '../src/search.ts';

const DDG_HTML = `
<div class="result results_links">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fyyds&amp;rut=abc">yyds 是什么梗</a>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fyyds">永远的神,夸人厉害。</a>
</div>
<div class="result results_links">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fmeme">梗百科</a>
  <a class="result__snippet" href="https://example.org/meme">网络用语合集。</a>
</div>`;

describe('搜索响应解析', () => {
  it('从 360 结果取标题、摘要与地址,跳过「其他人还搜了」', () => {
    const html =
      '<h3 class="res-title"><a href="https://www.so.com/link?m=abc">尊嘟假嘟这个梗怎么接</a></h3>' +
      '<p class="res-desc">6天前 - 谐音梗,意思是「真的假的」。</p>' +
      '<h3 class="res-title"><a href="">其他人还搜了</a></h3>' +
      '<h3 class="res-title"><a href="https://www.bilibili.com/video/1">尊嘟假嘟是什么梗</a></h3>' +
      '<p class="res-desc">这个词出自短视频。</p>';
    const hits = parseSo360Html(html, 5);
    expect(hits).toHaveLength(2);
    expect(hits[0].title).toBe('尊嘟假嘟这个梗怎么接');
    expect(hits[0].snippet).toContain('谐音梗');
    expect(hits[0].url).toBe('https://www.so.com/link?m=abc');
  });

  it('从搜狗结果把站内跳转补成绝对地址', () => {
    const html =
      '<h3 class="vr-title"><a href="/link?url=xyz">你说爱我尊嘟假嘟怎么回答</a></h3>';
    const hits = parseSogouHtml(html, 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].url).toBe('https://www.sogou.com/link?url=xyz');
    expect(hits[0].title).toBe('你说爱我尊嘟假嘟怎么回答');
  });

  it('从 Bing RSS 取条目', () => {
    const xml =
      '<rss><channel><item><title>标题甲</title><link>https://a.example</link>' +
      '<description>摘要甲</description></item>' +
      '<item><title><![CDATA[标题乙]]></title><link>https://b.example</link></item>' +
      '</channel></rss>';
    const hits = parseBingRss(xml, 5);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({ title: '标题甲', snippet: '摘要甲', url: 'https://a.example' });
    expect(hits[1].title).toBe('标题乙');
  });

  it('从 Bing 结果块取标题、摘要与地址', () => {
    const html =
      '<ol id="b_results">' +
      '<li class="b_algo" data-id iid=SERP.1><h2><a target="_blank" href="https://baike.baidu.com/item/yyds">' +
      'yyds<strong>（网络流行语）</strong></a></h2><div class="b_caption"><p class="b_lineclamp2">' +
      'yyds，即永远的神的缩写。</p></div></li>' +
      '<li class="b_algo" data-id iid=SERP.2><h2><a href="https://zhuanlan.zhihu.com/p/1">梗的来源</a></h2>' +
      '<div class="b_caption"><p>直播间里的说法。</p></div></li></ol>';
    const hits = parseBingHtml(html, 5);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({
      title: 'yyds（网络流行语）',
      snippet: 'yyds，即永远的神的缩写。',
      url: 'https://baike.baidu.com/item/yyds',
    });
    expect(hits[1].url).toBe('https://zhuanlan.zhihu.com/p/1');
  });

  it('Bing 结果条数受 maxResults 限制', () => {
    const html = '<li class="b_algo"><h2><a href="https://a.example">甲</a></h2></li><li class="b_algo"><h2><a href="https://b.example">乙</a></h2></li>';
    expect(parseBingHtml(html, 1)).toHaveLength(1);
  });

  it('从 DuckDuckGo HTML 取标题、摘要与真实地址', () => {
    const hits = parseDuckDuckGoHtml(DDG_HTML, 5);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({
      title: 'yyds 是什么梗',
      snippet: '永远的神,夸人厉害。',
      url: 'https://example.com/yyds',
    });
    expect(hits[1].url).toBe('https://example.org/meme');
  });

  it('结果条数受 maxResults 限制', () => {
    expect(parseDuckDuckGoHtml(DDG_HTML, 1)).toHaveLength(1);
  });

  it('认常见 JSON 形状', () => {
    const payload = {
      results: [
        { title: 'A', snippet: 'a', url: 'https://a.example' },
        { name: 'B', description: 'b', link: 'https://b.example' },
      ],
    };
    const hits = parseJsonHits(payload, 5);
    expect(hits.map((h) => h.title)).toEqual(['A', 'B']);
    expect(hits[1].url).toBe('https://b.example');
  });

  it('认嵌在 organic 里的结果', () => {
    const hits = parseJsonHits({ organic: { results: [{ title: 'C', url: 'https://c.example' }] } }, 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toBe('');
  });

  it('认不出结构时返回空数组,不编造', () => {
    expect(parseJsonHits({ error: 'rate limited' }, 5)).toEqual([]);
    expect(parseJsonHits(null, 5)).toEqual([]);
  });

  it('通用 HTML 兜底只要 http(s) 链接', () => {
    const hits = parseGenericHtml('<a href="https://x.example">X 站</a><a href="/relative">相对</a><a href="https://y.example">Y 站</a>', 5);
    expect(hits.map((h) => h.url)).toEqual(['https://x.example', 'https://y.example']);
  });

  it('从页面取 og:image 并把相对地址补全', () => {
    const html = '<meta property="og:image" content="/img/cover.png">';
    expect(findPageImage(html, 'https://example.com/post/1')).toBe('https://example.com/img/cover.png');
  });

  it('页面没有图时返回 null', () => {
    expect(findPageImage('<html><body>text</body></html>', 'https://example.com')).toBeNull();
  });
});
