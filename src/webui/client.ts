import type {
  WebUiClientBundle,
  WebUiPanel,
  WebUiPanelContext,
} from 'cortico/web/shared/client-panel.ts';

interface TermRow {
  term: string;
  meaning: string;
  example: string;
  chains: string[];
  tags: string[];
  learnedAt: string;
}

interface Payload {
  counts: { terms: number; exchanges: number; stickers: number; memes: number };
  terms: TermRow[];
}

const panel: WebUiPanel = {
  async mount(ctx: WebUiPanelContext) {
    const ui = ctx.ui;
    const grid = ui.h('div', 'statgrid');
    const search = ui.input({ type: 'search' });
    const refresh = ui.button('刷新', { size: 'sm' });
    const bar = ui.rowbar();
    bar.append(search, refresh);

    const table = ui.table({
      head: ['词 / 梗', '用法', '接龙', '标签', '记下时间'],
      maxHeight: 'calc(100vh - 320px)',
    });

    ctx.root.append(grid, bar, table.el);

    let data: Payload | null = null;

    const render = (): void => {
      if (!data) return;
      grid.replaceChildren(
        ui.stat({ k: '词条', v: data.counts.terms }),
        ui.stat({ k: '对话对', v: data.counts.exchanges }),
        ui.stat({ k: '表情标签', v: data.counts.stickers }),
        ui.stat({ k: '梗图', v: data.counts.memes }),
      );
      const q = search.value.trim().toLowerCase();
      const rows = q
        ? data.terms.filter((row) =>
            [row.term, row.meaning, row.example, ...row.tags, ...row.chains]
              .join(' ')
              .toLowerCase()
              .includes(q),
          )
        : data.terms;
      table.clear(rows.length ? undefined : '还没有词条。让 Coo 用 netlingo_learn 记几条。');
      for (const row of rows) {
        table.addRow([
          row.term,
          { text: row.meaning, cls: 'txt' },
          row.chains.length ? row.chains.join('\n') : '—',
          row.tags.length ? row.tags.join(' / ') : '—',
          row.learnedAt.slice(0, 16).replace('T', ' '),
        ]);
      }
    };

    const load = async (): Promise<void> => {
      refresh.disabled = true;
      try {
        data = await ctx.invoke<Payload>('list');
        render();
      } catch (err) {
        ui.toast(`读取失败:${err instanceof Error ? err.message : String(err)}`, 'bad');
      } finally {
        refresh.disabled = false;
      }
    };

    search.addEventListener('input', render);
    refresh.addEventListener('click', () => {
      void load();
    });
    await load();
  },
};

export default { panels: { library: panel } } satisfies WebUiClientBundle;
