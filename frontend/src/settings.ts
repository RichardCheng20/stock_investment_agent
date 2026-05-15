export type ColorScheme = "cn" | "us" | "pink_up" | "pink_dn";

/** 表格中点击股票代码时打开的外部行情页 */
export type QuoteLinkTarget = "yahoo" | "eastmoney" | "google";

/** 界面明暗：深色护眼（默认） / 浅色日间 */
export type ColorTheme = "dark" | "light";

export type DisplayPrefs = {
  colorScheme: ColorScheme;
  /** 背景明暗（与红涨绿跌的 colorScheme 无关） */
  colorTheme: ColorTheme;
  nameFirst: boolean;
  compact: boolean;
  showUsBadge: boolean;
  swapChgPctColumns: boolean;
  quoteLinkTarget: QuoteLinkTarget;
  /** true：新标签打开行情；false：当前标签打开（可用浏览器「返回」回到自选） */
  quoteLinkNewTab: boolean;
};

const STORAGE_KEY = "sia_display_prefs_v1";

export const DEFAULT_PREFS: DisplayPrefs = {
  colorScheme: "cn",
  colorTheme: "dark",
  nameFirst: true,
  compact: false,
  showUsBadge: false,
  swapChgPctColumns: false,
  quoteLinkTarget: "yahoo",
  quoteLinkNewTab: false,
};

/** 新标签打开：Yahoo / 东财美股页 / Google（类股代码 Yahoo/Google 用 `-`） */
export function quoteDetailUrl(symbol: string, target: QuoteLinkTarget): string {
  const raw = symbol.trim().toUpperCase();
  const dash = raw.replace(/\./g, "-");
  switch (target) {
    case "eastmoney":
      return `https://quote.eastmoney.com/us/${encodeURIComponent(raw)}.html`;
    case "google":
      return `https://www.google.com/finance/quote/${encodeURIComponent(dash)}`;
    case "yahoo":
    default:
      return `https://finance.yahoo.com/quote/${encodeURIComponent(dash)}`;
  }
}

export function loadPrefs(): DisplayPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const j = JSON.parse(raw) as Partial<DisplayPrefs>;
    return {
      ...DEFAULT_PREFS,
      ...j,
      colorScheme: isColorScheme(j.colorScheme) ? j.colorScheme : DEFAULT_PREFS.colorScheme,
      colorTheme: j.colorTheme === "light" ? "light" : "dark",
      quoteLinkTarget: isQuoteLinkTarget(j.quoteLinkTarget)
        ? j.quoteLinkTarget
        : DEFAULT_PREFS.quoteLinkTarget,
      quoteLinkNewTab: j.quoteLinkNewTab === true,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function isColorScheme(x: unknown): x is ColorScheme {
  return x === "cn" || x === "us" || x === "pink_up" || x === "pink_dn";
}

function isQuoteLinkTarget(x: unknown): x is QuoteLinkTarget {
  return x === "yahoo" || x === "eastmoney" || x === "google";
}

export function savePrefs(p: DisplayPrefs): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
}

export function applyPrefsToDocument(p: DisplayPrefs): void {
  const root = document.documentElement;
  root.dataset.colorTheme = p.colorTheme;
  root.dataset.colorScheme = p.colorScheme;
  root.dataset.compact = p.compact ? "1" : "0";
  root.dataset.nameFirst = p.nameFirst ? "1" : "0";
  root.dataset.usBadge = p.showUsBadge ? "1" : "0";
  root.dataset.swapChgPct = p.swapChgPctColumns ? "1" : "0";
  root.style.colorScheme = p.colorTheme;
}
