import { markdownToSafeHtml } from "./renderMarkdown";
import {
  beijingTodayDate,
  deleteAiReport,
  getTodayAiReport,
  isAnalyzedToday,
  loadAiReports,
  saveAiReport,
  type StockAiReport,
} from "./aiReports";
import {
  extractKeyRisk,
  extractReportSummary,
  extractStance,
  fmtBuyScore,
  getActiveWatchlistRank,
  getCuratorStance,
  getRelativeScore,
  hasActiveCuratorReport,
  saveWatchlistRank,
  stanceBadgeClass,
  symbolsKey,
  type WatchlistRankResult,
} from "./watchlistRank";
import { stockSearchSheetHtml, watchHeartBtnHtml, type SymbolSearchHit } from "./stockPage";
import {
  indexStripHtml,
  loadAppTab,
  loadViewSymbol,
  loadWatchlistSegment,
  saveAppTab,
  saveViewSymbol,
  saveWatchlistSegment,
  tabBarHtml,
} from "./appShell";
import type { DisplayPrefs, QuoteLinkTarget } from "./settings";
import { applyPrefsToDocument, DEFAULT_PREFS, loadPrefs, quoteDetailUrl, savePrefs } from "./settings";

type Quote = {
  symbol: string;
  name: string | null;
  lastPrice: number | null;
  previousClose: number | null;
  change: number | null;
  changePercent: number | null;
  currency: string | null;
  error: string | null;
};

const app = document.querySelector<HTMLDivElement>("#app")!;

let prefs: DisplayPrefs = loadPrefs();
applyPrefsToDocument(prefs);

let appTab = loadAppTab();
let watchListSegmentStr = loadWatchlistSegment();
let viewSymbol = loadViewSymbol();

type WatchSortKey = "buyScore" | "lastPrice" | "change" | "changePercent";
let watchSortKey: WatchSortKey | null = null;
/** 1 = 升序，-1 = 降序 */
let watchSortDir: 1 | -1 = -1;

type AiMsg = { role: "user" | "assistant"; content: string };

let aiMessages: AiMsg[] = [];
let aiLoading = false;
/** 与请求一并提交的标的（如从「问 AI」带入）；单独一条带状展示，不占第二输入框。 */
let aiThreadSymbol: string | null = null;
let aiConfigured: boolean | null = null;

let aiReports: Record<string, StockAiReport> = loadAiReports();
let aiAnalyzingSymbols = new Set<string>();
let aiReportSheetSymbol: string | null = null;

let stockSearchOpen = false;
let stockSearchLoading = false;
let stockSearchQuery = "";
let stockSearchResults: SymbolSearchHit[] = [];
let stockSearchTimer: ReturnType<typeof setTimeout> | null = null;
let stockSearchSeq = 0;
let stockSearchDelegated = false;

let watchlistMenuOpen = false;
let watchlistRankLoading = false;
let watchlistRank: WatchlistRankResult | null = null;
let curatorSheetOpen = false;

function isWatchlisted(symbol: string): boolean {
  const u = symbol.trim().toUpperCase();
  return symbols.some((s) => s.toUpperCase() === u);
}

function stockHeadTools(sym: string | null): string {
  if (!sym) return "";
  return watchHeartBtnHtml(sym, isWatchlisted(sym), esc);
}

const ICON_SEARCH =
  '<svg class="head-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 16l4.5 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

const ICON_REFRESH =
  '<svg class="head-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M20 4v5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const ICON_SETTINGS =
  '<svg class="head-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

function watchlistHeadTools(loading: boolean): string {
  return `<div class="page-head__tools">
    <button type="button" class="btn-head-icon btn-ai-pill--icon" data-app-tab="ai" title="AI 分析" aria-label="AI 分析">AI</button>
    <button type="button" class="btn-head-icon" id="btnWatchSearch" title="搜索" aria-label="搜索">${ICON_SEARCH}</button>
    <button type="button" class="btn-head-icon" id="btnWatchRefresh" title="刷新行情" aria-label="刷新行情"${
      loading ? " disabled" : ""
    }>${ICON_REFRESH}</button>
    <button type="button" class="btn-head-icon" id="btnWatchlistMenu" title="设置" aria-label="显示与自选设置">${ICON_SETTINGS}</button>
  </div>`;
}

function watchlistMenuSheetHtml(): string {
  if (!watchlistMenuOpen) return "";
  const themeLine =
    prefs.colorTheme === "dark" ? "切换为浅色（日间）" : "切换为深色（夜间护眼）";
  return (
    '<div class="watch-menu-backdrop" id="watchMenuBackdrop" aria-hidden="false"></div>' +
    '<aside class="watch-menu-sheet" id="watchMenuSheet" aria-label="显示与自选设置">' +
    '<div class="watch-menu-sheet__head">' +
    '<h2 class="watch-menu-sheet__title">显示与自选设置</h2>' +
    '<button type="button" class="watch-menu-sheet__close" id="watchMenuClose" title="关闭">×</button>' +
    "</div>" +
    '<div class="watch-menu-sheet__body">' +
    `<button type="button" class="watch-menu-item" data-watch-menu="theme">${esc(themeLine)}</button>` +
    '<button type="button" class="watch-menu-item" data-watch-menu="display">自选页样式…</button>' +
    '<button type="button" class="watch-menu-item" data-watch-menu="bulkAi">一键 AI 分析（当前列表）</button>' +
    '<button type="button" class="watch-menu-item" data-watch-menu="rankTop">组合优选 Agent（Top3）</button>' +
    "</div>" +
    "</aside>"
  );
}

function watchSegmentMarket(): "all" | "us" | "hk" {
  if (watchListSegmentStr === "m:us") return "us";
  if (watchListSegmentStr === "m:hk") return "hk";
  return "all";
}

function watchlistSymbolsForTab(base: string[]): string[] {
  if (watchSegmentMarket() === "hk") return [];
  return base;
}

function currentWatchDisplaySymbols(): string[] {
  return watchlistSymbolsForTab(symbols);
}

async function runBulkWatchlistAnalyze() {
  watchlistMenuOpen = false;
  const targets = currentWatchDisplaySymbols();
  if (targets.length === 0) {
    msg = watchSegmentMarket() === "hk" ? "港股列表暂无标的" : "暂无自选";
    render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
    return;
  }
  if (aiConfigured === false) {
    msg = "未配置大模型密钥，无法分析";
    render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
    return;
  }
  let newDone = 0;
  let skipped = 0;
  for (let idx = 0; idx < targets.length; idx++) {
    const raw = targets[idx];
    const sym = raw.trim().toUpperCase();
    msg = `批量分析（${idx + 1}/${targets.length}）…`;
    render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
    const cached = getTodayAiReport(sym);
    if (cached && isAnalyzedToday(cached)) {
      skipped++;
      continue;
    }
    if (aiAnalyzingSymbols.has(sym)) continue;
    aiAnalyzingSymbols.add(sym);
    msg = `正在分析 ${sym}（${idx + 1}/${targets.length}）…`;
    render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
    try {
      const res = await api<{
        symbol: string;
        reply: string;
        analyzedAt: string;
        buyScore: number | null;
        stance?: string | null;
        keyRisk?: string | null;
      }>(`/api/ai/analyze/${encodeURIComponent(sym)}`, { method: "POST" });
      const report: StockAiReport = {
        symbol: res.symbol,
        reply: res.reply,
        analyzedAt: res.analyzedAt,
        buyScore: res.buyScore,
        stance: res.stance ?? extractStance(res.reply),
        keyRisk: res.keyRisk ?? extractKeyRisk(res.reply),
      };
      aiReports[res.symbol.toUpperCase()] = report;
      saveAiReport(report);
      newDone++;
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
      aiAnalyzingSymbols.delete(sym);
      render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
      return;
    }
    aiAnalyzingSymbols.delete(sym);
    await new Promise((r) => setTimeout(r, 450));
  }
  msg = `批量完成：新分析 ${newDone} 只，跳过今日已有 ${skipped} 只`;
  render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
}

function currentRankSymbolList(): string[] {
  return currentWatchDisplaySymbols().map((s) => s.trim().toUpperCase());
}

function syncWatchlistRankCache(): void {
  watchlistRank = getActiveWatchlistRank(currentRankSymbolList());
}

function getDisplayBuyScore(symbol: string): { score: number; source: "relative" | "single" } | null {
  const sym = symbol.trim().toUpperCase();
  const rel = getRelativeScore(sym, currentRankSymbolList());
  if (rel != null) return { score: rel, source: "relative" };
  const report = getTodayAiReport(sym);
  if (report?.buyScore != null && !Number.isNaN(report.buyScore)) {
    return { score: report.buyScore, source: "single" };
  }
  return null;
}

async function runWatchlistRank(topK = 3) {
  watchlistMenuOpen = false;
  const targets = currentWatchDisplaySymbols();
  if (targets.length < 2) {
    msg = "组合优选至少需要 2 只自选";
    render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
    return;
  }
  if (aiConfigured === false) {
    msg = "未配置大模型密钥，无法优选";
    render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
    return;
  }
  const reports: {
    symbol: string;
    singleBuyScore: number | null;
    stance: string | null;
    keyRisk: string | null;
    summary: string;
  }[] = [];
  const missing: string[] = [];
  for (const raw of targets) {
    const sym = raw.trim().toUpperCase();
    const report = getTodayAiReport(sym);
    if (!report) {
      missing.push(sym);
      continue;
    }
    reports.push({
      symbol: sym,
      singleBuyScore: report.buyScore,
      stance: report.stance ?? extractStance(report.reply),
      keyRisk: report.keyRisk ?? extractKeyRisk(report.reply),
      summary: extractReportSummary(report.reply),
    });
  }
  if (missing.length > 0) {
    msg = `请先由 Analyst Agent 完成今日单股分析：${missing.join(", ")}`;
    render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
    return;
  }
  watchlistRankLoading = true;
  curatorSheetOpen = false;
  msg = "组合优选 Agent 分析中…";
  render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
  try {
    const res = await api<{
      agent?: string;
      rankedAt: string;
      topK: number;
      symbols: string[];
      ranked: {
        symbol: string;
        rank: number;
        relativeScore: number;
        stance: string;
        reason: string;
      }[];
      topPicks: string[];
      horizontalComparison?: string;
      conclusion?: string;
      topPicksRationale?: string;
      reduceOrExit: { symbol: string; action: string; reason: string }[];
      portfolioRisks: string[];
      summary: string;
    }>("/api/ai/watchlist/rank", {
      method: "POST",
      body: JSON.stringify({ symbols: targets, topK, reports }),
    });
    const key = symbolsKey(res.symbols);
    watchlistRank = {
      agent: "portfolio_curator",
      rankedAt: res.rankedAt,
      beijingDate: beijingTodayDate(),
      topK: res.topK,
      symbolsKey: key,
      ranked: res.ranked.map((r) => ({
        symbol: r.symbol,
        rank: r.rank,
        relativeScore: r.relativeScore,
        stance: (["增持", "持有", "观望", "减仓", "调出"] as const).includes(
          r.stance as "增持"
        )
          ? (r.stance as WatchlistRankResult["ranked"][0]["stance"])
          : "持有",
        reason: r.reason,
        compareReason:
          (r as { compareReason?: string }).compareReason ?? r.reason ?? "",
      })),
      topPicks: res.topPicks,
      horizontalComparison: res.horizontalComparison ?? "",
      conclusion: res.conclusion ?? res.summary ?? "",
      topPicksRationale: res.topPicksRationale ?? "",
      reduceOrExit: (res.reduceOrExit ?? []).map((x) => ({
        symbol: x.symbol,
        action: (["减仓", "调出", "观望"] as const).includes(x.action as "减仓")
          ? (x.action as "减仓" | "调出" | "观望")
          : "观望",
        reason: x.reason,
      })),
      portfolioRisks: res.portfolioRisks ?? [],
      summary: res.summary,
    };
    saveWatchlistRank(watchlistRank);
    watchSortKey = "buyScore";
    watchSortDir = -1;
    curatorSheetOpen = false;
    msg = `优选完成，点「查看」阅读横向对比报告 · Top${res.topK} ${res.topPicks.join("、")}`;
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  } finally {
    watchlistRankLoading = false;
    render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
  }
}

function curatorCurateHeadHtml(): string {
  syncWatchlistRankCache();
  const syms = currentRankSymbolList();
  if (syms.length < 2) return "";
  if (watchlistRankLoading) {
    return `<span class="watch-list__curator-status">优选中…</span>`;
  }
  if (hasActiveCuratorReport(syms)) {
    return `<button type="button" class="btn-ai-chip" data-curator-view title="查看今日组合优选报告">查看</button>`;
  }
  return `<button type="button" class="btn-ai-chip btn-ai-chip--primary watch-list__rank-btn" data-watch-rank title="运行组合优选 Agent">优选</button>`;
}

function openCuratorSheet() {
  if (!hasActiveCuratorReport(currentRankSymbolList())) return;
  syncWatchlistRankCache();
  curatorSheetOpen = true;
  render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
}

function watchlistRankBannerHtml(displaySyms: string[]): string {
  syncWatchlistRankCache();
  const rank = watchlistRank;
  if (!rank || displaySyms.length < 2) return "";
  const topLine = rank.topPicks
    .map((sym) => {
      const hit = rank.ranked.find((r) => r.symbol === sym);
      return hit ? `${sym} ${fmtBuyScore(hit.relativeScore)}` : sym;
    })
    .join(" · ");
  return `<p class="watch-rank-hint">今日优选 Top${rank.topK}：<strong>${esc(topLine)}</strong> · 评分列点<strong>查看</strong>阅读横向对比与结论</p>`;
}

function portfolioCuratorSheetHtml(): string {
  if (!curatorSheetOpen || !watchlistRank) return "";
  const rank = watchlistRank;
  const priorityRows = [...rank.ranked]
    .sort((a, b) => a.rank - b.rank)
    .map(
      (r) =>
        `<tr><td class="curator-td-rank">${r.rank}</td><td><strong>${esc(r.symbol)}</strong></td><td class="num">${fmtBuyScore(r.relativeScore)}</td><td><span class="stance-badge ${stanceBadgeClass(r.stance)}">${esc(r.stance)}</span></td><td class="curator-td-compare">${esc(r.compareReason || r.reason)}</td></tr>`
    )
    .join("");
  const reduceBlock =
    rank.reduceOrExit.length > 0
      ? `<h3 class="curator-sheet__sub">减仓 / 调出 / 观望下调</h3><ul class="curator-reduce-list">${rank.reduceOrExit
          .map(
            (x) =>
              `<li><strong>${esc(x.symbol)}</strong> <span class="reduce-tag">${esc(x.action)}</span> — ${esc(x.reason)}</li>`
          )
          .join("")}</ul>`
      : `<p class="curator-sheet__muted">暂无明确减仓或调出建议。</p>`;
  const risksBlock =
    rank.portfolioRisks.length > 0
      ? `<ul class="curator-risk-list">${rank.portfolioRisks.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`
      : `<p class="curator-sheet__muted">未列出额外组合风险。</p>`;
  const horizontalBlock = rank.horizontalComparison
    ? `<h3 class="curator-sheet__sub">横向对比分析</h3><div class="curator-prose">${markdownToSafeHtml(rank.horizontalComparison)}</div>`
    : "";
  const conclusionBlock = rank.conclusion
    ? `<h3 class="curator-sheet__sub">综合结论</h3><div class="curator-prose">${markdownToSafeHtml(rank.conclusion)}</div>`
    : `<p class="curator-sheet__summary">${esc(rank.summary)}</p>`;
  const topRationaleBlock = rank.topPicksRationale
    ? `<h3 class="curator-sheet__sub">Top${rank.topK} 优选理由</h3><p class="curator-prose-plain">${esc(rank.topPicksRationale)}</p>`
    : "";
  return `
  <div class="curator-backdrop" id="curatorBackdrop" aria-hidden="false"></div>
  <aside class="curator-sheet" id="curatorSheet" aria-label="组合优选 Agent 报告">
    <div class="curator-sheet__head">
      <div>
        <h2 class="curator-sheet__title">组合优选 Agent</h2>
        <p class="curator-sheet__time">${esc(rank.rankedAt)} · Top${rank.topK}：${rank.topPicks.map(esc).join("、")}</p>
      </div>
      <button type="button" class="curator-sheet__close" id="curatorClose" title="关闭">×</button>
    </div>
    <div class="curator-sheet__body">
      ${horizontalBlock}
      ${conclusionBlock}
      ${topRationaleBlock}
      <h3 class="curator-sheet__sub">购买优先级（全池）</h3>
      <div class="curator-table-wrap">
        <table class="curator-table">
          <thead><tr><th>#</th><th>代码</th><th>相对分</th><th>立场</th><th>横向对比理由</th></tr></thead>
          <tbody>${priorityRows}</tbody>
        </table>
      </div>
      ${reduceBlock}
      <h3 class="curator-sheet__sub">组合风险</h3>
      ${risksBlock}
    </div>
    <div class="curator-sheet__foot">
      <button type="button" class="btn-ghost" id="btnCuratorRerun" ${watchlistRankLoading ? "disabled" : ""}>重新优选</button>
      <span class="curator-sheet__disclaimer">由大模型生成，不构成投资建议。</span>
    </div>
  </aside>`;
}

function closeCuratorSheet() {
  curatorSheetOpen = false;
  render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
}

function buyScoreCellHtml(symbol: string, report: StockAiReport | null, analyzing: boolean): string {
  const sym = esc(symbol);
  if (analyzing) {
    return `<span class="ai-score ai-score--loading" aria-label="分析中">…</span>`;
  }
  const display = getDisplayBuyScore(symbol);
  if (!display) {
    if (report) {
      return `<button type="button" class="ai-score ai-score--empty" data-ai-view="${sym}" title="查看今日报告">—</button>`;
    }
    return `<span class="ai-score ai-score--empty">—</span>`;
  }
  const s = display.score;
  const tier = s >= 8 ? "high" : s >= 5 ? "mid" : "low";
  const label = display.source === "relative" ? "组合相对分" : "单股分";
  const txt = fmtBuyScore(s);
  const curatorStance = getCuratorStance(symbol, currentRankSymbolList());
  const stanceHtml = curatorStance
    ? `<span class="stance-badge stance-badge--sm ${stanceBadgeClass(curatorStance)}">${esc(curatorStance)}</span>`
    : "";
  return `<span class="ai-score-wrap">${stanceHtml}<button type="button" class="ai-score ai-score--${tier}${display.source === "relative" ? " ai-score--relative" : ""}" data-ai-view="${sym}" title="${label} ${txt}/10">${txt}</button></span>`;
}

function aiReportCellHtml(symbol: string, report: StockAiReport | null, analyzing: boolean): string {
  const sym = esc(symbol);
  if (analyzing) {
    return `<span class="ai-row-status">分析中…</span>`;
  }
  if (report) {
    return `<button type="button" class="btn-ai-chip" data-ai-view="${sym}" title="查看今日分析报告">查看</button>`;
  }
  return `<button type="button" class="btn-ai-chip btn-ai-chip--primary" data-ai-analyze="${sym}" title="今日未分析，点击生成">AI</button>`;
}

function aiReportSheetHtml(): string {
  if (!aiReportSheetSymbol) return "";
  const sym = aiReportSheetSymbol.toUpperCase();
  const report = getTodayAiReport(sym) ?? aiReports[sym] ?? null;
  if (!report) return "";
  const today = isAnalyzedToday(report);
  const display = getDisplayBuyScore(sym);
  const scoreBadge =
    display != null
      ? `<span class="ai-report-sheet__score ai-report-sheet__score--${
          display.score >= 8 ? "high" : display.score >= 5 ? "mid" : "low"
        }">${display.source === "relative" ? "组合相对分" : "买入评分"} ${fmtBuyScore(display.score)}/10</span>`
      : report.buyScore != null
        ? `<span class="ai-report-sheet__score ai-report-sheet__score--${
            report.buyScore >= 8 ? "high" : report.buyScore >= 5 ? "mid" : "low"
          }">买入评分 ${fmtBuyScore(report.buyScore)}/10</span>`
        : "";
  const footBtn = today
    ? `<span class="ai-report-sheet__hint">今日已分析，刷新页面无需重复生成</span>
      <button type="button" class="btn-ghost" data-ai-reanalyze="${esc(sym)}">仍要重新分析</button>`
    : `<button type="button" class="btn-ghost" data-ai-reanalyze="${esc(sym)}">重新分析（昨日及更早需更新）</button>`;
  return `
  <div class="ai-report-backdrop" id="aiReportBackdrop" aria-hidden="false"></div>
  <aside class="ai-report-sheet" id="aiReportSheet" aria-label="${esc(sym)} AI 分析报告">
    <div class="ai-report-sheet__head">
      <div>
        <h2 class="ai-report-sheet__title">${esc(sym)}</h2>
        <p class="ai-report-sheet__time">生成时间：${esc(report.analyzedAt)}</p>
      </div>
      <button type="button" class="ai-report-sheet__close" id="aiReportClose" title="关闭">×</button>
    </div>
    ${scoreBadge}
    <div class="ai-report-sheet__body ai-md">${markdownToSafeHtml(report.reply)}</div>
    <div class="ai-report-sheet__foot">
      ${footBtn}
    </div>
  </aside>`;
}

async function runWatchlistAnalyze(symbol: string, openSheet: boolean, force = false) {
  const sym = symbol.trim().toUpperCase();
  if (!sym || aiAnalyzingSymbols.has(sym)) return;
  const cached = getTodayAiReport(sym);
  if (!force && cached) {
    if (openSheet) aiReportSheetSymbol = sym;
    msg = `${sym} 今日已有分析`;
    render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
    return;
  }
  if (aiConfigured === false) {
    msg = "未配置大模型密钥，无法分析";
    render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
    return;
  }
  aiAnalyzingSymbols.add(sym);
  msg = "";
  render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
  try {
    const res = await api<{
      symbol: string;
      reply: string;
      analyzedAt: string;
      buyScore: number | null;
      stance?: string | null;
      keyRisk?: string | null;
    }>(`/api/ai/analyze/${encodeURIComponent(sym)}`, { method: "POST" });
    const report: StockAiReport = {
      symbol: res.symbol,
      reply: res.reply,
      analyzedAt: res.analyzedAt,
      buyScore: res.buyScore,
      stance: res.stance ?? extractStance(res.reply),
      keyRisk: res.keyRisk ?? extractKeyRisk(res.reply),
    };
    aiReports[res.symbol.toUpperCase()] = report;
    saveAiReport(report);
    if (openSheet) aiReportSheetSymbol = res.symbol.toUpperCase();
    msg = `${res.symbol} 分析完成`;
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  } finally {
    aiAnalyzingSymbols.delete(sym);
    render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
  }
}

function closeAiReportSheet() {
  aiReportSheetSymbol = null;
  render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
}

function openStockSearch() {
  stockSearchOpen = true;
  stockSearchQuery = "";
  stockSearchResults = [];
  stockSearchLoading = false;
  stockSearchSeq += 1;
  render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
}

function closeStockSearch() {
  stockSearchOpen = false;
  stockSearchQuery = "";
  stockSearchResults = [];
  stockSearchLoading = false;
  stockSearchSeq += 1;
  if (stockSearchTimer) {
    clearTimeout(stockSearchTimer);
    stockSearchTimer = null;
  }
  render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
}

async function runStockSearch(query: string) {
  const q = query.trim();
  stockSearchQuery = query;
  const seq = ++stockSearchSeq;
  if (!q) {
    stockSearchResults = [];
    stockSearchLoading = false;
    render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
    return;
  }
  stockSearchLoading = true;
  render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
  try {
    const res = await api<{ results: SymbolSearchHit[] }>(
      `/api/symbols/search?q=${encodeURIComponent(q)}`
    );
    if (seq !== stockSearchSeq) return;
    stockSearchResults = res.results ?? [];
  } catch {
    if (seq !== stockSearchSeq) return;
    stockSearchResults = [];
  } finally {
    if (seq !== stockSearchSeq) return;
    stockSearchLoading = false;
    render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
  }
}

async function refreshQuotesOnly() {
  try {
    const q = await api<{ quotes: Quote[] }>("/api/quotes");
    quotes = q.quotes;
  } catch {
    /* 静默失败，下次全量刷新会纠正 */
  }
}

async function toggleWatchlist(symbol: string) {
  const sym = symbol.trim().toUpperCase();
  if (!sym) return;
  const wasIn = isWatchlisted(sym);
  try {
    if (wasIn) {
      await api(`/api/watchlist/symbol/${encodeURIComponent(sym)}`, { method: "DELETE" });
      symbols = symbols.filter((s) => s.toUpperCase() !== sym);
      deleteAiReport(sym);
      delete aiReports[sym];
      if (aiReportSheetSymbol === sym) aiReportSheetSymbol = null;
      msg = `已移出 ${sym}`;
    } else {
      const res = await api<{ symbols: string[] }>("/api/watchlist/symbol", {
        method: "POST",
        body: JSON.stringify({ symbol: sym }),
      });
      symbols = res.symbols;
      msg = `已加入 ${sym}`;
      void refreshQuotesOnly().then(() =>
        render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider })
      );
    }
    render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
    render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
  }
}

function ensureStockSearchDelegation() {
  if (stockSearchDelegated) return;
  stockSearchDelegated = true;
  app.addEventListener("input", (ev) => {
    const t = ev.target as HTMLElement;
    if (t.id !== "stockSearchInput") return;
    stockSearchQuery = (t as HTMLInputElement).value;
    if (stockSearchTimer) clearTimeout(stockSearchTimer);
    stockSearchTimer = setTimeout(() => void runStockSearch(stockSearchQuery), 300);
  });
}

function bindStockSearchInput() {
  if (!stockSearchOpen) return;
  const input = app.querySelector<HTMLInputElement>("#stockSearchInput");
  if (!input) return;
  input.focus();
  const len = input.value.length;
  input.setSelectionRange(len, len);
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toFixed(digits);
}

function symLinkHtml(symbol: string): string {
  const symNorm = symbol.trim().toUpperCase();
  const symEsc = esc(symbol);
  if (prefs.quoteLinkNewTab) {
    const href = quoteDetailUrl(symNorm, prefs.quoteLinkTarget);
    return `<a class="sym-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="新标签打开行情（不经过个股页）">${symEsc}</a>`;
  }
  const enc = encodeURIComponent(symNorm);
  return `<button type="button" class="sym-link sym-link--btn" data-open-stock="${enc}" title="在「个股」页内嵌打开行情，底栏保留，点「自选」返回">${symEsc}</button>`;
}

function clsForChange(change: number | null): string {
  if (change === null || change === undefined || Number.isNaN(change)) return "flat";
  if (change > 0) return "up";
  if (change < 0) return "down";
  return "flat";
}

function clsForPrice(q: Quote): string {
  if (q.error) return "flat";
  if (q.lastPrice === null || q.lastPrice === undefined || Number.isNaN(q.lastPrice)) return "flat";
  return clsForChange(q.change);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = (await res.json()) as { detail?: unknown };
      if (j.detail !== undefined) detail = String(j.detail);
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

function readPrefsFromForm(): DisplayPrefs {
  const form = document.getElementById("settingsForm") as HTMLFormElement | null;
  if (!form) return prefs;
  const fd = new FormData(form);
  const cs = fd.get("colorScheme");
  const colorScheme =
    cs === "us" || cs === "pink_up" || cs === "pink_dn" || cs === "cn" ? cs : DEFAULT_PREFS.colorScheme;
  const nf = fd.get("nameOrder");
  const ql = fd.get("quoteLink");
  const quoteLinkTarget: QuoteLinkTarget =
    ql === "yahoo" || ql === "eastmoney" || ql === "google" ? ql : DEFAULT_PREFS.quoteLinkTarget;
  return {
    ...prefs,
    colorScheme,
    nameFirst: nf !== "codeFirst",
    compact: fd.get("compact") === "on",
    showUsBadge: fd.get("usBadge") === "on",
    swapChgPctColumns: fd.get("swapChgPct") === "on",
    quoteLinkTarget,
    quoteLinkNewTab: fd.get("quoteLinkNewTab") === "on",
  };
}

function openDisplaySettingsSheet() {
  document.getElementById("settingsSheet")?.classList.add("open");
  document.getElementById("settingsBackdrop")?.classList.add("open");
}

function bindSettingsUi() {
  const sheet = document.getElementById("settingsSheet");
  const backdrop = document.getElementById("settingsBackdrop");
  const btnClose = document.getElementById("settingsClose");
  const btnSave = document.getElementById("settingsSave");
  const btnReset = document.getElementById("settingsReset");

  const close = () => {
    sheet?.classList.remove("open");
    backdrop?.classList.remove("open");
  };
  backdrop?.addEventListener("click", () => close());
  btnClose?.addEventListener("click", () => close());
  btnSave?.addEventListener("click", () => {
    prefs = readPrefsFromForm();
    savePrefs(prefs);
    applyPrefsToDocument(prefs);
    close();
    render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
  });
  btnReset?.addEventListener("click", () => {
    prefs = { ...DEFAULT_PREFS };
    savePrefs(prefs);
    applyPrefsToDocument(prefs);
    close();
    render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
  });

  const form = document.getElementById("settingsForm");
  form?.addEventListener("submit", (e) => e.preventDefault());
}

let shellNavBound = false;

function ensureShellNavigation() {
  if (shellNavBound) return;
  shellNavBound = true;
  app.addEventListener("click", (ev) => {
    const heartEl = (ev.target as HTMLElement).closest("[data-toggle-watch]");
    if (heartEl instanceof HTMLElement && heartEl.dataset.toggleWatch) {
      ev.preventDefault();
      ev.stopPropagation();
      void toggleWatchlist(heartEl.dataset.toggleWatch);
      return;
    }
    const openEl = (ev.target as HTMLElement).closest("[data-open-stock]");
    if (openEl instanceof HTMLElement && openEl.dataset.openStock) {
      ev.preventDefault();
      const raw = decodeURIComponent(openEl.dataset.openStock).trim().toUpperCase();
      if (!/^[A-Z0-9.\-]{1,12}$/.test(raw)) return;
      saveViewSymbol(raw);
      viewSymbol = raw;
      stockSearchOpen = false;
      stockSearchQuery = "";
      stockSearchResults = [];
      saveAppTab("stock");
      appTab = "stock";
      render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
      return;
    }
    const askAi = (ev.target as HTMLElement).closest("[data-ask-ai]");
    if (askAi instanceof HTMLElement && askAi.dataset.askAi) {
      const raw = askAi.dataset.askAi.trim().toUpperCase();
      if (!/^[A-Z0-9.\-]{1,12}$/.test(raw)) return;
      aiThreadSymbol = raw;
      saveAppTab("ai");
      appTab = "ai";
      render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
      return;
    }
    if ((ev.target as HTMLElement).closest("#aiClearSymbol")) {
      ev.preventDefault();
      aiThreadSymbol = null;
      render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
      return;
    }
    if ((ev.target as HTMLElement).closest("#aiSend")) {
      ev.preventDefault();
      void submitAiChat();
      return;
    }
    if ((ev.target as HTMLElement).closest("#aiClear")) {
      ev.preventDefault();
      aiMessages = [];
      aiThreadSymbol = null;
      render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
      return;
    }
    const analyzeEl = (ev.target as HTMLElement).closest("[data-ai-analyze]");
    if (analyzeEl instanceof HTMLElement && analyzeEl.dataset.aiAnalyze) {
      ev.preventDefault();
      void runWatchlistAnalyze(analyzeEl.dataset.aiAnalyze, true);
      return;
    }
    const reanalyzeEl = (ev.target as HTMLElement).closest("[data-ai-reanalyze]");
    if (reanalyzeEl instanceof HTMLElement && reanalyzeEl.dataset.aiReanalyze) {
      ev.preventDefault();
      void runWatchlistAnalyze(reanalyzeEl.dataset.aiReanalyze, true, true);
      return;
    }
    const viewEl = (ev.target as HTMLElement).closest("[data-ai-view]");
    if (viewEl instanceof HTMLElement && viewEl.dataset.aiView) {
      ev.preventDefault();
      aiReportSheetSymbol = viewEl.dataset.aiView.trim().toUpperCase();
      render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
      return;
    }
    if (
      (ev.target as HTMLElement).closest("#aiReportClose") ||
      (ev.target as HTMLElement).closest("#aiReportBackdrop")
    ) {
      ev.preventDefault();
      closeAiReportSheet();
      return;
    }
    if ((ev.target as HTMLElement).closest("#btnWatchSearch")) {
      ev.preventDefault();
      openStockSearch();
      return;
    }
    if ((ev.target as HTMLElement).closest("#btnWatchRefresh")) {
      ev.preventDefault();
      void loadAll();
      return;
    }
    if ((ev.target as HTMLElement).closest("#btnWatchlistMenu")) {
      ev.preventDefault();
      watchlistMenuOpen = true;
      render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
      return;
    }
    if (
      (ev.target as HTMLElement).closest("#watchMenuClose") ||
      (ev.target as HTMLElement).closest("#watchMenuBackdrop")
    ) {
      ev.preventDefault();
      watchlistMenuOpen = false;
      render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
      return;
    }
    const menuEl = (ev.target as HTMLElement).closest("[data-watch-menu]");
    if (menuEl instanceof HTMLElement && menuEl.dataset.watchMenu) {
      ev.preventDefault();
      const a = menuEl.dataset.watchMenu;
      if (a === "theme") {
        prefs = { ...prefs, colorTheme: prefs.colorTheme === "dark" ? "light" : "dark" };
        savePrefs(prefs);
        applyPrefsToDocument(prefs);
        render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
        return;
      }
      if (a === "display") {
        watchlistMenuOpen = false;
        render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
        openDisplaySettingsSheet();
        return;
      }
      if (a === "bulkAi") {
        void runBulkWatchlistAnalyze();
        return;
      }
      if (a === "rankTop") {
        void runWatchlistRank(3);
        return;
      }
    }
    if (
      (ev.target as HTMLElement).closest("#btnWatchRank") ||
      (ev.target as HTMLElement).closest("[data-watch-rank]") ||
      (ev.target as HTMLElement).closest("#btnCuratorRerun")
    ) {
      ev.preventDefault();
      void runWatchlistRank(3);
      return;
    }
    if ((ev.target as HTMLElement).closest("[data-curator-view]")) {
      ev.preventDefault();
      openCuratorSheet();
      return;
    }
    if (
      (ev.target as HTMLElement).closest("#curatorClose") ||
      (ev.target as HTMLElement).closest("#curatorBackdrop")
    ) {
      ev.preventDefault();
      closeCuratorSheet();
      return;
    }
    if ((ev.target as HTMLElement).closest("[data-watch-bulk-ai]")) {
      ev.preventDefault();
      void runBulkWatchlistAnalyze();
      return;
    }
    const segEl = (ev.target as HTMLElement).closest("[data-watch-segment]");
    if (segEl instanceof HTMLElement && segEl.dataset.watchSegment) {
      ev.preventDefault();
      watchListSegmentStr = segEl.dataset.watchSegment;
      saveWatchlistSegment(watchListSegmentStr);
      render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
      return;
    }
    if (
      (ev.target as HTMLElement).closest("#stockSearchClose") ||
      (ev.target as HTMLElement).closest("#stockSearchBackdrop")
    ) {
      ev.preventDefault();
      closeStockSearch();
      return;
    }
    const sortEl = (ev.target as HTMLElement).closest("[data-watch-sort]");
    if (sortEl instanceof HTMLElement && sortEl.dataset.watchSort) {
      const raw = sortEl.dataset.watchSort;
      if (
        raw === "buyScore" ||
        raw === "lastPrice" ||
        raw === "change" ||
        raw === "changePercent"
      ) {
        ev.preventDefault();
        ev.stopPropagation();
        if (watchSortKey === raw) {
          watchSortDir = watchSortDir === 1 ? -1 : 1;
        } else {
          watchSortKey = raw;
          watchSortDir = -1;
        }
        render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
        return;
      }
    }
    const tabEl = (ev.target as HTMLElement).closest("[data-app-tab]");
    if (tabEl instanceof HTMLElement && tabEl.dataset.appTab) {
      const t = tabEl.dataset.appTab;
      if (t === "watchlist" || t === "stock" || t === "ai") {
        saveAppTab(t);
        appTab = t;
        render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
        if (t === "watchlist") {
          void refreshQuotesOnly().then(() =>
            render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider })
          );
        }
      }
      return;
    }
  });
}

let aiKbBound = false;

function ensureAiKeyboard() {
  if (aiKbBound) return;
  aiKbBound = true;
  app.addEventListener("input", (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLTextAreaElement) || t.id !== "aiInput") return;
    if (appTab !== "ai") return;
    t.style.height = "auto";
    t.style.height = `${Math.min(Math.max(t.scrollHeight, 46), 160)}px`;
  });
  app.addEventListener("keydown", (ev) => {
    const el = ev.target as HTMLElement | null;
    if (!el || el.id !== "aiInput") return;
    if (appTab !== "ai") return;
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      void submitAiChat();
      return;
    }
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      void submitAiChat();
    }
  });
}

function settingsPanelHtml(): string {
  const p = prefs;
  return `
  <div class="settings-backdrop" id="settingsBackdrop" aria-hidden="true"></div>
  <aside class="settings-sheet" id="settingsSheet" aria-label="显示设置">
    <div class="settings-head">
      <span class="settings-title">自选页样式</span>
      <button type="button" class="settings-close" id="settingsClose" title="关闭">×</button>
    </div>
    <form class="settings-form" id="settingsForm">
      <fieldset class="settings-fieldset">
        <legend>涨跌颜色</legend>
        <div class="settings-grid4">
          <label class="settings-card"><input type="radio" name="colorScheme" value="cn" ${p.colorScheme === "cn" ? "checked" : ""}/><span>红涨绿跌</span></label>
          <label class="settings-card"><input type="radio" name="colorScheme" value="us" ${p.colorScheme === "us" ? "checked" : ""}/><span>绿涨红跌</span></label>
          <label class="settings-card"><input type="radio" name="colorScheme" value="pink_up" ${p.colorScheme === "pink_up" ? "checked" : ""}/><span>粉涨绿跌</span></label>
          <label class="settings-card"><input type="radio" name="colorScheme" value="pink_dn" ${p.colorScheme === "pink_dn" ? "checked" : ""}/><span>绿涨粉跌</span></label>
        </div>
      </fieldset>
      <fieldset class="settings-fieldset">
        <legend>名称 / 代码顺序</legend>
        <div class="settings-row2">
          <label class="settings-card"><input type="radio" name="nameOrder" value="nameFirst" ${p.nameFirst ? "checked" : ""}/><span>名称在上</span></label>
          <label class="settings-card"><input type="radio" name="nameOrder" value="codeFirst" ${!p.nameFirst ? "checked" : ""}/><span>代码在上</span></label>
        </div>
      </fieldset>
      <fieldset class="settings-fieldset">
        <legend>列表与列</legend>
        <label class="settings-check"><input type="checkbox" name="compact" ${p.compact ? "checked" : ""}/> 紧凑行高（类似列表更密）</label>
        <label class="settings-check"><input type="checkbox" name="usBadge" ${p.showUsBadge ? "checked" : ""}/> 显示「US」市场角标</label>
        <label class="settings-check"><input type="checkbox" name="swapChgPct" ${p.swapChgPctColumns ? "checked" : ""}/> 涨跌额与涨跌幅列互换（类似富途列表模式 B）</label>
      </fieldset>
      <fieldset class="settings-fieldset">
        <legend>点击代码与个股页</legend>
        <p class="settings-hint">默认在底栏<strong>「个股」</strong>页内嵌打开行情（底栏不消失，点<strong>自选</strong>返回列表）。若勾选下方，则点击代码改为<strong>仅新标签</strong>打开外链、不进入个股页。</p>
        <div class="settings-grid3">
          <label class="settings-card"><input type="radio" name="quoteLink" value="yahoo" ${p.quoteLinkTarget === "yahoo" ? "checked" : ""}/><span>Yahoo 财经</span></label>
          <label class="settings-card"><input type="radio" name="quoteLink" value="eastmoney" ${p.quoteLinkTarget === "eastmoney" ? "checked" : ""}/><span>东方财富</span></label>
          <label class="settings-card"><input type="radio" name="quoteLink" value="google" ${p.quoteLinkTarget === "google" ? "checked" : ""}/><span>Google 财经</span></label>
        </div>
        <label class="settings-check settings-check-tight"><input type="checkbox" name="quoteLinkNewTab" ${p.quoteLinkNewTab ? "checked" : ""}/> 点击代码仅用<strong>新标签</strong>打开外链（不进入个股内嵌页）</label>
      </fieldset>
      <div class="settings-actions">
        <button type="button" class="primary" id="settingsSave">保存并应用</button>
        <button type="button" id="settingsReset">恢复默认</button>
      </div>
      <p class="settings-note">设置保存在本机浏览器 localStorage，换设备需重新配置。</p>
    </form>
  </aside>`;
}

async function submitAiChat() {
  const ta = app.querySelector<HTMLTextAreaElement>("#aiInput");
  if (!ta || aiLoading) return;
  const message = ta.value.trim();
  if (!message) return;
  const symbolPayload = aiThreadSymbol ? aiThreadSymbol.toUpperCase() : null;
  aiLoading = true;
  aiMessages.push({ role: "user", content: message });
  ta.value = "";
  render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
  try {
    const res = await api<{ reply: string }>("/api/ai/chat", {
      method: "POST",
      body: JSON.stringify({ message, symbol: symbolPayload }),
    });
    aiMessages.push({ role: "assistant", content: res.reply });
  } catch (e) {
    const errText = e instanceof Error ? e.message : String(e);
    aiMessages.push({
      role: "assistant",
      content: "## 请求失败\n\n> " + errText.replace(/\n/g, "\n> "),
    });
  } finally {
    aiLoading = false;
    render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
  }
}

function bindAiPanel() {
  const th = app.querySelector<HTMLElement>("#aiThread");
  if (th) th.scrollTop = th.scrollHeight;
  const ta = app.querySelector<HTMLTextAreaElement>("#aiInput");
  if (ta) {
    ta.focus();
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

function mergeWatchQuotes(symbols: string[], quotes: Quote[]): Quote[] {
  const map = new Map(quotes.map((q) => [q.symbol.trim().toUpperCase(), q]));
  return symbols.map((raw) => {
    const sym = raw.trim().toUpperCase();
    const hit = map.get(sym);
    if (hit) return hit;
    return {
      symbol: sym,
      name: null,
      lastPrice: null,
      previousClose: null,
      change: null,
      changePercent: null,
      currency: null,
      error: null,
    };
  });
}

function watchSortNum(q: Quote, key: WatchSortKey): number | null {
  const sym = q.symbol.trim().toUpperCase();
  switch (key) {
    case "buyScore": {
      if (aiAnalyzingSymbols.has(sym)) return null;
      const d = getDisplayBuyScore(sym);
      if (d == null || Number.isNaN(d.score)) return null;
      return d.score;
    }
    case "lastPrice":
      if (q.lastPrice == null || Number.isNaN(q.lastPrice)) return null;
      return q.lastPrice;
    case "change":
      if (q.change == null || Number.isNaN(q.change)) return null;
      return q.change;
    case "changePercent":
      if (q.changePercent == null || Number.isNaN(q.changePercent)) return null;
      return q.changePercent;
    default:
      return null;
  }
}

function watchSortOrdered(rows: Quote[]): Quote[] {
  if (!watchSortKey || rows.length === 0) return rows;
  const k = watchSortKey;
  const d = watchSortDir;
  return [...rows].sort((a, b) => {
    const na = watchSortNum(a, k);
    const nb = watchSortNum(b, k);
    const aMiss = na == null;
    const bMiss = nb == null;
    if (aMiss && bMiss) return 0;
    if (aMiss) return 1;
    if (bMiss) return -1;
    return (na - nb) * d;
  });
}

function render(state: {
  symbols: string[];
  quotes: Quote[];
  loading: boolean;
  msg: string;
  finnhubConfigured: boolean | null;
  quoteProvider: string | null;
}) {
  const showYahooHint =
    state.finnhubConfigured === false && state.quoteProvider === "yahoo_yfinance";
  const banner = showYahooHint
    ? `<div class="banner-warn">
  <strong>当前为 Yahoo 行情源</strong>：未配置 <code>FINNHUB_API_KEY</code> 且 <code>QUOTE_PROVIDER=yahoo</code>，在国内网络下常失败。
  建议在 <code>backend/.env</code> 中改为 <code>QUOTE_PROVIDER=eastmoney</code>（东方财富，境内更稳）或配置 Finnhub 密钥，然后<strong>重启 uvicorn</strong>。
</div>`
    : "";

  const badgeHtml = prefs.showUsBadge ? `<span class="mkt-badge">US</span>` : "";
  const hkList = watchSegmentMarket() === "hk";
  const displaySyms = watchlistSymbolsForTab(state.symbols);
  const quotesForRows = mergeWatchQuotes(displaySyms, state.quotes);

  const watchGridCols = prefs.swapChgPctColumns
    ? "minmax(0,1fr) 4.6rem 4.2rem 5.75rem 6.5rem 5.5rem"
    : "minmax(0,1fr) 4.6rem 4.2rem 5.75rem 5.5rem 6.5rem";

  const sortThCls = (key: WatchSortKey) => {
    const base = "watch-list__sort";
    if (watchSortKey !== key) return base;
    return `${base} is-active is-${watchSortDir === 1 ? "asc" : "desc"}`;
  };

  const rows = watchSortOrdered(quotesForRows)
    .map((q) => {
      const c = clsForChange(q.change);
      const pc = clsForPrice(q);
      const nameLine = q.name && q.name !== "—" ? esc(q.name) : "—";
      const pctStr =
        q.changePercent === null || q.changePercent === undefined || Number.isNaN(q.changePercent)
          ? "—"
          : (q.changePercent >= 0 ? "+" : "") + fmtNum(q.changePercent, 2) + "%";
      const chStr =
        q.change === null || q.change === undefined || Number.isNaN(q.change)
          ? "—"
          : (q.change >= 0 ? "+" : "") + fmtNum(q.change, 2);
      const sub = [q.currency, q.previousClose != null ? `昨收 ${fmtNum(q.previousClose, 2)}` : null]
        .filter(Boolean)
        .join(" · ");
      const errHtml = q.error
        ? `<div class="row-err">${esc(q.error)}</div>`
        : q.lastPrice == null && !q.name
          ? `<div class="row-err row-err--muted">行情加载中…</div>`
          : "";

      const primary = prefs.nameFirst ? nameLine : `${badgeHtml}${symLinkHtml(q.symbol)}`;
      const secondary = prefs.nameFirst
        ? `${badgeHtml}<span class="sym-code">${symLinkHtml(q.symbol)}</span>${sub ? `<span class="sym-meta">${esc(sub)}</span>` : ""}`
        : `${nameLine}${sub ? `<span class="sym-meta">${esc(sub)}</span>` : ""}`;

      const colChg = `<div class="col-chg num ${c}">${chStr}</div>`;
      const colPct = `<div class="col-pct num"><span class="pct-pill ${c}">${pctStr}</span></div>`;
      const colChgPct = prefs.swapChgPctColumns ? `${colPct}${colChg}` : `${colChg}${colPct}`;

      const symU = q.symbol.trim().toUpperCase();
      const report = getTodayAiReport(symU);
      const analyzing = aiAnalyzingSymbols.has(symU);
      const symEsc = esc(symU);

      return `<div class="watch-row watch-row-grid" data-symbol="${symEsc}">
      <div class="col-name">
        <div class="namestack ${prefs.nameFirst ? "name-first" : "code-first"}">
          <div class="line-primary">${primary}</div>
          <div class="line-secondary">${secondary}</div>
        </div>
        ${errHtml}
      </div>
      <div class="col-ai-report">${aiReportCellHtml(symU, report, analyzing)}</div>
      <div class="col-ai-score num">${buyScoreCellHtml(symU, report, analyzing)}</div>
      <div class="col-price num ${pc}">${fmtNum(q.lastPrice, 2)}</div>
      ${colChgPct}
    </div>`;
    })
    .join("");

  const listBody = hkList
    ? `<div class="watch-list-empty hint hk-hint">港股自选与行情将在后续版本接入；请先用「全部 / 美股」查看当前美股自选。</div>`
    : state.symbols.length === 0
      ? `<div class="watch-list-empty hint">暂无自选，点右上角 <strong>搜索</strong>；或在个股页点 <strong>爱心</strong> 加入或移出。</div>`
      : displaySyms.length === 0
        ? `<div class="watch-list-empty hint">无行情数据，请点右上角刷新</div>`
        : rows || `<div class="watch-list-empty hint">无行情数据，请点右上角刷新</div>`;

  const thChgBtn = `<button type="button" class="${sortThCls("change")} num col-chg" data-watch-sort="change" title="点击排序">涨跌额<span class="watch-list__sort-icon" aria-hidden="true"></span></button>`;
  const thPctBtn = `<button type="button" class="${sortThCls("changePercent")} num col-pct" data-watch-sort="changePercent" title="点击排序">涨跌幅<span class="watch-list__sort-icon" aria-hidden="true"></span></button>`;
  const thChgPctHead = prefs.swapChgPctColumns ? `${thPctBtn}${thChgBtn}` : `${thChgBtn}${thPctBtn}`;

  const thAiReport = `<div class="col-ai-report watch-list__th-plain watch-list__th-ai"><span class="watch-list__th-ai-txt">AI 分析</span><button type="button" class="watch-list__bulk-ai" data-watch-bulk-ai title="一键分析当前标签下列表中的股票">一键</button></div>`;
  const thBuyScore = `<div class="col-ai-score watch-list__th-score"><button type="button" class="${sortThCls("buyScore")} num watch-list__sort--score" data-watch-sort="buyScore" title="点击排序">评分<span class="watch-list__sort-icon" aria-hidden="true"></span></button>${curatorCurateHeadHtml()}</div>`;
  const thPrice = `<button type="button" class="${sortThCls("lastPrice")} num col-price" data-watch-sort="lastPrice" title="点击排序">价格<span class="watch-list__sort-icon" aria-hidden="true"></span></button>`;

  const seg = watchListSegmentStr;
  const tabSegBtn = (key: string, label: string, title?: string) =>
    `<button type="button" role="tab" class="list-market-tabs__btn${seg === key ? " is-active" : ""}" data-watch-segment="${key}" aria-selected="${seg === key}"${title ? ` title="${esc(title)}"` : ""}>${label}</button>`;
  const listTabsHtml = `<div class="list-market-tabs list-market-tabs--ibkr" role="tablist" aria-label="自选分类">
  ${tabSegBtn("m:all", "全部")}
  ${tabSegBtn("m:us", "美股")}
  ${tabSegBtn("m:hk", "港股", "后续版本")}
</div>`;

  const statusHtml = state.msg ? `<p class="watch-status">${esc(state.msg)}</p>` : "";

  const watchlistHtml = `
    <div class="layout layout-main layout-watchlist">
      <header class="page-head page-head--watchlist">
        <div class="page-head__titles">
          <h1>自选</h1>
        </div>
        ${watchlistHeadTools(state.loading)}
      </header>
      ${listTabsHtml}
      ${watchlistRankBannerHtml(displaySyms)}
      ${banner}
      ${statusHtml}

      <div class="watch-table-wrap">
        <div class="watch-list" style="--watch-cols: ${watchGridCols}">
          <div class="watch-row watch-row-grid watch-list__head">
            <div class="col-name">股票</div>
            ${thAiReport}
            ${thBuyScore}
            ${thPrice}
            ${thChgPctHead}
          </div>
          <div class="watch-list__body" id="watchListBody">${listBody}</div>
        </div>
      </div>
    </div>`;

  const symUpper = viewSymbol != null ? viewSymbol.toUpperCase() : null;
  const qForStock =
    symUpper != null
      ? state.quotes.find((q) => q.symbol.trim().toUpperCase() === symUpper)
      : undefined;
  const stockMini =
    qForStock && !qForStock.error
      ? `<div class="stock-mini">
  <span class="stock-mini__name">${esc(qForStock.name || "—")}</span>
  <span class="stock-mini__px num ${clsForPrice(qForStock)}">${fmtNum(qForStock.lastPrice, 2)}</span>
  <span class="stock-mini__chg num ${clsForChange(qForStock.change)}">${
      qForStock.change === null || Number.isNaN(qForStock.change)
        ? "—"
        : (qForStock.change >= 0 ? "+" : "") + fmtNum(qForStock.change, 2)
    }</span>
  <span class="stock-mini__pct"><span class="pct-pill ${clsForChange(qForStock.change)}">${
      qForStock.changePercent === null || Number.isNaN(qForStock.changePercent)
        ? "—"
        : (qForStock.changePercent >= 0 ? "+" : "") + fmtNum(qForStock.changePercent, 2) + "%"
    }</span></span>
</div>`
      : symUpper
        ? `<p class="hint stock-mini-hint">行情加载中或暂无数据，可返回自选页刷新。</p>`
        : "";

  const stockHtmlEmpty = `
    <div class="layout layout-main layout-stock">
      <header class="page-head page-head--stock">
        <button type="button" class="btn-ghost" data-app-tab="watchlist">自选</button>
        <h1 class="page-head__sym">个股</h1>
        <div class="page-head__right page-head__right--stock">
          <button type="button" class="btn-ai-pill" data-app-tab="ai">AI 分析</button>
        </div>
      </header>
      <div class="stock-empty-hint">
        <p class="hint">在「自选」页点右上角搜索，选择股票进入个股页。</p>
      </div>
    </div>`;

  const stockHtml =
    viewSymbol == null
      ? stockHtmlEmpty
      : (() => {
          const sym = viewSymbol;
          const url = quoteDetailUrl(sym, prefs.quoteLinkTarget);
          const urlEsc = esc(url);
          return `
    <div class="layout layout-main layout-stock">
      <header class="page-head page-head--stock">
        <button type="button" class="btn-ghost" data-app-tab="watchlist" title="返回自选">自选</button>
        <h1 class="page-head__sym">${esc(sym)}</h1>
        <div class="page-head__right page-head__right--stock">
          ${stockHeadTools(sym)}
          <button type="button" class="btn-ghost" data-ask-ai="${esc(sym)}" title="携带该股问 AI">问 AI</button>
          <button type="button" class="btn-ai-pill" data-app-tab="ai">AI 分析</button>
        </div>
      </header>
      ${stockMini}
      <div class="quote-embed-wrap">
        <iframe class="quote-embed-frame" src="${urlEsc}" title="${esc(sym)} 行情"></iframe>
        <div class="quote-embed-toolbar">
          <a class="primary" href="${urlEsc}" target="_blank" rel="noopener noreferrer">新窗口打开</a>
        </div>
      </div>
      <p class="hint">微信小程序可用 <code>web-view</code> 加载同一地址并保留原生底栏；与当前 H5 结构一致。</p>
    </div>`;
        })();

  const aiBanner =
    aiConfigured === false
      ? `<div class="banner-warn"><strong>未配置大模型</strong>：在 <code>backend/.env</code> 设置 <code>DASHSCOPE_API_KEY</code>（通义千问/百炼，默认兼容模式与 qwen-plus）或 <code>OPENAI_API_KEY</code> 后重启 uvicorn。可选 <code>OPENAI_BASE_URL</code>、<code>OPENAI_MODEL</code> / <code>QWEN_MODEL</code>。</div>`
      : "";

  const aiIntro =
    aiMessages.length === 0 && !aiLoading
      ? `<div class="ai-empty-hint">输入问题开始对话；在个股页点「问 AI」可附带该股最近一次行情快照。</div>`
      : "";

  const aiMsgsHtml = aiMessages
    .map((m) =>
      m.role === "user"
        ? `<div class="ai-msg ai-msg--user"><div class="ai-msg-bubble ai-msg-bubble--user">${esc(m.content)}</div></div>`
        : `<div class="ai-msg ai-msg--asst"><div class="ai-msg-bubble ai-msg-bubble--asst"><div class="ai-md">${markdownToSafeHtml(m.content)}</div></div></div>`
    )
    .join("");

  const aiLoadingHtml = aiLoading
    ? `<div class="ai-msg ai-msg--asst"><div class="ai-msg-bubble ai-msg-bubble--asst ai-msg-bubble--loading">正在生成…</div></div>`
    : "";

  const aiCtxChip =
    aiThreadSymbol != null
      ? `<div class="ai-ctx-chip">
  <span class="ai-ctx-chip__txt">附带快照 <strong>${esc(aiThreadSymbol)}</strong></span>
  <button type="button" class="ai-ctx-chip__x" id="aiClearSymbol" title="取消附带代码">×</button>
</div>`
      : "";

  const aiClearBtn =
    aiMessages.length > 0
      ? `<button type="button" class="btn-ghost btn-ghost--sm" id="aiClear">清空对话</button>`
      : "";

  const aiHtml = `
    <div class="layout layout-main layout-ai">
      <header class="page-head page-head--ai">
        <button type="button" class="btn-ghost" data-app-tab="watchlist">自选</button>
        <h1 class="page-head__sym">AI 分析</h1>
        <span class="page-head__balance" aria-hidden="true"></span>
      </header>
      ${aiBanner}
      <div class="ai-chat-shell">
        <div class="ai-thread" id="aiThread">${aiIntro}${aiMsgsHtml}${aiLoadingHtml}</div>
        <div class="ai-composer">
          ${aiCtxChip}
          <div class="ai-composer-row">
            <textarea id="aiInput" class="ai-input-line" rows="1" placeholder="输入问题，Enter 发送，Shift+Enter 换行" autocomplete="off"></textarea>
            <button type="button" class="ai-send-btn primary" id="aiSend" ${aiLoading ? "disabled" : ""}>发送</button>
          </div>
          <div class="ai-composer-meta">${aiClearBtn}</div>
        </div>
      </div>
    </div>`;

  app.innerHTML = `
    <div class="app-shell">
      <main class="app-main" id="appMain">
        ${appTab === "watchlist" ? watchlistHtml : appTab === "stock" ? stockHtml : aiHtml}
      </main>
      ${indexStripHtml()}
      ${tabBarHtml(appTab)}
    </div>
    ${settingsPanelHtml()}
    ${aiReportSheetHtml()}
    ${stockSearchSheetHtml(
      stockSearchOpen,
      stockSearchLoading,
      stockSearchQuery,
      stockSearchResults,
      esc
    )}
    ${watchlistMenuSheetHtml()}
    ${portfolioCuratorSheetHtml()}
  `;

  ensureShellNavigation();
  ensureStockSearchDelegation();
  ensureAiKeyboard();
  bindSettingsUi();
  if (appTab === "ai") bindAiPanel();
  if (stockSearchOpen) bindStockSearchInput();
}

let symbols: string[] = [];
let quotes: Quote[] = [];
let loading = false;
let msg = "";
let finnhubConfigured: boolean | null = null;
let quoteProvider: string | null = null;

async function loadAll() {
  aiReports = loadAiReports();
  loading = true;
  msg = "";
  render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
  try {
    const [w, q, h] = await Promise.all([
      api<{ symbols: string[] }>("/api/watchlist"),
      api<{ quotes: Quote[] }>("/api/quotes"),
      api<{
        finnhub_configured?: boolean;
        quote_provider?: string;
        llm_configured?: boolean;
        openai_configured?: boolean;
      }>("/api/health"),
    ]);
    symbols = w.symbols;
    quotes = q.quotes;
    finnhubConfigured = h.finnhub_configured === true;
    quoteProvider = h.quote_provider ?? null;
    aiConfigured = h.llm_configured === true || h.openai_configured === true;
    msg = `已更新 ${new Date().toLocaleString("zh-CN")}`;
  } catch (e) {
    msg = `请求失败：${e instanceof Error ? e.message : String(e)}（请确认后端已启动）`;
  } finally {
    loading = false;
    syncWatchlistRankCache();
    render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
  }
}

async function onAdd(raw: string) {
  const s = raw.trim();
  if (!s) return;
  loading = true;
  msg = "";
  render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
  try {
    await api("/api/watchlist/symbol", {
      method: "POST",
      body: JSON.stringify({ symbol: s }),
    });
    await loadAll();
    const input = app.querySelector<HTMLInputElement>("#symInput");
    if (input) input.value = "";
  } catch (e) {
    loading = false;
    msg = e instanceof Error ? e.message : String(e);
    render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
  }
}

async function onDel(symbol: string) {
  const sym = symbol.trim().toUpperCase();
  loading = true;
  msg = "";
  render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
  try {
    await api(`/api/watchlist/symbol/${encodeURIComponent(sym)}`, { method: "DELETE" });
    deleteAiReport(sym);
    delete aiReports[sym];
    if (aiReportSheetSymbol === sym) aiReportSheetSymbol = null;
    if (viewSymbol?.toUpperCase() === sym) {
      viewSymbol = null;
      saveViewSymbol(null);
    }
    await loadAll();
  } catch (e) {
    loading = false;
    msg = e instanceof Error ? e.message : String(e);
    render({ symbols, quotes, loading, msg, finnhubConfigured, quoteProvider });
  }
}

syncWatchlistRankCache();
render({ symbols, quotes, loading: true, msg: "加载中…", finnhubConfigured: null, quoteProvider: null });
void loadAll();
