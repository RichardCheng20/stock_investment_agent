import json
import logging
import os
import re
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
import ssl
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import yfinance as yf
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

logging.getLogger("yfinance").setLevel(logging.CRITICAL)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
_BACKEND_DIR = Path(__file__).resolve().parent

try:
    from dotenv import load_dotenv

    load_dotenv(_BACKEND_DIR / ".env")
    load_dotenv(PROJECT_ROOT / ".env")
except ImportError:
    pass

FRONTEND_DIST = PROJECT_ROOT / "frontend" / "dist"

DATA_DIR = Path(__file__).resolve().parent / "data"
WATCHLIST_PATH = DATA_DIR / "watchlist.json"

SYMBOL_PATTERN = re.compile(r"^[A-Z0-9.\-]{1,10}$")

app = FastAPI(title="stock_investment_agent")


def _finnhub_api_key() -> str:
    return (os.environ.get("FINNHUB_API_KEY") or "").strip()


def _quote_provider_mode() -> str:
    m = (os.environ.get("QUOTE_PROVIDER") or "auto").strip().lower()
    if m in ("auto", "eastmoney", "finnhub", "yahoo"):
        return m
    return "auto"


def _health_quote_provider_label() -> str:
    m = _quote_provider_mode()
    tok = _finnhub_api_key()
    if m == "eastmoney":
        return "eastmoney"
    if m == "yahoo":
        return "yahoo_yfinance"
    if m == "finnhub":
        return "finnhub" if tok else "eastmoney"
    if tok:
        return "finnhub"
    return "eastmoney"


def _llm_provider_key() -> tuple[str, str]:
    """返回 (api_key, provider)，provider 为 dashscope 或 openai。"""
    for name, tag in (
        ("DASHSCOPE_API_KEY", "dashscope"),
        ("QWEN_API_KEY", "dashscope"),
        ("OPENAI_API_KEY", "openai"),
    ):
        v = (os.environ.get(name) or "").strip()
        if v:
            return v, tag
    return "", ""


def _llm_api_key() -> str:
    k, _ = _llm_provider_key()
    return k


def _llm_base_url() -> str:
    explicit = (os.environ.get("OPENAI_BASE_URL") or "").strip().rstrip("/")
    if explicit:
        return explicit
    _, tag = _llm_provider_key()
    if tag == "dashscope":
        return "https://dashscope.aliyuncs.com/compatible-mode/v1"
    return "https://api.openai.com/v1"


def _llm_model() -> str:
    m = (os.environ.get("OPENAI_MODEL") or "").strip()
    if m:
        return m
    for name in ("QWEN_MODEL", "DASHSCOPE_MODEL"):
        v = (os.environ.get(name) or "").strip()
        if v:
            return v
    _, tag = _llm_provider_key()
    return "qwen-plus" if tag == "dashscope" else "gpt-4o-mini"


def _llm_provider_tag() -> str:
    _, tag = _llm_provider_key()
    if tag == "dashscope":
        return "dashscope"
    if "dashscope" in _llm_base_url().lower():
        return "dashscope"
    return "openai"


def _llm_enable_web_search() -> bool:
    raw = (os.environ.get("LLM_ENABLE_SEARCH") or "").strip().lower()
    if raw in ("0", "false", "no", "off"):
        return False
    if raw in ("1", "true", "yes", "on"):
        return True
    return _llm_provider_tag() == "dashscope"


def _llm_search_options() -> dict:
    raw = (os.environ.get("LLM_SEARCH_FRESHNESS_DAYS") or "30").strip()
    try:
        freshness = int(raw)
    except ValueError:
        freshness = 30
    if freshness not in (7, 30, 180, 365):
        freshness = 30
    return {
        "forced_search": True,
        "search_strategy": "turbo",
        "freshness": freshness,
    }


def _server_now_labels() -> dict[str, str]:
    utc = datetime.now(timezone.utc)
    cn = utc.astimezone(ZoneInfo("Asia/Shanghai"))
    return {
        "utc": utc.isoformat(timespec="seconds"),
        "beijing": cn.isoformat(timespec="seconds"),
        "beijingDate": cn.strftime("%Y-%m-%d"),
    }


def _llm_system_content() -> str:
    """每次请求动态生成 system：含服务端时间与强制数据规则，无需用户输入。"""
    labels = _server_now_labels()
    temporal = (
        f"【服务端当前时间】UTC {labels['utc']} · 北京时间 {labels['beijing']}（{labels['beijingDate']}）\n"
        "以下规则由程序在每次对话请求时自动注入，用户无需重复说明日期或时效要求。"
    )
    data_rules = """【数据时效与禁止臆测（强制）】
0. 本对话已开启模型联网搜索（百炼 enable_search + forced_search）。最新新闻、财报发布、政策与行业动态须优先依据联网检索结果，并尽量标注信息日期；不得用训练记忆中的旧闻或旧日程充当当前事实。
1. 股价、涨跌幅、RSI/MACD 等盘面数字以用户消息中「服务端自动生成 · 决策数据包」JSON 为准；联网结果用于补充事件与基本面叙事，不可替代行情包中的数值。
2. 若数据包与联网结果均缺少某项，必须明确写「本服务本次未提供该数据」，并提示查阅行情终端/交易所/IR/SEC；禁止用旧年份日程冒充「即将公布」或「待验证」。
3. 撰写技术面时，优先引用数据包中 recentDailyBars、technicals.rsi14、quoteFromApp；不得编造「等待 RSI 回落至 XX」等区间，除非 rsi14 已在数据包中给出且文中标明该数值与对应日期。
4. 撰写基本面日程时，须交叉引用 earningsFromFinnhub.earningsCalendar、yahooInfoSnapshot 与联网检索到的官方/IR 信息；无可靠来源则不得写具体公布月日。
5. 在「分析结论」或文首用一句话说明：盘面数据截至数据包 dataAsOf/lastBarDate，事件与新闻截至联网检索时间（服务端当前时间）；并再次确认已写出报告生成时间与买入推荐评分。"""
    return LLM_SYSTEM_PROMPT + "\n\n" + temporal + "\n" + data_rules


LLM_SYSTEM_PROMPT = """你是具备证券研究与量化交易视角的资深分析师，使用简体中文撰写报告。

硬性要求：
1. 必须同时覆盖「基本面」与「技术面/量价」两类分析；二者篇幅大致均衡。
2. 不得编造未公开的订单、内幕或未披露财务数字；若缺少数据，请明确写「公开信息不足」并给出应查阅的渠道（如财报、交易所披露、行情终端）。
3. 语气专业、克制，避免喊单式表述；结论用「中性/偏多/偏空」等审慎措辞，并说明主要不确定性。

输出必须使用 Markdown，且须包含以下二级标题（顺序一致，可在节内使用子标题与列表展开）：
## 分析结论
（段首第一行必须写明：「报告生成时间：YYYY-MM-DD HH:mm（北京时间）」——时间须与本次服务端注入的当前北京时间一致或如实说明检索时点。）
（段内必须明确写出「买入推荐评分：X.X/10」，X.X 为保留一位小数的 1.0–10.0；须附一句评分理由。）
（段内须各占一行：「投资立场：」后接 增持、持有、观望、减仓、调出 之一；「主要风险：」后接一句话风险要点。）
## 核心观点
## 一、基本面分析
### 业绩与业务
### 估值与股东回报
## 二、技术面与量价
### 趋势与关键价位
### 指标与超买超卖（如适用）
## 三、风险提示与综合建议
## 免责声明

免责声明须说明：本内容由大模型生成，不构成投资建议，投资者应自行判断并承担风险。"""


app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:8000",
        "http://localhost:8000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class WatchlistPayload(BaseModel):
    symbols: list[str] = Field(default_factory=list)


class AddSymbolBody(BaseModel):
    symbol: str


class AiChatBody(BaseModel):
    message: str = Field(..., min_length=1, max_length=12000)
    symbol: str | None = Field(None, max_length=12)


class WatchlistRankReportInput(BaseModel):
    symbol: str
    singleBuyScore: float | None = None
    stance: str | None = None
    keyRisk: str | None = None
    summary: str = Field(..., min_length=1, max_length=4000)


class WatchlistRankBody(BaseModel):
    symbols: list[str] | None = None
    topK: int = Field(3, ge=1, le=10)
    reports: list[WatchlistRankReportInput] = Field(default_factory=list)


STANCE_VALUES = frozenset({"增持", "持有", "观望", "减仓", "调出"})
REDUCE_ACTION_VALUES = frozenset({"减仓", "调出", "观望"})

# Agent B：组合优选专员（仅做横向比较与组合决策，不重复撰写单股长文）
PORTFOLIO_CURATOR_SYSTEM_PROMPT = """你是「组合优选专员」（Portfolio Curator Agent），与负责单股深度研报的 Analyst Agent 分工协作。
你将收到：① 各股 Analyst 报告摘要（含单股评分、投资立场、主要风险）；② 全池行情数据包。
你的唯一任务：在同一标尺下横向比较，输出购买优先级、组合风险，以及对弱势或高估标的的减仓/调出建议。

硬性要求：
1. relativeScore 为 1.0–10.0，保留一位小数；池内任意两只不得相同；须拉开差距，禁止全部 8.0。
2. ranked 中每只须含 stance（增持/持有/观望/减仓/调出），须与 relativeScore、Analyst 摘要逻辑一致。
3. reduceOrExit：仅列入你建议「减仓」或「调出」或因风险需「观望」下调优先级的标的；无则 []。action 只能是 减仓、调出、观望 之一。
4. portfolioRisks：2–5 条组合层面风险（如行业集中、宏观、估值共振），须基于数据包与摘要，不得编造具体未披露数字。
5. 输出必须是合法 JSON，不要用 markdown 代码块包裹，格式如下（字段名不可改）：
{"ranked":[{"symbol":"XXX","rank":1,"relativeScore":9.4,"stance":"增持","compareReason":"60-100字：相对全池为何排此名次，与前后名次标的的差异","reason":"同 compareReason 的精简版20字内"},...],"topPicks":["SYM1","SYM2","SYM3"],"topPicksRationale":"80-120字：为何这三只优于池内其余标的","horizontalComparison":"200-400字：全池横向对比（强弱分层、赛道重复度、估值与动量相对位置，勿编造未披露数字）","conclusion":"80-120字：购买优先级与配置结论（非指令式）","reduceOrExit":[{"symbol":"YYY","action":"减仓","reason":"40字内依据"}],"portfolioRisks":["风险1","风险2"],"summary":"2-3句概要；末句说明不构成投资建议"}
6. ranked 须覆盖数据包中每一只股票；topPicks 长度为 topK；horizontalComparison 与 conclusion 必填且须为完整分析段落。
7. 不得编造数据包与 Analyst 摘要中未出现的财务数字。"""


def _normalize_symbol(raw: str) -> str:
    s = raw.strip().upper()
    if not SYMBOL_PATTERN.match(s):
        raise HTTPException(status_code=400, detail=f"非法股票代码: {raw!r}")
    return s


def _read_watchlist() -> list[str]:
    if not WATCHLIST_PATH.is_file():
        return []
    with open(WATCHLIST_PATH, encoding="utf-8") as f:
        data = json.load(f)
    symbols = data.get("symbols") or []
    out: list[str] = []
    seen: set[str] = set()
    for x in symbols:
        sym = _normalize_symbol(str(x))
        if sym not in seen:
            seen.add(sym)
            out.append(sym)
    return out


def _write_watchlist(symbols: list[str]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(WATCHLIST_PATH, "w", encoding="utf-8") as f:
        json.dump({"symbols": symbols}, f, ensure_ascii=False, indent=2)
        f.write("\n")


def _quote_error(symbol: str, msg: str) -> dict:
    return {
        "symbol": symbol,
        "name": None,
        "lastPrice": None,
        "previousClose": None,
        "change": None,
        "changePercent": None,
        "currency": None,
        "error": msg,
    }


_EASTMONEY_HTTP_EXTRA = {
    "Referer": "https://quote.eastmoney.com/",
    "Origin": "https://quote.eastmoney.com",
}

try:
    import certifi

    _SSL_DEFAULT_CONTEXT = ssl.create_default_context(cafile=certifi.where())
except Exception:
    _SSL_DEFAULT_CONTEXT = None


_EASTMONEY_SECID_CACHE: dict[str, tuple[str, str | None]] = {}


def _http_read(
    url: str,
    timeout: float = 20.0,
    extra_headers: dict[str, str] | None = None,
    *,
    retries: int = 2,
) -> tuple[int | None, str, str | None]:
    """返回 (http_status, body_text, transport_error)。HTTP 4xx/5xx 时 status 为错误码，body 为响应体。"""
    h: dict[str, str] = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        ),
        "Accept": "application/json,text/plain,*/*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }
    if extra_headers:
        h.update(extra_headers)
    req = urllib.request.Request(url, headers=h)
    ctx = None
    if url.lower().startswith("https://") and _SSL_DEFAULT_CONTEXT is not None:
        ctx = _SSL_DEFAULT_CONTEXT
    last_err: str | None = None
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
                status = resp.getcode()
                body = resp.read().decode("utf-8", errors="replace")
                return status, body, None
        except urllib.error.HTTPError as e:
            try:
                body = e.read().decode("utf-8", errors="replace")
            except OSError:
                body = ""
            return int(e.code), body, None
        except urllib.error.URLError as e:
            reason = getattr(e, "reason", e)
            last_err = str(reason)
        except (TimeoutError, OSError, ValueError) as e:
            last_err = str(e)
        if attempt < retries and last_err and (
            "timed out" in last_err.lower() or "handshake" in last_err.lower()
        ):
            time.sleep(0.4 * (attempt + 1))
            continue
        return None, "", last_err
    return None, "", last_err


def _http_json(
    url: str, timeout: float = 20.0, extra_headers: dict[str, str] | None = None
) -> tuple[dict | None, str | None]:
    """(json_dict, error_detail)。error_detail 供排查网络/墙/代理。"""
    status, text, terr = _http_read(url, timeout, extra_headers)
    if terr:
        return None, f"连接失败: {terr}"
    if status is None:
        return None, "无 HTTP 状态"
    if status != 200:
        frag = (text or "").replace("\n", " ").strip()[:180]
        return None, f"HTTP {status}，片段: {frag}"
    raw = (text or "").strip()
    if not raw.startswith("{"):
        frag = raw.replace("\n", " ")[:180]
        return None, (
            f"HTTP {status} 但正文非 JSON（常见于被墙、公司代理、SSL 解密返回 HTML）。"
            f"片段: {frag}"
        )
    try:
        return json.loads(raw), None
    except json.JSONDecodeError as e:
        return None, f"JSON 解析失败: {e}"


def _http_post_json(
    url: str,
    payload: dict,
    *,
    timeout: float = 120.0,
    extra_headers: dict[str, str] | None = None,
) -> tuple[dict | None, str | None]:
    """POST JSON，返回 (json_dict, error_str)。"""
    raw_body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers: dict[str, str] = {
        "User-Agent": "stock-investment-agent/1.0",
        "Accept": "application/json",
        "Content-Type": "application/json; charset=utf-8",
    }
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(url, data=raw_body, headers=headers, method="POST")
    ctx = _SSL_DEFAULT_CONTEXT if str(url).lower().startswith("https://") else None
    text = ""
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            status = resp.getcode()
            text = resp.read().decode("utf-8", errors="replace")
            if status != 200:
                return None, f"HTTP {status}: {text.replace(chr(10), ' ')[:320]}"
    except urllib.error.HTTPError as e:
        try:
            text = e.read().decode("utf-8", errors="replace")
        except OSError:
            text = ""
        try:
            ej = json.loads(text)
            em = ej.get("error") if isinstance(ej, dict) else None
            if isinstance(em, dict) and em.get("message"):
                return None, str(em["message"])
        except (json.JSONDecodeError, TypeError):
            pass
        frag = text.replace("\n", " ")[:400]
        return None, f"HTTP {e.code}: {frag}"
    except urllib.error.URLError as e:
        return None, str(getattr(e, "reason", e))
    except (TimeoutError, OSError, ValueError) as e:
        return None, str(e)
    try:
        return json.loads(text), None
    except json.JSONDecodeError as e:
        return None, f"JSON 解析失败: {e}"


def _yahoo_v7_quote_map(symbols: list[str]) -> dict[str, dict] | None:
    """返回 symbol(大写) -> 行情 dict；若 Yahoo 不可用则返回 None。"""
    if not symbols:
        return {}
    q = urllib.parse.urlencode({"symbols": ",".join(symbols)})
    url = f"https://query1.finance.yahoo.com/v7/finance/quote?{q}"
    data, err = _http_json(url)
    if not data:
        return None
    qr = data.get("quoteResponse")
    if not isinstance(qr, dict) or qr.get("error"):
        return None
    rows = qr.get("result")
    if not isinstance(rows, list):
        return None
    out: dict[str, dict] = {}
    for r in rows:
        if not isinstance(r, dict):
            continue
        sym = str(r.get("symbol") or "").strip().upper()
        if not sym:
            continue
        name = r.get("shortName") or r.get("longName")
        currency = r.get("currency")
        price = r.get("regularMarketPrice")
        prev = r.get("regularMarketPreviousClose")
        if price is None:
            price = r.get("postMarketPrice") or r.get("preMarketPrice")
        if prev is None:
            prev = r.get("previousClose")
        try:
            if price is None or prev is None:
                out[sym] = _quote_error(sym, "Yahoo 返回缺少价格字段")
                continue
            last = float(price)
            pc = float(prev)
        except (TypeError, ValueError):
            out[sym] = _quote_error(sym, "Yahoo 价格字段无法解析")
            continue
        ch = r.get("regularMarketChange")
        if ch is None:
            ch = last - pc
        else:
            try:
                ch = float(ch)
            except (TypeError, ValueError):
                ch = last - pc
        pct = r.get("regularMarketChangePercent")
        if pct is None:
            pct = (ch / pc * 100.0) if pc else 0.0
        else:
            try:
                pct = float(pct)
            except (TypeError, ValueError):
                pct = (ch / pc * 100.0) if pc else 0.0
        out[sym] = {
            "symbol": sym,
            "name": name,
            "lastPrice": round(last, 4),
            "previousClose": round(pc, 4),
            "change": round(ch, 4),
            "changePercent": round(pct, 4),
            "currency": currency,
            "error": None,
        }
    return out


def _quote_yfinance(symbol: str) -> dict:
    t = yf.Ticker(symbol)
    hist = t.history(period="10d")
    if hist.empty or "Close" not in hist.columns:
        return _quote_error(
            symbol,
            "Yahoo 行情不可用（网络或地区限制）。请设置环境变量 FINNHUB_API_KEY 后重启后端，详见 README。",
        )
    close = hist["Close"].astype(float)
    last = float(close.iloc[-1])
    prev = float(close.iloc[-2]) if len(close) >= 2 else last
    change = last - prev
    change_pct = (change / prev * 100.0) if prev else 0.0
    info: dict = {}
    try:
        info = t.info or {}
    except Exception:
        pass
    name = info.get("shortName") or info.get("longName")
    currency = info.get("currency")
    return {
        "symbol": symbol,
        "name": name,
        "lastPrice": round(last, 4),
        "previousClose": round(prev, 4),
        "change": round(change, 4),
        "changePercent": round(change_pct, 4),
        "currency": currency,
        "error": None,
    }


def _quote_finnhub(symbol: str, token: str) -> dict:
    sym_q = urllib.parse.quote(symbol)
    tok_q = urllib.parse.quote(token)
    qurl = f"https://finnhub.io/api/v1/quote?symbol={sym_q}&token={tok_q}"
    jd, qerr = _http_json(qurl)
    if not jd or not isinstance(jd, dict):
        detail = qerr or "未知"
        return _quote_error(
            symbol,
            f"Finnhub quote 不可用: {detail}。"
            " 若浏览器能打开 finnhub 但此处失败，多为「浏览器插件 VPN」未覆盖本机 Python；"
            "请改用系统/全局 VPN，或给终端配置 HTTPS_PROXY。",
        )
    if jd.get("error"):
        return _quote_error(symbol, f"Finnhub: {jd.get('error')}")
    c = jd.get("c")
    pc = jd.get("pc")
    if c is None or pc is None:
        return _quote_error(symbol, "Finnhub 缺少现价或昨收")
    try:
        last = float(c)
        prev_c = float(pc)
    except (TypeError, ValueError):
        return _quote_error(symbol, "Finnhub 价格字段无效")
    d = jd.get("d")
    dp = jd.get("dp")
    if d is None:
        ch = last - prev_c
    else:
        try:
            ch = float(d)
        except (TypeError, ValueError):
            ch = last - prev_c
    if dp is None:
        pct = (ch / prev_c * 100.0) if prev_c else 0.0
    else:
        try:
            pct = float(dp)
        except (TypeError, ValueError):
            pct = (ch / prev_c * 100.0) if prev_c else 0.0
    name = None
    currency = "USD"
    purl = f"https://finnhub.io/api/v1/stock/profile2?symbol={sym_q}&token={tok_q}"
    pj, _perr = _http_json(purl)
    if isinstance(pj, dict):
        name = pj.get("name") or pj.get("ticker")
        if pj.get("currency"):
            currency = pj.get("currency")
    return {
        "symbol": symbol.upper(),
        "name": name,
        "lastPrice": round(last, 4),
        "previousClose": round(prev_c, 4),
        "change": round(ch, 4),
        "changePercent": round(pct, 4),
        "currency": currency,
        "error": None,
    }


def _eastmoney_rc_ok(payload: dict) -> bool:
    v = payload.get("rc")
    if v is None:
        return False
    try:
        return int(v) == 0
    except (TypeError, ValueError):
        return False


def _eastmoney_row_is_us(row: dict) -> bool:
    if row.get("Classify") == "UsStock":
        return True
    jys = str(row.get("JYS") or "").upper()
    if jys in ("NASDAQ", "NYSE", "AMEX"):
        return True
    if str(row.get("MarketType") or "") == "7":
        return True
    stn = str(row.get("SecurityTypeName") or "")
    return "美股" in stn


# 与东财网页端一致的 qt/stock/get 参数：返回已为小数的 f43/f60，f170 为小数涨跌幅（%）。
_EASTMONEY_UT = "fa5fd1943c7b386f172d6893dbfba10b"


def _eastmoney_qt_stock_get_query(secid: str, fields: str) -> str:
    return urllib.parse.urlencode(
        {
            "secid": secid,
            "fields": fields,
            "invt": 2,
            "fltt": 2,
            "ut": _EASTMONEY_UT,
        }
    )


def _eastmoney_probe_secid(secid: str) -> tuple[bool, str | None]:
    """用 push2 探测 secid 是否有效；返回 (成功, f58名称)。"""
    q = _eastmoney_qt_stock_get_query(secid, "f57,f58")
    for host in ("push2.eastmoney.com", "push2delay.eastmoney.com"):
        url = f"https://{host}/api/qt/stock/get?{q}"
        data, err = _http_json(url, extra_headers=_EASTMONEY_HTTP_EXTRA)
        if err or not data:
            continue
        if not _eastmoney_rc_ok(data):
            continue
        d = data.get("data")
        if isinstance(d, dict) and d.get("f57"):
            return True, str(d.get("f58") or "") or None
    return False, None


def _eastmoney_store_secid(sym: str, secid: str, name: str | None) -> tuple[str, str | None, None]:
    _EASTMONEY_SECID_CACHE[sym] = (secid, name)
    return secid, name, None


def _eastmoney_resolve_secid(symbol: str) -> tuple[str | None, str | None, str | None]:
    """东方财富：返回 (secid, 中文名, 错误说明)。错误说明仅失败时非空。"""
    sym = symbol.strip().upper()
    cached = _EASTMONEY_SECID_CACHE.get(sym)
    if cached:
        return cached[0], cached[1], None
    url = (
        "https://searchadapter.eastmoney.com/api/suggest/get?"
        + urllib.parse.urlencode({"input": sym, "type": "14"})
    )
    data, err = _http_json(url, extra_headers=_EASTMONEY_HTTP_EXTRA)
    if not data:
        hint = err or "东财 suggest 无响应"
        for m in ("105", "106"):
            sid = f"{m}.{sym}"
            ok, nm = _eastmoney_probe_secid(sid)
            if ok:
                return _eastmoney_store_secid(sym, sid, nm)
        return None, None, hint
    rows = (data.get("QuotationCodeTable") or {}).get("Data") or []
    for row in rows:
        if str(row.get("Code", "")).strip().upper() != sym:
            continue
        if not _eastmoney_row_is_us(row):
            continue
        qid = row.get("QuoteID")
        if qid:
            nm = str(row.get("Name") or "").strip() or None
            return _eastmoney_store_secid(sym, str(qid), nm)
    for m in ("105", "106"):
        sid = f"{m}.{sym}"
        ok, nm = _eastmoney_probe_secid(sid)
        if ok:
            return _eastmoney_store_secid(sym, sid, nm)
    if err:
        return None, None, err
    if not rows:
        return None, None, "东财 suggest 返回空列表（可能被拦截或参数异常）"
    return None, None, f"东财 suggest 无匹配美股行（共 {len(rows)} 条候选）"


def _eastmoney_search_rank(q_upper: str, sym: str, name: str | None) -> int | None:
    """相关度越小越靠前；None 表示应过滤。"""
    nm = (name or "").upper()
    if sym == q_upper:
        return 0
    if sym.startswith(q_upper):
        return 1
    if q_upper in nm:
        return 2
    if len(q_upper) >= 2 and SYMBOL_PATTERN.match(q_upper):
        return None
    return 3


def _eastmoney_search_us(query: str, limit: int = 15) -> list[dict]:
    q = (query or "").strip()
    if not q:
        return []
    q_upper = q.upper()
    url = (
        "https://searchadapter.eastmoney.com/api/suggest/get?"
        + urllib.parse.urlencode({"input": q, "type": "14"})
    )
    data, _err = _http_json(url, extra_headers=_EASTMONEY_HTTP_EXTRA)
    ranked: list[tuple[int, str, str | None]] = []
    seen: set[str] = set()
    if data:
        rows = (data.get("QuotationCodeTable") or {}).get("Data") or []
        for row in rows:
            if not _eastmoney_row_is_us(row):
                continue
            sym = str(row.get("Code", "")).strip().upper()
            if not sym or sym in seen:
                continue
            if not SYMBOL_PATTERN.match(sym):
                continue
            name = str(row.get("Name") or "").strip() or None
            rank = _eastmoney_search_rank(q_upper, sym, name)
            if rank is None:
                continue
            seen.add(sym)
            ranked.append((rank, sym, name))
    ranked.sort(key=lambda x: (x[0], len(x[1]), x[1]))
    out: list[dict] = [
        {"symbol": sym, "name": name} for _, sym, name in ranked[:limit]
    ]
    if q_upper not in seen and SYMBOL_PATTERN.match(q_upper):
        for m in ("105", "106"):
            sid = f"{m}.{q_upper}"
            ok, nm = _eastmoney_probe_secid(sid)
            if ok:
                out.insert(0, {"symbol": q_upper, "name": nm})
                break
    return out[:limit]


def _eastmoney_tick_divisor(f43: float, f152_raw: object) -> float | None:
    """未带 fltt 时 f43 为整数价位 + f152 为小数位元数据时的除数；失败则返回 None。"""
    try:
        f152 = int(float(f152_raw)) if f152_raw is not None else 2
    except (TypeError, ValueError):
        f152 = 2
    f152 = max(0, min(f152, 8))
    try:
        n = int(abs(f43))
    except (TypeError, ValueError):
        return None
    if n <= 0:
        return None
    d = len(str(n))
    exp = max(0, d - 1 - f152)
    return float(10**exp)


def _eastmoney_pick_divisor(f43: float, f60: float, f170_raw: object) -> float:
    """东财接口价为整数且无法从 f152 可靠推断时的兜底：用 f170 与价位反推缩放因子。"""
    fi: int | None = None
    if f170_raw is not None:
        try:
            fi = int(round(float(f170_raw)))
        except (TypeError, ValueError):
            fi = None
    for div in (1000.0, 10000.0, 100.0, 100000.0):
        try:
            last = f43 / div
            prev = f60 / div
        except (TypeError, ValueError, ZeroDivisionError):
            continue
        if not (0.01 <= last <= 500_000 and 0.01 <= prev <= 500_000):
            continue
        if fi is not None and prev != 0:
            pct_api = fi / 100.0
            pct_calc = (last - prev) / prev * 100.0
            if abs(pct_api - pct_calc) < 0.35:
                return div
    for div in (1000.0, 10000.0, 100.0, 100000.0):
        try:
            last = f43 / div
            prev = f60 / div
        except (TypeError, ValueError, ZeroDivisionError):
            continue
        if 0.01 <= last <= 500_000 and 0.01 <= prev <= 500_000:
            return div
    return 1000.0


def _eastmoney_resolve_change_pct(f170_raw: object, last: float, prev: float) -> float:
    calc = (last - prev) / prev * 100.0 if prev else 0.0
    if f170_raw is None:
        return calc
    try:
        fv = float(f170_raw)
    except (TypeError, ValueError):
        return calc
    e0 = abs(fv - calc)
    e1 = abs(fv / 100.0 - calc)
    if e0 <= e1 and e0 < 0.35:
        return fv
    if e1 < 0.35:
        return fv / 100.0
    return calc


def _eastmoney_integer_tick_prices(f43f: float, f60f: float) -> bool:
    return (
        f43f >= 100.0
        and f60f >= 100.0
        and abs(f43f - round(f43f)) < 1e-6
        and abs(f60f - round(f60f)) < 1e-6
    )


def _eastmoney_parse_tick(
    d: dict, symbol: str, suggest_name: str | None
) -> dict | None:
    f43, f60, f170, f152 = d.get("f43"), d.get("f60"), d.get("f170"), d.get("f152")
    if f43 in (None, "-", "--", "") or f60 in (None, "-", "--", ""):
        return None
    try:
        f43f = float(f43)
        f60f = float(f60)
    except (TypeError, ValueError):
        return None
    if f60f == 0:
        return None
    if _eastmoney_integer_tick_prices(f43f, f60f):
        div = _eastmoney_tick_divisor(f43f, f152) or _eastmoney_pick_divisor(f43f, f60f, f170)
        last = f43f / div
        prev = f60f / div
    else:
        last = f43f
        prev = f60f
    ch = last - prev
    pct = _eastmoney_resolve_change_pct(f170, last, prev)
    name = d.get("f58") or suggest_name
    code = str(d.get("f57") or symbol).strip().upper()
    return {
        "symbol": code,
        "name": name,
        "lastPrice": round(last, 4),
        "previousClose": round(prev, 4),
        "change": round(ch, 4),
        "changePercent": round(pct, 4),
        "currency": "USD",
        "error": None,
    }


def _quote_eastmoney(symbol: str) -> dict:
    secid, suggest_name, s_err = _eastmoney_resolve_secid(symbol)
    if not secid:
        return _quote_error(
            symbol,
            (s_err or "东方财富无法解析代码")
            + "。可检查本机能否访问 quote.eastmoney.com；或在 .env 设置 HTTPS_PROXY 后重启 uvicorn。",
        )
    q = _eastmoney_qt_stock_get_query(secid, "f43,f57,f58,f60,f170,f152")
    url = f"https://push2.eastmoney.com/api/qt/stock/get?{q}"
    data, err = _http_json(url, extra_headers=_EASTMONEY_HTTP_EXTRA)
    if not data or err:
        url2 = f"https://push2delay.eastmoney.com/api/qt/stock/get?{q}"
        data, err = _http_json(url2, extra_headers=_EASTMONEY_HTTP_EXTRA)
    if not data:
        return _quote_error(symbol, f"东方财富行情失败: {err or '未知'}")
    if not _eastmoney_rc_ok(data):
        return _quote_error(symbol, f"东方财富 rc={data.get('rc')} 无行情")
    d = data.get("data")
    if not isinstance(d, dict):
        return _quote_error(symbol, "东方财富返回空 data")
    parsed = _eastmoney_parse_tick(d, symbol, suggest_name)
    if not parsed:
        return _quote_error(symbol, "东方财富暂无有效价（停牌或未开盘数据）")
    return parsed


def _eastmoney_batch_fetch(
    secid_rows: list[tuple[str, str, str | None]],
) -> dict[str, dict]:
    """批量拉行情，返回 symbol -> quote dict（仅成功项）。"""
    if not secid_rows:
        return {}
    fields = "f43,f57,f58,f60,f170,f152"
    out: dict[str, dict] = {}
    chunk_size = 6
    for i in range(0, len(secid_rows), chunk_size):
        chunk = secid_rows[i : i + chunk_size]
        secids = ",".join(secid for _, secid, _ in chunk)
        by_code = {sym.upper(): (sym, suggest) for sym, _, suggest in chunk}
        q = urllib.parse.urlencode(
            {
                "fltt": 2,
                "invt": 2,
                "fields": fields,
                "secids": secids,
                "ut": _EASTMONEY_UT,
            }
        )
        data: dict | None = None
        err: str | None = None
        for host in ("push2.eastmoney.com", "push2delay.eastmoney.com"):
            url = f"https://{host}/api/qt/ulist.np/get?{q}"
            data, err = _http_json(url, extra_headers=_EASTMONEY_HTTP_EXTRA)
            if data and _eastmoney_rc_ok(data):
                break
        if not data or not _eastmoney_rc_ok(data):
            continue
        diff = (data.get("data") or {}).get("diff") or []
        if not isinstance(diff, list):
            continue
        for item in diff:
            if not isinstance(item, dict):
                continue
            code = str(item.get("f57") or "").strip().upper()
            if not code:
                continue
            row = by_code.get(code)
            if not row:
                continue
            sym, suggest = row
            parsed = _eastmoney_parse_tick(item, sym, suggest)
            if parsed:
                out[sym.upper()] = parsed
    return out


def _quotes_eastmoney_parallel(symbols: list[str]) -> list[dict]:
    n = len(symbols)
    if n == 0:
        return []
    secid_rows: list[tuple[str, str, str | None]] = []
    resolve_errors: dict[str, dict] = {}
    for sym in symbols:
        secid, suggest_name, s_err = _eastmoney_resolve_secid(sym)
        if not secid:
            resolve_errors[sym.upper()] = _quote_error(
                sym,
                (s_err or "东方财富无法解析代码")
                + "。可检查网络或稍后点刷新重试。",
            )
        else:
            secid_rows.append((sym, secid, suggest_name))

    out_map: dict[str, dict] = dict(resolve_errors)
    batch_hits = _eastmoney_batch_fetch(secid_rows)
    out_map.update(batch_hits)

    pending = [
        sym
        for sym, secid, _ in secid_rows
        if sym.upper() not in out_map or out_map[sym.upper()].get("error")
    ]
    if pending:
        workers = min(3, len(pending))

        def work(sym: str) -> tuple[str, dict]:
            return sym, _quote_eastmoney(sym)

        with ThreadPoolExecutor(max_workers=workers) as pool:
            futs = [pool.submit(work, s) for s in pending]
            for fut in as_completed(futs):
                sym, row = fut.result()
                out_map[sym.upper()] = row

    return [out_map.get(s.upper(), _quote_error(s, "行情未返回")) for s in symbols]


def _quotes_finnhub_parallel(symbols: list[str], token: str) -> list[dict]:
    n = len(symbols)
    if n == 0:
        return []
    workers = min(12, n)

    def work(sym: str) -> tuple[str, dict]:
        return sym, _quote_finnhub(sym, token)

    out_map: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = [pool.submit(work, s) for s in symbols]
        for fut in as_completed(futs):
            sym, row = fut.result()
            out_map[sym.upper()] = row
    return [out_map[s.upper()] for s in symbols]


def _quote_one(symbol: str, yahoo_map: dict[str, dict] | None) -> dict:
    if yahoo_map and symbol.upper() in yahoo_map:
        return yahoo_map[symbol.upper()]
    return _quote_yfinance(symbol)


def _quote_single_for_context(symbol: str) -> dict:
    sym = _normalize_symbol(symbol)
    mode = _quote_provider_mode()
    token = _finnhub_api_key()
    if mode == "eastmoney":
        return _quote_eastmoney(sym)
    if mode == "finnhub":
        if not token:
            return _quote_error(sym, "QUOTE_PROVIDER=finnhub 但未配置 FINNHUB_API_KEY")
        return _quotes_finnhub_parallel([sym], token)[0]
    if mode == "yahoo":
        ymap = _yahoo_v7_quote_map([sym])
        return _quote_one(sym, ymap)
    if token:
        return _quotes_finnhub_parallel([sym], token)[0]
    return _quote_eastmoney(sym)


_SYMBOL_STOP = frozenset(
    {
        "A",
        "I",
        "AI",
        "US",
        "UK",
        "EU",
        "OK",
        "ETF",
        "IPO",
        "SEC",
        "EPS",
        "PE",
        "PB",
        "PS",
        "RSI",
        "MACD",
        "CEO",
        "CFO",
        "CTO",
        "GDP",
        "USD",
        "CNY",
        "HK",
        "NYSE",
        "API",
        "Q1",
        "Q2",
        "Q3",
        "Q4",
        "FY",
        "YOY",
        "MOM",
        "EBIT",
        "ROE",
        "ROA",
        "DCF",
        "ATH",
        "ATL",
        "MA",
        "EMA",
        "SMA",
        "ATR",
        "IV",
        "OI",
        "PM",
        "AM",
        "AND",
        "OR",
        "THE",
        "FOR",
        "TO",
        "IN",
        "ON",
        "AT",
        "IS",
        "IT",
        "IF",
        "AS",
        "BE",
        "AN",
        "OF",
        "BY",
    }
)


def _detect_symbols_for_ai(message: str, explicit: str | None) -> list[str]:
    found: list[str] = []
    seen: set[str] = set()
    if explicit and str(explicit).strip():
        try:
            s = _normalize_symbol(str(explicit).strip())
            seen.add(s)
            found.append(s)
        except HTTPException:
            pass
    for m in re.finditer(r"(?i)\b([a-z][a-z0-9]{0,9}(?:\.[a-z]{1,2})?)\b", message):
        raw = m.group(1).upper()
        if raw in _SYMBOL_STOP or not SYMBOL_PATTERN.match(raw):
            continue
        if raw in seen:
            continue
        seen.add(raw)
        found.append(raw)
    return found[:3]


def _compute_rsi(closes: list[float], period: int = 14) -> float | None:
    if len(closes) < period + 1:
        return None
    avg_gain = 0.0
    avg_loss = 0.0
    for i in range(1, period + 1):
        d = closes[i] - closes[i - 1]
        avg_gain += d if d > 0 else 0.0
        avg_loss += -d if d < 0 else 0.0
    avg_gain /= period
    avg_loss /= period
    for i in range(period + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        gain = d if d > 0 else 0.0
        loss = -d if d < 0 else 0.0
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return round(100.0 - 100.0 / (1.0 + rs), 2)


def _yf_daily_context(symbol: str) -> dict:
    out: dict = {"source": "yfinance", "symbol": symbol}
    try:
        t = yf.Ticker(symbol)
        hist = t.history(period="6mo", interval="1d", auto_adjust=True)
        if hist.empty:
            out["error"] = "日线不可用"
            return out
        hist = hist.tail(60)
        closes = [round(float(x), 4) for x in hist["Close"].tolist()]
        dates = [d.strftime("%Y-%m-%d") for d in hist.index]
        rsi = _compute_rsi(closes)
        last_n = min(10, len(hist))
        bars: list[dict] = []
        for i in range(len(hist) - last_n, len(hist)):
            row = hist.iloc[i]
            vol = row["Volume"]
            bars.append(
                {
                    "date": dates[i],
                    "open": round(float(row["Open"]), 4),
                    "high": round(float(row["High"]), 4),
                    "low": round(float(row["Low"]), 4),
                    "close": round(float(row["Close"]), 4),
                    "volume": int(vol) if vol == vol else None,
                }
            )
        out["lastBarDate"] = dates[-1]
        out["recentDailyBars"] = bars
        tech: dict = {"rsi14": rsi, "closeOnLastBar": closes[-1]}
        if closes:
            tech["range60dLow"] = round(min(closes), 4)
            tech["range60dHigh"] = round(max(closes), 4)
        out["technicals"] = tech
        try:
            info = t.info or {}
        except Exception:
            info = {}
        if info:
            fin: dict = {}
            for k in (
                "trailingPE",
                "forwardPE",
                "priceToBook",
                "marketCap",
                "fiftyTwoWeekHigh",
                "fiftyTwoWeekLow",
                "beta",
                "trailingEps",
                "forwardEps",
                "dividendYield",
            ):
                v = info.get(k)
                if v is not None:
                    fin[k] = v
            ets = info.get("earningsTimestamp")
            if ets is not None:
                try:
                    fin["earningsTimestampUtc"] = datetime.fromtimestamp(
                        int(ets), tz=timezone.utc
                    ).isoformat(timespec="seconds")
                except (TypeError, ValueError, OSError):
                    pass
            if fin:
                out["yahooInfoSnapshot"] = fin
    except Exception as exc:
        out["error"] = str(exc)
    return out


def _finnhub_earnings_context(symbol: str, token: str) -> dict:
    now = datetime.now(timezone.utc)
    start = (now.date() - timedelta(days=400)).isoformat()
    end = (now.date() + timedelta(days=120)).isoformat()
    sym_q = urllib.parse.quote(symbol)
    tok_q = urllib.parse.quote(token)
    url = (
        f"https://finnhub.io/api/v1/calendar/earnings"
        f"?from={start}&to={end}&symbol={sym_q}&token={tok_q}"
    )
    jd, err = _http_json(url)
    if not jd or not isinstance(jd, dict):
        return {"source": "finnhub", "error": err or "earnings 不可用"}
    rows = jd.get("earningsCalendar") or []
    if not isinstance(rows, list):
        rows = []
    sym_u = symbol.upper()
    picked: list[dict] = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        if str(r.get("symbol", "")).upper() != sym_u:
            continue
        picked.append(
            {
                "date": r.get("date"),
                "epsActual": r.get("epsActual"),
                "epsEstimate": r.get("epsEstimate"),
                "revenueActual": r.get("revenueActual"),
                "revenueEstimate": r.get("revenueEstimate"),
                "quarter": r.get("quarter"),
                "year": r.get("year"),
            }
        )
        if len(picked) >= 8:
            break
    return {"source": "finnhub", "earningsCalendar": picked}


def _market_data_bundle(symbol: str) -> dict:
    sym = _normalize_symbol(symbol)
    labels = _server_now_labels()
    bundle: dict = {
        "symbol": sym,
        "dataAsOf": labels,
        "quoteFromApp": _quote_single_for_context(sym),
        "marketSeries": _yf_daily_context(sym),
    }
    token = _finnhub_api_key()
    if token:
        bundle["earningsFromFinnhub"] = _finnhub_earnings_context(sym, token)
    return bundle


def _build_ai_user_content(message: str, explicit_symbol: str | None) -> str:
    symbols = _detect_symbols_for_ai(message, explicit_symbol)
    labels = _server_now_labels()
    envelope: dict = {
        "instruction": (
            "本 JSON 由服务端在本次请求时自动抓取，是唯一可用于具体价位、涨跌幅、"
            "RSI、财报日程的事实来源；不得用训练记忆补全或改写其中日期与数值。"
        ),
        "serverTime": labels,
        "symbols": symbols,
        "marketData": [_market_data_bundle(s) for s in symbols],
    }
    if not symbols:
        envelope["note"] = (
            "未识别到美股代码；不得编造任何标的的现价、RSI 或财报日，"
            "须写「本服务本次未注入行情包」。"
        )
    return (
        "【服务端自动生成 · 决策数据包 · 必须以此为准】\n"
        + json.dumps(envelope, ensure_ascii=False, indent=2)
        + "\n\n【用户问题】\n"
        + message
    )


def _call_llm_chat(user_content: str, system_content: str | None = None) -> str:
    api_key = _llm_api_key()
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail=(
                "未配置大模型密钥：请在 backend/.env 设置 DASHSCOPE_API_KEY（通义千问/百炼 OpenAI 兼容），"
                "或 OPENAI_API_KEY 后重启 uvicorn。"
            ),
        )
    url = f"{_llm_base_url()}/chat/completions"
    model = _llm_model()
    payload: dict = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_content or _llm_system_content()},
            {"role": "user", "content": user_content},
        ],
        "temperature": 0.35,
        "max_tokens": 4500,
    }
    if _llm_enable_web_search():
        payload["enable_search"] = True
        payload["search_options"] = _llm_search_options()
    extra_h = {"Authorization": f"Bearer {api_key}"}
    timeout = 180.0 if _llm_enable_web_search() else 120.0
    data, err = _http_post_json(url, payload, extra_headers=extra_h, timeout=timeout)
    if err or not data:
        raise HTTPException(status_code=502, detail=f"大模型接口失败: {err or '未知错误'}")
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        raise HTTPException(status_code=502, detail="大模型返回无 choices 字段")
    ch0 = choices[0]
    if not isinstance(ch0, dict):
        raise HTTPException(status_code=502, detail="大模型返回格式异常")
    msg0 = ch0.get("message")
    if not isinstance(msg0, dict):
        raise HTTPException(status_code=502, detail="大模型返回格式异常")
    content = msg0.get("content")
    if not isinstance(content, str) or not content.strip():
        raise HTTPException(status_code=502, detail="大模型返回空内容")
    return content.strip()


def _parse_stance(text: str) -> str | None:
    m = re.search(
        r"投资立场[：:]\s*(增持|持有|观望|减仓|调出)",
        text,
    )
    if not m:
        return None
    v = m.group(1)
    return v if v in STANCE_VALUES else None


def _parse_key_risk(text: str) -> str | None:
    m = re.search(r"主要风险[：:]\s*(.+?)(?:\n|$)", text)
    if not m:
        return None
    s = m.group(1).strip()
    return s[:200] if s else None


def _parse_buy_score(text: str) -> float | None:
    patterns = (
        r"买入推荐评分[：:]\s*(\d{1,2}(?:\.\d)?)\s*/?\s*10",
        r"买入评分[：:]\s*(\d{1,2}(?:\.\d)?)\s*/?\s*10",
        r"推荐买入[：:]\s*(\d{1,2}(?:\.\d)?)\s*/?\s*10",
        r"BUY_SCORE[：:]\s*(\d{1,2}(?:\.\d)?)",
    )
    for pat in patterns:
        m = re.search(pat, text, re.IGNORECASE)
        if not m:
            continue
        try:
            n = float(m.group(1))
        except (TypeError, ValueError):
            continue
        if 1.0 <= n <= 10.0:
            return round(n, 1)
    return None


def _try_parse_json_object(text: str) -> dict | None:
    raw = text.strip()
    if not raw:
        return None
    try:
        obj = json.loads(raw)
        return obj if isinstance(obj, dict) else None
    except json.JSONDecodeError:
        pass
    m = re.search(r"\{[\s\S]*\}", raw)
    if not m:
        return None
    try:
        obj = json.loads(m.group(0))
        return obj if isinstance(obj, dict) else None
    except json.JSONDecodeError:
        return None


def _build_portfolio_curate_user_content(
    symbols: list[str],
    reports: list[WatchlistRankReportInput],
    top_k: int,
) -> str:
    labels = _server_now_labels()
    by_sym = {_normalize_symbol(r.symbol): r for r in reports}
    report_rows = []
    for sym in symbols:
        row = by_sym.get(sym)
        report_rows.append(
            {
                "symbol": sym,
                "analystAgent": {
                    "singleBuyScore": row.singleBuyScore if row else None,
                    "stance": row.stance if row else None,
                    "keyRisk": row.keyRisk if row else None,
                    "conclusionSummary": (row.summary if row else "").strip()
                    or "（无单股报告摘要）",
                },
            }
        )
    envelope: dict = {
        "agentRole": "portfolio_curator",
        "instruction": (
            "基于各股 analystAgent 摘要与全池 marketData，输出购买优先级 JSON；"
            f"topPicks 长度 {top_k}；须含 reduceOrExit 与 portfolioRisks。"
        ),
        "serverTime": labels,
        "topK": top_k,
        "symbols": symbols,
        "marketData": [_market_data_bundle(s) for s in symbols],
        "analystReports": report_rows,
    }
    return (
        "【Portfolio Curator Agent · 组合优选数据包】\n"
        + json.dumps(envelope, ensure_ascii=False, indent=2)
        + f"\n\n请输出 JSON：全池 {len(symbols)} 只的 ranked、top {top_k} topPicks、reduceOrExit、portfolioRisks、summary。"
    )


def _parse_portfolio_curate_response(
    text: str, symbols: list[str], top_k: int
) -> dict:
    obj = _try_parse_json_object(text)
    if not obj:
        raise HTTPException(
            status_code=502,
            detail="大模型未返回可解析的 JSON 排名结果",
        )
    ranked_raw = obj.get("ranked")
    if not isinstance(ranked_raw, list) or not ranked_raw:
        raise HTTPException(status_code=502, detail="排名 JSON 缺少 ranked 数组")

    sym_set = set(symbols)
    seen_syms: set[str] = set()
    ranked: list[dict] = []
    scores: list[float] = []

    for item in ranked_raw:
        if not isinstance(item, dict):
            continue
        try:
            sym = _normalize_symbol(str(item.get("symbol", "")))
        except HTTPException:
            continue
        if sym not in sym_set or sym in seen_syms:
            continue
        try:
            score = round(float(item.get("relativeScore")), 1)
        except (TypeError, ValueError):
            continue
        if not (1.0 <= score <= 10.0):
            continue
        try:
            rank = int(item.get("rank"))
        except (TypeError, ValueError):
            rank = len(ranked) + 1
        compare_reason = str(
            item.get("compareReason") or item.get("reason") or ""
        ).strip()[:500]
        reason = str(item.get("reason") or compare_reason).strip()[:120]
        if not compare_reason:
            compare_reason = reason
        stance_raw = str(item.get("stance") or "持有").strip()
        stance = stance_raw if stance_raw in STANCE_VALUES else "持有"
        seen_syms.add(sym)
        scores.append(score)
        ranked.append(
            {
                "symbol": sym,
                "rank": rank,
                "relativeScore": score,
                "stance": stance,
                "reason": reason,
                "compareReason": compare_reason,
            }
        )

    missing = sym_set - seen_syms
    if missing:
        raise HTTPException(
            status_code=502,
            detail=f"排名结果未覆盖全部标的，缺少: {', '.join(sorted(missing))}",
        )
    if len(scores) != len(set(scores)):
        raise HTTPException(
            status_code=502,
            detail="相对评分存在重复，请重试组合优选",
        )

    ranked.sort(key=lambda x: (x["rank"], -x["relativeScore"]))
    for i, row in enumerate(ranked, start=1):
        row["rank"] = i

    top_raw = obj.get("topPicks")
    top_picks: list[str] = []
    if isinstance(top_raw, list):
        for raw in top_raw[:top_k]:
            try:
                sym = _normalize_symbol(str(raw))
            except HTTPException:
                continue
            if sym in sym_set and sym not in top_picks:
                top_picks.append(sym)
    if len(top_picks) < top_k:
        by_score = sorted(ranked, key=lambda x: -x["relativeScore"])
        for row in by_score:
            if row["symbol"] not in top_picks:
                top_picks.append(row["symbol"])
            if len(top_picks) >= top_k:
                break

    summary = str(obj.get("summary") or "").strip()
    if not summary:
        summary = "已完成自选池横向比较；不构成投资建议。"

    horizontal_comparison = str(obj.get("horizontalComparison") or "").strip()[:2000]
    conclusion = str(obj.get("conclusion") or "").strip()[:800]
    if not conclusion:
        conclusion = summary
    top_picks_rationale = str(obj.get("topPicksRationale") or "").strip()[:600]

    reduce_or_exit: list[dict] = []
    ro_raw = obj.get("reduceOrExit")
    if isinstance(ro_raw, list):
        for item in ro_raw:
            if not isinstance(item, dict):
                continue
            try:
                sym = _normalize_symbol(str(item.get("symbol", "")))
            except HTTPException:
                continue
            if sym not in sym_set:
                continue
            action = str(item.get("action") or "观望").strip()
            if action not in REDUCE_ACTION_VALUES:
                action = "观望"
            reason = str(item.get("reason") or "").strip()[:120]
            if not reason:
                continue
            reduce_or_exit.append(
                {"symbol": sym, "action": action, "reason": reason}
            )

    portfolio_risks: list[str] = []
    pr_raw = obj.get("portfolioRisks")
    if isinstance(pr_raw, list):
        for x in pr_raw:
            s = str(x).strip()
            if s:
                portfolio_risks.append(s[:200])
    portfolio_risks = portfolio_risks[:8]

    return {
        "ranked": ranked,
        "topPicks": top_picks[:top_k],
        "topPicksRationale": top_picks_rationale,
        "horizontalComparison": horizontal_comparison,
        "conclusion": conclusion,
        "reduceOrExit": reduce_or_exit,
        "portfolioRisks": portfolio_risks,
        "summary": summary,
    }


@app.get("/api/health")
def health():
    key = _finnhub_api_key()
    return {
        "ok": True,
        "finnhub_configured": bool(key),
        "llm_configured": bool(_llm_api_key()),
        "openai_configured": bool(_llm_api_key()),
        "llm_web_search": _llm_enable_web_search() and bool(_llm_api_key()),
        "llm_provider": _llm_provider_tag(),
        "quote_provider": _health_quote_provider_label(),
        "quote_provider_mode": _quote_provider_mode(),
    }


@app.get("/api/symbols/search")
def search_symbols(q: str = ""):
    return {"results": _eastmoney_search_us(q)}


@app.get("/api/watchlist")
def get_watchlist():
    return {"symbols": _read_watchlist()}


@app.put("/api/watchlist")
def put_watchlist(body: WatchlistPayload):
    symbols: list[str] = []
    seen: set[str] = set()
    for raw in body.symbols:
        sym = _normalize_symbol(raw)
        if sym not in seen:
            seen.add(sym)
            symbols.append(sym)
    _write_watchlist(symbols)
    return {"symbols": symbols}


@app.post("/api/watchlist/symbol")
def add_symbol(body: AddSymbolBody):
    sym = _normalize_symbol(body.symbol)
    current = _read_watchlist()
    if sym not in current:
        current.append(sym)
        _write_watchlist(current)
    return {"symbols": current}


@app.delete("/api/watchlist/symbol/{symbol}")
def remove_symbol(symbol: str):
    sym = _normalize_symbol(symbol)
    current = [s for s in _read_watchlist() if s != sym]
    _write_watchlist(current)
    return {"symbols": current}


@app.get("/api/quotes")
def get_quotes():
    symbols = _read_watchlist()
    if not symbols:
        return {"quotes": []}
    mode = _quote_provider_mode()
    token = _finnhub_api_key()
    if mode == "eastmoney":
        return {"quotes": _quotes_eastmoney_parallel(symbols)}
    if mode == "finnhub":
        if not token:
            return {
                "quotes": [
                    _quote_error(s, "QUOTE_PROVIDER=finnhub 但未配置 FINNHUB_API_KEY")
                    for s in symbols
                ]
            }
        return {"quotes": _quotes_finnhub_parallel(symbols, token)}
    if mode == "yahoo":
        ymap = _yahoo_v7_quote_map(symbols)
        return {"quotes": [_quote_one(s, ymap) for s in symbols]}
    if token:
        return {"quotes": _quotes_finnhub_parallel(symbols, token)}
    return {"quotes": _quotes_eastmoney_parallel(symbols)}


@app.post("/api/ai/chat")
def ai_chat(body: AiChatBody):
    text = body.message.strip()
    if not text:
        raise HTTPException(status_code=400, detail="消息不能为空")
    user_content = _build_ai_user_content(text, body.symbol)
    reply = _call_llm_chat(user_content)
    labels = _server_now_labels()
    return {
        "reply": reply,
        "analyzedAt": labels["beijing"],
        "buyScore": _parse_buy_score(reply),
    }


@app.post("/api/ai/watchlist/rank")
def ai_watchlist_rank(body: WatchlistRankBody):
    if body.symbols:
        symbols: list[str] = []
        seen: set[str] = set()
        for raw in body.symbols:
            sym = _normalize_symbol(raw)
            if sym not in seen:
                seen.add(sym)
                symbols.append(sym)
    else:
        symbols = _read_watchlist()

    if len(symbols) < 2:
        raise HTTPException(
            status_code=400,
            detail="组合优选至少需要 2 只自选标的",
        )
    if len(symbols) > 24:
        raise HTTPException(
            status_code=400,
            detail="单次组合优选最多 24 只标的",
        )

    sym_set = set(symbols)
    report_map: dict[str, WatchlistRankReportInput] = {}
    for r in body.reports:
        sym = _normalize_symbol(r.symbol)
        if sym in sym_set:
            report_map[sym] = r

    missing_reports = [s for s in symbols if s not in report_map]
    if missing_reports:
        raise HTTPException(
            status_code=400,
            detail=(
                "请先对以下标的完成今日单股 AI 分析后再做组合优选："
                + ", ".join(missing_reports)
            ),
        )

    top_k = min(body.topK, len(symbols))
    user_content = _build_portfolio_curate_user_content(symbols, body.reports, top_k)
    reply = _call_llm_chat(user_content, PORTFOLIO_CURATOR_SYSTEM_PROMPT)
    labels = _server_now_labels()
    parsed = _parse_portfolio_curate_response(reply, symbols, top_k)
    return {
        "agent": "portfolio_curator",
        "rankedAt": labels["beijing"],
        "rankedAtUtc": labels["utc"],
        "topK": top_k,
        "symbols": symbols,
        **parsed,
        "rawReply": reply,
    }


@app.post("/api/ai/analyze/{symbol}")
def ai_analyze_symbol(symbol: str):
    sym = _normalize_symbol(symbol)
    message = (
        f"请对标的 {sym} 撰写完整的投资分析报告（基本面与技术面均衡），"
        "用于当前时点的投资决策参考；结论须含报告生成时间与买入推荐评分。"
    )
    user_content = _build_ai_user_content(message, sym)
    reply = _call_llm_chat(user_content)
    labels = _server_now_labels()
    return {
        "symbol": sym,
        "reply": reply,
        "analyzedAt": labels["beijing"],
        "analyzedAtUtc": labels["utc"],
        "buyScore": _parse_buy_score(reply),
        "stance": _parse_stance(reply),
        "keyRisk": _parse_key_risk(reply),
    }


@app.post("/api/ai/portfolio/curate")
def ai_portfolio_curate(body: WatchlistRankBody):
    """与 /api/ai/watchlist/rank 相同：组合优选专员 Agent。"""
    return ai_watchlist_rank(body)


def _no_frontend_page() -> HTMLResponse:
    return HTMLResponse(
        content="""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"/><title>stock_investment_agent</title></head>
<body style="font-family:system-ui,sans-serif;padding:1.5rem;line-height:1.6;max-width:42rem">
<h1>根路径暂无页面</h1>
<p><code>8000</code> 上是 <strong>FastAPI</strong>：接口都在 <code>/api/...</code> 下，未注册 <code>GET /</code> 时浏览器会显示 JSON，例如 <code>{"detail":"Not Found"}</code>。</p>
<p>若希望<strong>直接打开</strong> <a href="/">http://127.0.0.1:8000/</a> 看到自选股界面，请先构建前端再重启 uvicorn：</p>
<pre style="background:#f0f0f0;padding:0.75rem;overflow:auto">cd frontend && npm install && npm run build</pre>
<p>构建完成后本服务会托管 <code>frontend/dist</code>。开发时也可继续用 Vite：<code>http://127.0.0.1:5173</code>。</p>
<p>接口示例：<a href="/api/health">/api/health</a></p>
</body></html>""",
        status_code=200,
    )


if FRONTEND_DIST.is_dir():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="frontend")
else:

    @app.get("/")
    def root_placeholder():
        return _no_frontend_page()
