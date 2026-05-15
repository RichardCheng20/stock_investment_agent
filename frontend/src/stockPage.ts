export type SymbolSearchHit = { symbol: string; name: string | null };

const HEART_ON = `<svg class="heart-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`;

const HEART_OFF = `<svg class="heart-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`;

const ICON_CHEVRON =
  '<svg class="stock-search-item__chev" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function watchHeartBtnHtml(symbol: string, inWatchlist: boolean, esc: (s: string) => string): string {
  const sym = esc(symbol.trim().toUpperCase());
  const label = inWatchlist ? "移出自选" : "加入自选";
  return `<button type="button" class="btn-watch-heart${inWatchlist ? " btn-watch-heart--on" : ""}" data-toggle-watch="${sym}" aria-label="${label}" aria-pressed="${inWatchlist ? "true" : "false"}">${inWatchlist ? HEART_ON : HEART_OFF}</button>`;
}

export function stockSearchSheetHtml(
  open: boolean,
  loading: boolean,
  query: string,
  results: SymbolSearchHit[],
  esc: (s: string) => string
): string {
  if (!open) return "";
  const rows =
    results.length === 0
      ? `<p class="stock-search-empty">${loading ? "搜索中…" : "输入代码或名称搜索美股"}</p>`
      : results
          .map((r) => {
            const sym = r.symbol.toUpperCase();
            const name = r.name && r.name !== "—" ? esc(r.name) : "—";
            const enc = encodeURIComponent(sym);
            return (
              '<button type="button" class="stock-search-item" data-open-stock="' +
              enc +
              '">' +
              '<span class="stock-search-item__mkt">US</span>' +
              '<span class="stock-search-item__body">' +
              `<span class="stock-search-item__sym">${esc(sym)}</span>` +
              `<span class="stock-search-item__name">${name}</span>` +
              "</span>" +
              ICON_CHEVRON +
              "</button>"
            );
          })
          .join("");

  return (
    '<div class="stock-search-backdrop" id="stockSearchBackdrop" aria-hidden="false"></div>' +
    '<aside class="stock-search-sheet stock-search-sheet--full" id="stockSearchSheet" aria-label="搜索股票">' +
    '<div class="stock-search-sheet__head">' +
    '<button type="button" class="stock-search-sheet__back" id="stockSearchClose" title="返回" aria-label="返回">‹</button>' +
    '<input type="text" id="stockSearchInput" class="stock-search-input" placeholder="代码或名称，如 NVDA / 英伟达" autocomplete="off" value="' +
    esc(query) +
    '" />' +
    "</div>" +
    `<div class="stock-search-results" id="stockSearchResults">${rows}</div>` +
    "</aside>"
  );
}
