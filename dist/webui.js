// Cortina/state/packages/cortico-world-netlingo/src/webui/client.ts
var panel = {
  async mount(ctx) {
    const ui = ctx.ui;
    const grid = ui.h("div", "statgrid");
    const search = ui.input({ type: "search" });
    const refresh = ui.button("\u5237\u65B0", { size: "sm" });
    const bar = ui.rowbar();
    bar.append(search, refresh);
    const table = ui.table({
      head: ["\u8BCD / \u6897", "\u7528\u6CD5", "\u63A5\u9F99", "\u6807\u7B7E", "\u8BB0\u4E0B\u65F6\u95F4"],
      maxHeight: "calc(100vh - 320px)"
    });
    ctx.root.append(grid, bar, table.el);
    let data = null;
    const render = () => {
      if (!data) return;
      grid.replaceChildren(
        ui.stat({ k: "\u8BCD\u6761", v: data.counts.terms }),
        ui.stat({ k: "\u5BF9\u8BDD\u5BF9", v: data.counts.exchanges }),
        ui.stat({ k: "\u8868\u60C5\u6807\u7B7E", v: data.counts.stickers }),
        ui.stat({ k: "\u6897\u56FE", v: data.counts.memes })
      );
      const q = search.value.trim().toLowerCase();
      const rows = q ? data.terms.filter(
        (row) => [row.term, row.meaning, row.example, ...row.tags, ...row.chains].join(" ").toLowerCase().includes(q)
      ) : data.terms;
      table.clear(rows.length ? void 0 : "\u8FD8\u6CA1\u6709\u8BCD\u6761\u3002\u8BA9 Coo \u7528 netlingo_learn \u8BB0\u51E0\u6761\u3002");
      for (const row of rows) {
        table.addRow([
          row.term,
          { text: row.meaning, cls: "txt" },
          row.chains.length ? row.chains.join("\n") : "\u2014",
          row.tags.length ? row.tags.join(" / ") : "\u2014",
          row.learnedAt.slice(0, 16).replace("T", " ")
        ]);
      }
    };
    const load = async () => {
      refresh.disabled = true;
      try {
        data = await ctx.invoke("list");
        render();
      } catch (err) {
        ui.toast(`\u8BFB\u53D6\u5931\u8D25:${err instanceof Error ? err.message : String(err)}`, "bad");
      } finally {
        refresh.disabled = false;
      }
    };
    search.addEventListener("input", render);
    refresh.addEventListener("click", () => {
      void load();
    });
    await load();
  }
};
var client_default = { panels: { library: panel } };
export {
  client_default as default
};
