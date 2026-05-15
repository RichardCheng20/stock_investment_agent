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

/** 报告生成日为北京时间「今天」 */
export function isAnalyzedToday(report: StockAiReport): boolean {
  const d = reportBeijingDate(report);
  return d !== null && d === beijingTodayDate();
}

function reportTimeValue(report: StockAiReport): number {
  const t = Date.parse(report.analyzedAt.replace(" ", "T"));
  return Number.isNaN(t) ? 0 : t;
}

export function mergeAiReports(
  a: Record<string, StockAiReport>,
  b: Record<string, StockAiReport>
): Record<string, StockAiReport> {
  const out: Record<string, StockAiReport> = { ...a };
  for (const [sym, rb] of Object.entries(b)) {
    const key = sym.toUpperCase();
    const ra = out[key];
    if (!ra || reportTimeValue(rb) >= reportTimeValue(ra)) {
      out[key] = { ...rb, symbol: key };
    }
  }
  return out;
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

export function saveAiReportsAll(all: Record<string, StockAiReport>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

export function saveAiReport(report: StockAiReport): void {
  const all = loadAiReports();
  all[report.symbol.toUpperCase()] = report;
  saveAiReportsAll(all);
}

export function getAiReport(symbol: string): StockAiReport | null {
  return loadAiReports()[symbol.toUpperCase()] ?? null;
}

/** 有本地/服务端同步的任意日期报告（用于展示，不耗 token） */
export function getCachedAiReport(symbol: string): StockAiReport | null {
  return getAiReport(symbol);
}

/** 组合优选等仍要求「今日」有效报告 */
export function getTodayAiReport(symbol: string): StockAiReport | null {
  const r = getAiReport(symbol);
  if (!r || !isAnalyzedToday(r)) return null;
  return r;
}

export function deleteAiReport(symbol: string): void {
  const all = loadAiReports();
  delete all[symbol.toUpperCase()];
  saveAiReportsAll(all);
}

export async function fetchAiReportsFromServer(): Promise<Record<string, StockAiReport>> {
  const res = await fetch("/api/ai/reports");
  if (!res.ok) return {};
  const data = (await res.json()) as { reports?: StockAiReport[] };
  const list = Array.isArray(data.reports) ? data.reports : [];
  const out: Record<string, StockAiReport> = {};
  for (const r of list) {
    if (!r?.symbol) continue;
    const sym = r.symbol.toUpperCase();
    out[sym] = { ...r, symbol: sym };
  }
  return out;
}

export async function persistAiReportToServer(report: StockAiReport): Promise<void> {
  const sym = report.symbol.toUpperCase();
  await fetch(`/api/ai/reports/${encodeURIComponent(sym)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(report),
  });
}

export async function deleteAiReportOnServer(symbol: string): Promise<void> {
  const sym = symbol.toUpperCase();
  const res = await fetch(`/api/ai/reports/${encodeURIComponent(sym)}`, { method: "DELETE" });
  if (res.status === 404) return;
  if (!res.ok) throw new Error(`删除服务端报告失败: ${res.status}`);
}
