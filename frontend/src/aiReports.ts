export type StockAiReport = {
  symbol: string;
  reply: string;
  analyzedAt: string;
  buyScore: number | null;
  stance?: string | null;
  keyRisk?: string | null;
};

const STORAGE_KEY = "stock_ai_reports_v1";

export function beijingTodayDate(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
}

export function reportBeijingDate(report: StockAiReport): string | null {
  const m = report.analyzedAt.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/** 仅当报告生成日为北京时间「今天」时视为有效缓存，避免刷新页面后重复点 AI。 */
export function isAnalyzedToday(report: StockAiReport): boolean {
  const d = reportBeijingDate(report);
  return d !== null && d === beijingTodayDate();
}

export function loadAiReports(): Record<string, StockAiReport> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw) as Record<string, StockAiReport>;
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

export function saveAiReport(report: StockAiReport): void {
  const all = loadAiReports();
  all[report.symbol.toUpperCase()] = report;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

export function getAiReport(symbol: string): StockAiReport | null {
  return loadAiReports()[symbol.toUpperCase()] ?? null;
}

/** 自选列表用：仅返回今日内的报告。 */
export function getTodayAiReport(symbol: string): StockAiReport | null {
  const r = getAiReport(symbol);
  if (!r || !isAnalyzedToday(r)) return null;
  return r;
}

export function deleteAiReport(symbol: string): void {
  const all = loadAiReports();
  delete all[symbol.toUpperCase()];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}
