import { beijingTodayDate } from "./aiReports";

export type PortfolioStance = "增持" | "持有" | "观望" | "减仓" | "调出";
export type ReduceAction = "减仓" | "调出" | "观望";

export type WatchlistRankItem = {
  symbol: string;
  rank: number;
  relativeScore: number;
  stance: PortfolioStance;
  reason: string;
  compareReason?: string;
};

export type ReduceOrExitItem = {
  symbol: string;
  action: ReduceAction;
  reason: string;
};

export type WatchlistRankResult = {
  agent?: "portfolio_curator";
  rankedAt: string;
  beijingDate: string;
  topK: number;
  symbolsKey: string;
  ranked: WatchlistRankItem[];
  topPicks: string[];
  reduceOrExit: ReduceOrExitItem[];
  portfolioRisks: string[];
  summary: string;
  horizontalComparison?: string;
  conclusion?: string;
  topPicksRationale?: string;
};

const STORAGE_KEY = "stock_watchlist_rank_v2";

const STANCES: PortfolioStance[] = ["增持", "持有", "观望", "减仓", "调出"];

export function symbolsKey(symbols: string[]): string {
  return symbols
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .sort()
    .join(",");
}

export function extractReportSummary(reply: string): string {
  const m = reply.match(/##\s*分析结论\s*([\s\S]*?)(?=\n##\s|$)/);
  const chunk = (m ? m[1] : reply).trim();
  return chunk.slice(0, 1500);
}

export function extractStance(reply: string): PortfolioStance | null {
  const m = reply.match(/投资立场[：:]\s*(增持|持有|观望|减仓|调出)/);
  if (!m) return null;
  const v = m[1] as PortfolioStance;
  return STANCES.includes(v) ? v : null;
}

export function extractKeyRisk(reply: string): string | null {
  const m = reply.match(/主要风险[：:]\s*(.+?)(?:\n|$)/);
  if (!m) return null;
  const s = m[1].trim();
  return s ? s.slice(0, 200) : null;
}

function normalizeRankResult(data: WatchlistRankResult): WatchlistRankResult {
  return {
    ...data,
    agent: data.agent ?? "portfolio_curator",
    reduceOrExit: Array.isArray(data.reduceOrExit) ? data.reduceOrExit : [],
    portfolioRisks: Array.isArray(data.portfolioRisks) ? data.portfolioRisks : [],
    horizontalComparison: data.horizontalComparison ?? "",
    conclusion: data.conclusion ?? data.summary ?? "",
    topPicksRationale: data.topPicksRationale ?? "",
    ranked: (data.ranked ?? []).map((r) => ({
      ...r,
      stance: STANCES.includes(r.stance as PortfolioStance) ? r.stance : "持有",
      compareReason: r.compareReason ?? r.reason ?? "",
    })),
  };
}

export function hasActiveCuratorReport(currentSymbols: string[]): boolean {
  return getActiveWatchlistRank(currentSymbols) != null;
}

export function loadWatchlistRank(): WatchlistRankResult | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as WatchlistRankResult;
    if (!data || typeof data !== "object" || !Array.isArray(data.ranked)) return null;
    return normalizeRankResult(data);
  } catch {
    return null;
  }
}

export function saveWatchlistRank(result: WatchlistRankResult): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeRankResult(result)));
}

export function getActiveWatchlistRank(currentSymbols: string[]): WatchlistRankResult | null {
  const r = loadWatchlistRank();
  if (!r) return null;
  if (r.beijingDate !== beijingTodayDate()) return null;
  if (r.symbolsKey !== symbolsKey(currentSymbols)) return null;
  return r;
}

export function getRelativeScore(symbol: string, currentSymbols: string[]): number | null {
  const r = getActiveWatchlistRank(currentSymbols);
  if (!r) return null;
  const sym = symbol.trim().toUpperCase();
  const hit = r.ranked.find((x) => x.symbol.toUpperCase() === sym);
  return hit?.relativeScore ?? null;
}

export function getCuratorStance(
  symbol: string,
  currentSymbols: string[]
): PortfolioStance | null {
  const r = getActiveWatchlistRank(currentSymbols);
  if (!r) return null;
  const sym = symbol.trim().toUpperCase();
  const hit = r.ranked.find((x) => x.symbol.toUpperCase() === sym);
  return hit?.stance ?? null;
}

export function fmtBuyScore(n: number): string {
  return n.toFixed(1);
}

export function stanceBadgeClass(stance: PortfolioStance): string {
  switch (stance) {
    case "增持":
      return "stance-badge--up";
    case "减仓":
    case "调出":
      return "stance-badge--down";
    case "观望":
      return "stance-badge--wait";
    default:
      return "stance-badge--hold";
  }
}
