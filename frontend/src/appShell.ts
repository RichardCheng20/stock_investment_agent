/** 与小程序 / App 底栏一致：自选 + 个股 + AI 分析 */
export type AppTab = "watchlist" | "stock" | "ai";

export type ListMarketFilter = "all" | "us" | "hk";

const TAB_KEY = "sia_app_tab_v1";
const LIST_KEY = "sia_list_market_v1";
const VIEW_KEY = "sia_view_symbol_v1";

export function loadAppTab(): AppTab {
  try {
    const v = sessionStorage.getItem(TAB_KEY);
    if (v === "ai") return "ai";
    if (v === "stock" || v === "market") return "stock";
  } catch {
    /* ignore */
  }
  return "watchlist";
}

export function saveAppTab(tab: AppTab): void {
  try {
    sessionStorage.setItem(TAB_KEY, tab);
  } catch {
    /* ignore */
  }
}

export function loadViewSymbol(): string | null {
  try {
    const s = sessionStorage.getItem(VIEW_KEY);
    if (!s) return null;
    const t = s.trim().toUpperCase();
    if (/^[A-Z0-9.\-]{1,12}$/.test(t)) return t;
  } catch {
    /* ignore */
  }
  return null;
}

export function saveViewSymbol(symbol: string | null): void {
  try {
    if (symbol) sessionStorage.setItem(VIEW_KEY, symbol);
    else sessionStorage.removeItem(VIEW_KEY);
  } catch {
    /* ignore */
  }
}

export function loadListMarketFilter(): ListMarketFilter {
  try {
    const v = sessionStorage.getItem(LIST_KEY);
    if (v === "us" || v === "hk") return v;
  } catch {
    /* ignore */
  }
  return "all";
}

export function saveListMarketFilter(f: ListMarketFilter): void {
  try {
    sessionStorage.setItem(LIST_KEY, f);
  } catch {
    /* ignore */
  }
}

const WATCH_SEG_KEY = "sia_watch_segment_v1";

/** m:all | m:us | m:hk（历史 f: 分组已废弃，读到则回落到全部） */
export function loadWatchlistSegment(): string {
  try {
    const v = sessionStorage.getItem(WATCH_SEG_KEY);
    if (v === "m:us" || v === "m:hk" || v === "m:all") return v;
    if (v && v.startsWith("f:")) {
      sessionStorage.setItem(WATCH_SEG_KEY, "m:all");
      return "m:all";
    }
    const legacy = sessionStorage.getItem(LIST_KEY);
    if (legacy === "us") return "m:us";
    if (legacy === "hk") return "m:hk";
  } catch {
    /* ignore */
  }
  return "m:all";
}

export function saveWatchlistSegment(tab: string): void {
  try {
    sessionStorage.setItem(WATCH_SEG_KEY, tab);
  } catch {
    /* ignore */
  }
}

function icoStar(active: boolean): string {
  const fill = active ? "currentColor" : "none";
  return `<svg class="tab-bar__svg" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path fill="${fill}" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" d="M12 2.5l2.6 6.6H22l-5.5 4 2.1 6.4L12 15.8 5.4 19l2.1-6.4L2 9.1h6.8L12 2.5z"/></svg>`;
}

function icoChart(active: boolean): string {
  const stroke = active ? "currentColor" : "var(--tab-ico-muted)";
  return `<svg class="tab-bar__svg" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="${stroke}" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" d="M4 19V5m0 14h16M7.5 16l3.5-5 3 2.5L19 8"/></svg>`;
}

function icoAi(active: boolean): string {
  const c = active ? "currentColor" : "var(--tab-ico-muted)";
  return `<svg class="tab-bar__svg" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path fill="${c}" d="M9 3h6v2H9V3zm-2 4h10v12a2 2 0 01-2 2H9a2 2 0 01-2-2V7zm3 3v1h2v-1h-2zm0 3v4h2v-4h-2z"/></svg>`;
}

export function tabBarHtml(active: AppTab): string {
  const w = active === "watchlist";
  const s = active === "stock";
  const a = active === "ai";
  return `<nav class="tab-bar tab-bar--3" aria-label="主导航">
  <button type="button" class="tab-bar__btn${w ? " tab-bar__btn--active" : ""}" data-app-tab="watchlist" aria-current="${w ? "page" : "false"}">
    ${icoStar(w)}
    <span class="tab-bar__label">自选</span>
  </button>
  <button type="button" class="tab-bar__btn${s ? " tab-bar__btn--active" : ""}" data-app-tab="stock" aria-current="${s ? "page" : "false"}">
    ${icoChart(s)}
    <span class="tab-bar__label">个股</span>
  </button>
  <button type="button" class="tab-bar__btn${a ? " tab-bar__btn--active" : ""}" data-app-tab="ai" aria-current="${a ? "page" : "false"}">
    ${icoAi(a)}
    <span class="tab-bar__label">AI</span>
  </button>
</nav>`;
}

export function indexStripHtml(): string {
  return `<div class="index-strip" role="status">
  <span class="index-strip__name">指数条</span>
  <span class="index-strip__hint">占位 · 后续可接上证 / 恒生等</span>
</div>`;
}
