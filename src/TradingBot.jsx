import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  AreaChart, Area, LineChart, Line,
  XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine
} from "recharts";
import {
  Play, Square, TrendingUp, TrendingDown, Zap,
  Shield, BarChart2, FileText, Settings,
  Wifi, WifiOff, Lock, LogIn, LogOut, RefreshCw,
  User, X, AlertTriangle, Volume2, VolumeX,
  Phone, ArrowUp, ArrowDown
} from "lucide-react";

// ═══════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════
const PRICE_MIN   = 4800;
const PRICE_MAX   = 5800;
const SPREAD      = 0.30;
const FINNHUB_KEY = "demo"; // replace with your finnhub.io key

// Supabase Edge Function (paste your anon key from Supabase → Settings → API → anon public)
const SUPABASE_FUNC_URL = "https://jldfajiptsxpjyckpgjd.functions.supabase.co/mt5-bridge";
const SUPABASE_ANON_KEY = ""; // paste your anon public key here (long eyJ... string)

// ═══════════════════════════════════════
//  MATH ENGINE
// ═══════════════════════════════════════
const emaArr = (arr, p) => {
  const k = 2 / (p + 1);
  return arr.reduce((acc, v, i) => {
    acc.push(i === 0 ? v : v * k + acc[i - 1] * (1 - k));
    return acc;
  }, []);
};
const calcRSI = (closes, p = 14) => {
  if (closes.length < p + 1) return 50;
  let g = 0, l = 0;
  for (let i = closes.length - p; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    d > 0 ? (g += d) : (l -= d);
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + (g / p) / (l / p));
};
const calcBB = (closes, p = 20, m = 2) => {
  const sl = closes.slice(-p);
  if (sl.length < p) { const c = closes[closes.length - 1]; return { u: c + 30, mid: c, l: c - 30 }; }
  const mean = sl.reduce((a, b) => a + b, 0) / p;
  const std = Math.sqrt(sl.reduce((a, b) => a + (b - mean) ** 2, 0) / p);
  return { u: mean + m * std, mid: mean, l: mean - m * std };
};
const calcATR = (candles, p = 14) => {
  const sl = candles.slice(-p);
  if (sl.length < 2) return 15;
  const trs = sl.map((c, i, a) => {
    if (i === 0) return c.h - c.l;
    return Math.max(c.h - c.l, Math.abs(c.h - a[i-1].c), Math.abs(c.l - a[i-1].c));
  });
  return trs.reduce((a, b) => a + b, 0) / trs.length;
};
const calcADX = (candles, p = 14) => {
  if (candles.length < p + 2) return 20;
  const sl = candles.slice(-(p + 1));
  let pDM = 0, mDM = 0, tR = 0;
  for (let i = 1; i < sl.length; i++) {
    const c = sl[i], pv = sl[i - 1];
    const up = c.h - pv.h, dn = pv.l - c.l;
    pDM += up > dn && up > 0 ? up : 0;
    mDM += dn > up && dn > 0 ? dn : 0;
    tR  += Math.max(c.h - c.l, Math.abs(c.h - pv.c), Math.abs(c.l - pv.c));
  }
  if (tR === 0) return 20;
  const s = 100 * pDM / tR + 100 * mDM / tR;
  return s === 0 ? 20 : 100 * Math.abs(100 * pDM / tR - 100 * mDM / tR) / s;
};
const genCandles = (base = 5160, n = 120) => {
  let p = base, trend = 0;
  return Array.from({ length: n }, (_, i) => {
    const rev = (base - p) * 0.003;
    trend = trend * 0.94 + (Math.random() - 0.5) * 0.15;
    const ch = trend * 8 + rev + (Math.random() - 0.5) * 12;
    const o = p, c = Math.max(PRICE_MIN, Math.min(PRICE_MAX, p + ch));
    const hl = Math.random() * 5 + Math.abs(ch) * 0.4;
    p = c;
    return { o, h: Math.max(o, c) + hl, l: Math.min(o, c) - hl, c, t: i };
  });
};

// ═══════════════════════════════════════
//  SOUND ENGINE
// ═══════════════════════════════════════
const playTone = (freq, dur, type = "sine", vol = 0.3) => {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = type; osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    osc.start(); osc.stop(ctx.currentTime + dur);
  } catch {}
};
const sounds = {
  signal : () => { playTone(880, 0.15); setTimeout(() => playTone(1100, 0.2), 160); },
  win    : () => { playTone(660, 0.1); setTimeout(() => playTone(880, 0.1), 120); setTimeout(() => playTone(1320, 0.25), 240); },
  loss   : () => { playTone(330, 0.1); setTimeout(() => playTone(220, 0.3), 130); },
  connect: () => { playTone(440, 0.1); setTimeout(() => playTone(660, 0.15), 120); },
  alert  : () => playTone(550, 0.3, "square", 0.2),
};

// ═══════════════════════════════════════
//  COLORS
// ═══════════════════════════════════════
const C = {
  bg: '#06080f', panel: '#0d1220', panel2: '#111827',
  border: '#1a2840', gold: '#D4AF37', goldBright: '#F4C430',
  green: '#00C896', red: '#FF4050', blue: '#60A5FA',
  purple: '#A78BFA', amber: '#F59E0B', text: '#c8d8f0',
  dim: '#4a5a7a', dimmer: '#2a3a52',
};

// ═══════════════════════════════════════
//  MAIN COMPONENT
// ═══════════════════════════════════════
export default function XAUUSDBot() {
  // ─── NEWS ───
  const [news, setNews] = useState([]);
  const [newsLoading, setNewsLoading] = useState(false);

  // ─── REAL BASE PRICE (from broker or default) ───
  const [realBase]                = useState(5160);
  const initCandles = useMemo(() => genCandles(realBase), [realBase]);

  // ─── PRICE ───
  const [candles, setCandles]       = useState(() => genCandles(5160));
  const [price, setPrice]           = useState(5160);
  const [priceDir, setPriceDir]     = useState(0);
  const [priceSource, setPriceSource] = useState("simulation");

  // ─── BOT STATE ───
  const [initialBalance, setInitialBalance] = useState(100); // syncs from MT5
  const [equity, setEquity]         = useState(100);
  const [peakEq, setPeakEq]         = useState(100);
  const [eqHistory, setEqHistory]   = useState([{ t: 0, v: 100 }]);
  const [openTrades, setOpenTrades] = useState([]);
  const [closedTrades, setClosedTrades] = useState([]);
  const [ind, setInd]               = useState({});
  const [regime, setRegime]         = useState("SCANNING");
  const [lastSignal, setLastSignal] = useState(null);
  const [running, setRunning]       = useState(false);
  const [tab, setTab]               = useState("overview");
  const [tick, setTick]             = useState(0);
  const [stats, setStats]           = useState({ wins: 0, losses: 0, totalPnL: 0 });
  const [settings, setSettings]     = useState({ risk: 2, maxDD: 15, trend: true, meanRev: true, bridgeUrl: "ws://localhost:8000/ws", preset: "balanced" });
  const [circuitBreaker, setCircuitBreaker] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);

  // ─── BROKER ───
  const [brokerLogin, setBrokerLogin] = useState({ login: "", password: "", server: "Exness-MT5Trial6" });
  const [brokerConnected, setBrokerConnected] = useState(false);
  const [brokerConnecting, setBrokerConnecting] = useState(false);
  const [brokerAccount, setBrokerAccount] = useState(null);
  const [showLoginPanel, setShowLoginPanel] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [mt5Trades, setMt5Trades]   = useState([]);
  const [mt5History, setMt5History] = useState([]);
  const [bridgePing, setBridgePing] = useState(null);
  const [reconnectCount, setReconnectCount] = useState(0);

  // ─── MANUAL TRADE ───
  const [showManualTrade, setShowManualTrade] = useState(false);
  const [manualSL, setManualSL]   = useState("");
  const [manualTP, setManualTP]   = useState("");
  const [manualVol, setManualVol] = useState("0.01");

  // ─── ALERTS ───
  const [alerts, setAlerts] = useState([]);

  // ─── LOGS ───
  const [logs, setLogs] = useState([
    { id: 1, time: new Date().toLocaleTimeString(), msg: "XAUBot v7.0 ready. Connect broker or run simulation.", type: "info" }
  ]);

  const ref      = useRef({});
  const wsRef    = useRef(null);
  const finnRef  = useRef(null);
  const tradeId  = useRef(0);
  const reconnectTimer = useRef(null);
  const pingTimer = useRef(null);
  const pingStart = useRef(null);

  useEffect(() => {
    ref.current = { candles, equity, peakEq, openTrades, closedTrades, stats, tick, eqHistory, settings, price, circuitBreaker, initialBalance, soundEnabled, brokerConnected };
  });

  const playSound = useCallback((name) => {
    if (ref.current.soundEnabled) sounds[name]?.();
  }, []);

  const addLog = useCallback((msg, type = "info") => {
    setLogs(p => [{ id: Date.now() + Math.random(), time: new Date().toLocaleTimeString(), msg, type }, ...p].slice(0, 500));
  }, []);

  const addAlert = useCallback((msg, type = "warn") => {
    const id = Date.now();
    setAlerts(p => [...p, { id, msg, type }]);
    setTimeout(() => setAlerts(p => p.filter(a => a.id !== id)), 4500);
  }, []);

  // Call Supabase Edge Function (mt5-bridge)
  const callMt5 = useCallback(async (action, payload) => {
    if (!SUPABASE_ANON_KEY) {
      console.warn("Supabase anon key not set — set SUPABASE_ANON_KEY in TradingBot_FINAL.jsx");
      return { error: "Supabase not configured" };
    }
    const res = await fetch(SUPABASE_FUNC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ action, payload }),
    });
    return res.json();
  }, []);

  // One-time test: Supabase function (open browser console to see result)
  useEffect(() => {
    if (!SUPABASE_ANON_KEY) return;
    callMt5("TEST", { hello: "from React" }).then((r) => console.log("Supabase mt5-bridge:", r)).catch(console.error);
  }, [callMt5]);

  // ═══════════════════════════════════════
  //  CIRCUIT BREAKER
  // ═══════════════════════════════════════
  useEffect(() => {
    const dd = peakEq > 0 ? ((peakEq - equity) / peakEq) * 100 : 0;
    if (dd >= settings.maxDD && running && !circuitBreaker) {
      setRunning(false);
      setCircuitBreaker(true);
      playSound("alert");
      addLog(`⛔ CIRCUIT BREAKER — Drawdown ${dd.toFixed(2)}% exceeded ${settings.maxDD}% limit`, "loss");
      addAlert(`⛔ Bot stopped — Max drawdown hit!`, "danger");
    }
  }, [equity, peakEq, settings.maxDD, running, circuitBreaker, addLog, addAlert, playSound]);

  // ═══════════════════════════════════════
  //  FINNHUB LIVE PRICE
  // ═══════════════════════════════════════
  const connectFinnhub = useCallback(() => {
    if (finnRef.current) finnRef.current.close();
    const ws = new WebSocket("wss://ws.finnhub.io?token=" + FINNHUB_KEY);
    finnRef.current = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "subscribe", symbol: "OANDA:XAU_USD" }));
      setPriceSource("finnhub_live");
      addLog("📡 Finnhub connected — real XAU/USD prices", "win");
    };
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "trade" && data.data?.length > 0) {
          const newP = data.data[data.data.length - 1].p;
          if (newP && newP > 1000) {
            setPrice(prev => { setPriceDir(newP > prev ? 1 : -1); return newP; });
            if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
              setPriceSource("finnhub_live");
            }
          }
        }
      } catch {}
    };
    ws.onerror = () => setPriceSource("simulation");
    ws.onclose = () => { if (priceSource === "finnhub_live") setPriceSource("simulation"); };
    return () => ws.close();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addLog]);

  useEffect(() => { return connectFinnhub(); }, [connectFinnhub]);

  // ═══════════════════════════════════════
  //  LIVE NEWS (Finnhub general market news)
  // ═══════════════════════════════════════
  const fetchNews = useCallback(async () => {
    setNewsLoading(true);
    try {
      const res = await fetch(`https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_KEY}`);
      const data = await res.json();
      if (Array.isArray(data)) {
        setNews(data.slice(0, 8).map(n => ({
          id: n.id,
          headline: n.headline,
          source: n.source,
          url: n.url,
          time: new Date(n.datetime * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          sentiment: n.headline?.toLowerCase().match(/fall|drop|slump|fear|crash|weak|decline/) ? "bear"
            : n.headline?.toLowerCase().match(/rise|surge|rally|strong|high|gain|bull/) ? "bull" : "neutral",
        })));
      }
    } catch { /* silent fail */ }
    setNewsLoading(false);
  }, []);

  useEffect(() => {
    fetchNews();
    const iv = setInterval(fetchNews, 5 * 60 * 1000); // refresh every 5 min
    return () => clearInterval(iv);
  }, [fetchNews]);

  // ═══════════════════════════════════════
  //  BRIDGE PING
  // ═══════════════════════════════════════
  const startPing = useCallback(() => {
    if (pingTimer.current) clearInterval(pingTimer.current);
    pingTimer.current = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        pingStart.current = Date.now();
        wsRef.current.send(JSON.stringify({ type: "PING" }));
      }
    }, 5000);
  }, []);

  // ═══════════════════════════════════════
  //  BROKER / BRIDGE CONNECTION
  // ═══════════════════════════════════════
  const connectBridge = useCallback((login, password, server, isReconnect = false) => {
    if (!isReconnect) setBrokerConnecting(true);
    const url = ref.current.settings.bridgeUrl || "ws://localhost:8000/ws";
    // ── Timeout: reset if no connection after 12s ──
    const connectTimeout = setTimeout(() => {
      if (!ref.current.brokerConnected) {
        setBrokerConnecting(false);
        addLog("❌ Connection timed out — check bridge is running and VPS URL is correct", "loss");
        addAlert("❌ Connection timed out", "danger");
      }
    }, 12000);
    try {
      if (wsRef.current) wsRef.current.close();
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "LOGIN", login, password, server }));
        if (!isReconnect) addLog("🔗 Bridge connected — authenticating...", "info");
      };

      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);

          // PONG — calculate latency
          if (data.type === "PONG" && pingStart.current) {
            setBridgePing(Date.now() - pingStart.current);
            pingStart.current = null;
            return;
          }

          if (data.type === "PRICE") {
            const newP = data.bid;
            setPrice(prev => { setPriceDir(newP > prev ? 1 : -1); return newP; });
            setPriceSource("mt5_live");
          } else if (data.type === "ACCOUNT") {
            const bal = parseFloat(data.balance || data.equity || 100);
            const eq  = parseFloat(data.equity  || bal);
            // FIX: sync initial balance from real MT5 balance
            setInitialBalance(bal);
            setEquity(eq);
            setPeakEq(prev => Math.max(prev, eq));
            setEqHistory([{ t: 0, v: parseFloat(eq.toFixed(2)) }]);
            // FIX: correct type field
            const fixedAccount = {
              ...data,
              type_: data.trade_mode === 0 ? "DEMO" : data.type === "DEMO" ? "DEMO" : "LIVE",
            };
            setBrokerAccount(fixedAccount);
            setBrokerConnected(true);
            setBrokerConnecting(false);
            clearTimeout(connectTimeout);
            setReconnectCount(0);
            if (!isReconnect) {
              playSound("connect");
              addLog(`✅ MT5 CONNECTED | #${data.login} | $${bal.toFixed(2)} | ${data.server}`, "win");
              addAlert("✅ Exness MT5 Connected!", "success");
            }
            startPing();
          } else if (data.type === "MT5_TRADES") {
            setMt5Trades(data.trades || []);
          } else if (data.type === "MT5_HISTORY") {
            setMt5History(data.trades || []);
          } else if (data.type === "ORDER_RESULT") {
            if (data.status === "ok") {
              playSound("signal");
              addLog(`✅ ORDER PLACED | Ticket #${data.order} @ $${parseFloat(data.price || 0).toFixed(2)}`, "win");
              addAlert(`✅ Trade placed @ $${parseFloat(data.price || 0).toFixed(2)}`, "success");
            } else {
              addLog(`❌ ORDER FAILED | ${data.msg}`, "loss");
              addAlert(`❌ Order failed: ${data.msg}`, "danger");
            }
          } else if (data.type === "CLOSE_RESULT") {
            addLog(data.status === "ok" ? `✅ Trade #${data.ticket} closed` : `❌ Close failed: ${data.msg}`, data.status === "ok" ? "win" : "loss");
            if (data.status === "ok") {
              setTimeout(() => { wsRef.current?.send(JSON.stringify({ type: "GET_TRADES" })); }, 500);
            }
          } else if (data.type === "LOGIN_FAILED") {
            setBrokerConnecting(false);
            addLog("❌ MT5 Login failed — check credentials and ensure MT5 is open on VPS", "loss");
            addAlert("❌ Login failed", "danger");
          }
        } catch {}
      };

      ws.onclose = () => {
        setBridgePing(null);
        if (pingTimer.current) clearInterval(pingTimer.current);
        if (brokerConnected || isReconnect) {
          // Auto-reconnect
          const count = reconnectCount + 1;
          setReconnectCount(count);
          if (count <= 10) {
            addLog(`🔄 Bridge disconnected — reconnecting in 5s (attempt ${count}/10)...`, "info");
            reconnectTimer.current = setTimeout(() => {
              connectBridge(login, password, server, true);
            }, 5000);
          } else {
            setBrokerConnected(false);
            setBrokerConnecting(false);
            setPriceSource("finnhub_live");
            addLog("🔴 Bridge disconnected — max reconnect attempts reached", "loss");
          }
        } else {
          setBrokerConnected(false);
          setBrokerConnecting(false);
          setPriceSource("finnhub_live");
        }
      };

      ws.onerror = () => {
        clearTimeout(connectTimeout);
        if (!isReconnect) {
          setBrokerConnecting(false);
          addLog("❌ Bridge not running. Start bridge_windows.py on your VPS first.", "loss");
          addAlert("❌ Bridge not reachable", "danger");
        }
      };
    } catch (err) {
      clearTimeout(connectTimeout);
      setBrokerConnecting(false);
      addLog(`❌ Connection error: ${err.message}`, "loss");
    }
  }, [addLog, addAlert, playSound, startPing, brokerConnected, reconnectCount]);

  const disconnectBroker = useCallback(() => {
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    if (pingTimer.current) clearInterval(pingTimer.current);
    if (wsRef.current) wsRef.current.onclose = null; // prevent auto-reconnect
    if (wsRef.current) wsRef.current.close();
    setBrokerConnected(false);
    setBrokerAccount(null);
    setMt5Trades([]);
    setBridgePing(null);
    setReconnectCount(0);
    setPriceSource("finnhub_live");
    addLog("⏹ Broker disconnected", "info");
  }, [addLog]);

  const sendToMT5 = useCallback((direction, sl, tp, volume = 0.01) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "PLACE_ORDER", direction, sl, tp, volume }));
      addLog(`📤 Sending ${direction} to MT5 @ $${ref.current.price.toFixed(2)}`, "signal");
    }
  }, [addLog]);

  const closeTradeOnMT5 = useCallback((ticket) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "CLOSE_TRADE", ticket }));
      addLog(`📤 Closing ticket #${ticket} on MT5...`, "info");
    }
  }, [addLog]);

  // ═══════════════════════════════════════
  //  INDICATORS
  // ═══════════════════════════════════════
  const computeInd = useCallback((cands) => {
    const closes = cands.map(c => c.c);
    const e20a = emaArr(closes, 20);
    const e50a = emaArr(closes, 50);
    return {
      ema20: e20a[e20a.length - 1],
      ema50: e50a[e50a.length - 1],
      prevEma20: e20a[e20a.length - 2] || e20a[e20a.length - 1],
      prevEma50: e50a[e50a.length - 2] || e50a[e50a.length - 1],
      rsi: calcRSI(closes),
      bb: calcBB(closes),
      atr: calcATR(cands),
      adx: calcADX(cands),
    };
  }, []);

  useEffect(() => { setInd(computeInd(initCandles)); }, [computeInd, initCandles]);

  // ═══════════════════════════════════════
  //  STRATEGY ENGINE
  // ═══════════════════════════════════════
  const strategize = useCallback((cands, indicators, eq, openT, setts) => {
    const { ema20, ema50, prevEma20, prevEma50, rsi, bb, atr, adx } = indicators;
    const px      = cands[cands.length - 1].c;
    const riskAmt = eq * (setts.risk / 100);
    const regime  = adx > 25 ? "TRENDING" : adx < 18 ? "RANGING" : "NEUTRAL";
    const isAggressive = setts.risk >= 4;
    // Aggressive: wider stops, 3:1 R:R, swing targets
    const stopMult = isAggressive ? 2.5 : 1.5;
    const tpMult   = isAggressive ? 3.0 : 2.0;
    const stopDist = atr * stopMult;
    if (openT.length >= 2) return { regime, signal: null };
    const hasLong  = openT.some(t => t.dir === "long");
    const hasShort = openT.some(t => t.dir === "short");
    let signal = null, strat = "", sl = 0, tp = 0;
    // ── Trend Strategy (EMA Cross) ──
    if (setts.trend && regime !== "RANGING") {
      const bullCross = prevEma20 <= prevEma50 && ema20 > ema50;
      const bearCross = prevEma20 >= prevEma50 && ema20 < ema50;
      const rsiBull = isAggressive ? rsi > 45 : rsi > 50;
      const rsiBear = isAggressive ? rsi < 55 : rsi < 50;
      if (bullCross && rsiBull && !hasLong)  { signal = "BUY";  strat = isAggressive ? "Swing Long ↗" : "EMA Cross ↗"; sl = px - stopDist; tp = px + stopDist * tpMult; }
      if (bearCross && rsiBear && !hasShort) { signal = "SELL"; strat = isAggressive ? "Swing Short ↘" : "EMA Cross ↘"; sl = px + stopDist; tp = px - stopDist * tpMult; }
    }
    // ── Mean Reversion (BB) ──
    if (!signal && setts.meanRev && regime !== "TRENDING") {
      const lastC = cands[cands.length - 1];
      const bullC = lastC.c > lastC.o, bearC = lastC.c < lastC.o;
      const bbRsiHigh = isAggressive ? 65 : 68;
      const bbRsiLow  = isAggressive ? 35 : 32;
      if (px >= bb.u && rsi > bbRsiHigh && bearC && !hasShort) { signal = "SELL"; strat = "BB Reversion ↘"; sl = px + atr * stopMult; tp = isAggressive ? px - (bb.u - bb.l) : bb.mid; }
      if (px <= bb.l && rsi < bbRsiLow  && bullC && !hasLong)  { signal = "BUY";  strat = "BB Reversion ↗"; sl = px - atr * stopMult; tp = isAggressive ? px + (bb.u - bb.l) : bb.mid; }
    }
    // ── Aggressive Momentum (new) — enters on strong trend continuation ──
    if (!signal && isAggressive && regime === "TRENDING") {
      const strongBull = ema20 > ema50 && rsi > 55 && rsi < 75 && px > ema20 && !hasLong;
      const strongBear = ema20 < ema50 && rsi < 45 && rsi > 25 && px < ema20 && !hasShort;
      if (strongBull) { signal = "BUY";  strat = "Momentum Ride ↗"; sl = px - stopDist; tp = px + stopDist * tpMult; }
      if (strongBear) { signal = "SELL"; strat = "Momentum Ride ↘"; sl = px + stopDist; tp = px - stopDist * tpMult; }
    }
    return { regime, signal, strat, sl, tp, riskAmt };
  }, []);

  // ═══════════════════════════════════════
  //  MAIN TICK ENGINE
  // ═══════════════════════════════════════
  useEffect(() => {
    if (!running) return;
    const iv = setInterval(() => {
      const st = ref.current;
      if (st.circuitBreaker) return;
      // Always run simulation tick (whether or not Finnhub is connected)
      {
        const lastP = st.candles[st.candles.length - 1].c;
        const mean  = 5160;
        const rev   = (mean - lastP) * 0.004;
        const noise = (Math.random() - 0.48) * 8;
        const trend = Math.sin(st.tick * 0.07) * 2;
        const newP  = Math.max(PRICE_MIN, Math.min(PRICE_MAX, lastP + rev + noise + trend));
        if (priceSource === "simulation") {
          setPrice(prev => { setPriceDir(newP > prev ? 1 : -1); return newP; });
        }
      }
      const newTick = st.tick + 1;
      setTick(newTick);
      const curP = st.price;
      let newCandles;
      if (newTick % 15 === 0) {
        const lastC = st.candles[st.candles.length - 1];
        const fin = { ...lastC, c: curP, h: Math.max(lastC.h, curP), l: Math.min(lastC.l, curP) };
        newCandles = [...st.candles.slice(-119), fin, { o: curP, h: curP, l: curP, c: curP, t: newTick }];
      } else {
        const lastC = st.candles[st.candles.length - 1];
        const upd = { ...lastC, c: curP, h: Math.max(lastC.h, curP), l: Math.min(lastC.l, curP) };
        newCandles = [...st.candles.slice(0, -1), upd];
      }
      setCandles(newCandles);
      const newInd = computeInd(newCandles);
      setInd(newInd);
      let eq = st.equity, newStats = { ...st.stats };
      let newOpen = [], newClosed = [...st.closedTrades];
      for (const trade of st.openTrades) {
        const slHit = trade.dir === "long" ? curP <= trade.sl : curP >= trade.sl;
        const tpHit = trade.dir === "long" ? curP >= trade.tp : curP <= trade.tp;
        if (slHit || tpHit) {
          const pnl = slHit ? -trade.risk : trade.risk * 2;
          eq += pnl; newStats.totalPnL += pnl;
          pnl > 0 ? newStats.wins++ : newStats.losses++;
          newClosed = [{ ...trade, exit: curP, pnl, reason: slHit ? "SL" : "TP" }, ...newClosed].slice(0, 100);
          if (st.soundEnabled) pnl > 0 ? sounds.win() : sounds.loss();
          addLog((slHit ? "🛑 STOP LOSS" : "✅ TAKE PROFIT") + ` | ${trade.strat} | ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`, pnl >= 0 ? "win" : "loss");
        } else { newOpen.push(trade); }
      }
      const newPeak = Math.max(st.peakEq, eq);
      if (newTick % 6 === 0 && !st.circuitBreaker) {
        const res = strategize(newCandles, newInd, eq, newOpen, st.settings);
        setRegime(res.regime);
        setLastSignal(res.signal);
        if (res.signal && res.strat) {
          const id = ++tradeId.current;
          newOpen.push({ id, dir: res.signal === "BUY" ? "long" : "short", entry: curP, sl: res.sl, tp: res.tp, risk: res.riskAmt, strat: res.strat });
          if (st.soundEnabled) sounds.signal();
          addLog(`📡 ${res.signal} | ${res.strat} @ $${curP.toFixed(2)} | SL $${res.sl.toFixed(2)} | TP $${res.tp.toFixed(2)}`, "signal");
          if (wsRef.current?.readyState === WebSocket.OPEN) sendToMT5(res.signal, res.sl, res.tp, 0.01);
        }
      }
      setEquity(eq); setPeakEq(newPeak);
      setOpenTrades(newOpen); setClosedTrades(newClosed); setStats(newStats);
      if (newTick % 5 === 0) setEqHistory(p => [...p, { t: newTick, v: parseFloat(eq.toFixed(2)) }].slice(-150));
    }, 1200);
    return () => clearInterval(iv);
  }, [running, priceSource, computeInd, strategize, addLog, sendToMT5]);

  // ─── DERIVED METRICS ───
  const drawdown      = peakEq > 0 ? Math.max(0, (peakEq - equity) / peakEq * 100) : 0;
  // FIX: correct totalReturn calculation using real initialBalance
  const totalReturn    = equity - initialBalance;
  const totalReturnPct = ((equity - initialBalance) / initialBalance) * 100;
  const winRate       = (stats.wins + stats.losses) > 0 ? stats.wins / (stats.wins + stats.losses) * 100 : 0;
  const openPnL       = brokerConnected && mt5Trades.length
    ? mt5Trades.reduce((sum, t) => sum + (parseFloat(t.profit ?? 0) || 0), 0)
    : openTrades.reduce((sum, t) => {
        const diff = t.dir === "long" ? price - t.entry : t.entry - price;
        const sd   = Math.abs(t.entry - t.sl);
        return sum + (sd > 0 ? (diff / sd) * t.risk : 0);
      }, 0);
  const regimeColor = regime === "TRENDING" ? C.gold : regime === "RANGING" ? C.blue : C.dim;
  const srcColor    = priceSource === "mt5_live" ? C.green : priceSource === "finnhub_live" ? C.blue : C.amber;
  const srcLabel    = priceSource === "mt5_live" ? "MT5 LIVE" : priceSource === "finnhub_live" ? "FINNHUB LIVE" : "SIMULATION";
  const pingColor   = bridgePing === null ? C.dim : bridgePing < 100 ? C.green : bridgePing < 300 ? C.amber : C.red;

  // ─── CHART DATA ───
  const priceData = useMemo(() => {
    const sl     = candles.slice(-80);
    const closes = sl.map(c => c.c);
    const e20    = emaArr(closes, 20);
    const e50    = emaArr(closes, Math.min(50, closes.length - 1));
    return sl.map((c, i) => ({ i, price: +c.c.toFixed(2), ema20: +e20[i].toFixed(2), ema50: +e50[i].toFixed(2) }));
  }, [candles]);
  const rsiData = useMemo(() => candles.slice(-60).map((_, i, a) => ({ i, rsi: +calcRSI(a.slice(0, i+1).map(x => x.c)).toFixed(1) })), [candles]);
  const adxData = useMemo(() => candles.slice(-60).map((_, i, a) => ({ i, adx: +calcADX(a.slice(0, i+1)).toFixed(1) })), [candles]);

  // ─── STYLES ───
  const panel  = (extra = {}) => ({ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: "14px 16px", ...extra });
  const mono   = { fontFamily: "monospace" };
  const tabBtn = (active) => ({ padding: "7px 12px", borderRadius: 4, background: active ? C.gold : "transparent", color: active ? "#000" : C.dim, border: "none", cursor: "pointer", fontWeight: 700, fontSize: 11, letterSpacing: ".06em", transition: "all .18s" });
  const badge  = (color) => ({ fontSize: 10, padding: "1px 7px", borderRadius: 3, background: color + "22", color, fontWeight: 700, ...mono, border: `1px solid ${color}44` });
  const pnlColor = (v) => v >= 0 ? C.green : C.red;

  const TABS = [
    { key: "overview",  icon: <Zap size={11} />,       label: "OVERVIEW"    },
    { key: "chart",     icon: <BarChart2 size={11} />,  label: "CHART"       },
    { key: "trades",    icon: <TrendingUp size={11} />, label: "TRADES"      },
    { key: "mt5",       icon: <Wifi size={11} />,       label: "MT5"         },
    { key: "log",       icon: <FileText size={11} />,   label: "LOG"         },
    { key: "settings",  icon: <Settings size={11} />,   label: "SETTINGS"    },
  ];

  return (
    <div style={{ fontFamily: "system-ui,sans-serif", background: C.bg, color: C.text, minHeight: "100vh", padding: "10px 12px" }}>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0;}
        ::-webkit-scrollbar{width:3px;}::-webkit-scrollbar-thumb{background:#1a2840;border-radius:2px;}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
        @keyframes glow{0%,100%{box-shadow:0 0 8px rgba(212,175,55,.2)}50%{box-shadow:0 0 20px rgba(212,175,55,.5)}}
        @keyframes fadein{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
        @keyframes slidedown{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:translateY(0)}}
        @keyframes ping{from{opacity:.8;transform:scale(1)}to{opacity:0;transform:scale(2)}}
        .pulse{animation:pulse 2s infinite}.glow{animation:glow 2.5s infinite}.fadein{animation:fadein .3s ease}
        input,select{outline:none;}.alert-anim{animation:slidedown .3s ease;}
        @media(max-width:640px){
          .desktop-only{display:none!important;}
          .stat-grid{grid-template-columns:1fr 1fr!important;}
          .main-grid{grid-template-columns:1fr!important;}
          .login-grid{grid-template-columns:1fr!important;}
          .preset-grid{grid-template-columns:1fr!important;}
          .mt5-info-grid{grid-template-columns:1fr!important;}
          .price-font{font-size:26px!important;}
          .tab-scroll{overflow-x:auto;white-space:nowrap;-webkit-overflow-scrolling:touch;padding-bottom:2px;}
          .header-row{flex-wrap:wrap!important;gap:6px!important;}
        }
      `}</style>

      {/* ══ FLOATING ALERTS ══ */}
      <div style={{ position: "fixed", top: 14, right: 14, zIndex: 9999, display: "flex", flexDirection: "column", gap: 7, maxWidth: 280 }}>
        {alerts.map(a => (
          <div key={a.id} className="alert-anim" style={{ padding: "9px 14px", borderRadius: 8, background: a.type === "success" ? C.green + "18" : a.type === "danger" ? C.red + "18" : C.amber + "18", border: `1px solid ${a.type === "success" ? C.green : a.type === "danger" ? C.red : C.amber}44`, color: a.type === "success" ? C.green : a.type === "danger" ? C.red : C.amber, fontSize: 12, fontWeight: 700, lineHeight: 1.4 }}>
            {a.msg}
          </div>
        ))}
      </div>

      {/* ══ CIRCUIT BREAKER BANNER ══ */}
      {circuitBreaker && (
        <div style={{ background: C.red + "12", border: `1px solid ${C.red}44`, borderRadius: 8, padding: "10px 14px", marginBottom: 10, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <AlertTriangle size={15} color={C.red} />
            <span style={{ color: C.red, fontWeight: 700, fontSize: 12 }}>⛔ CIRCUIT BREAKER — Max drawdown {settings.maxDD}% reached. Bot stopped.</span>
          </div>
          <button onClick={() => { setCircuitBreaker(false); setEquity(initialBalance); setPeakEq(initialBalance); setEqHistory([{ t: 0, v: initialBalance }]); addLog("🔄 Circuit breaker reset.", "info"); }}
            style={{ padding: "4px 12px", background: C.red + "18", border: `1px solid ${C.red}44`, borderRadius: 4, color: C.red, cursor: "pointer", fontSize: 11, fontWeight: 700 }}>
            RESET
          </button>
        </div>
      )}

      {/* ══ HEADER ══ */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `1px solid ${C.border}`, paddingBottom: 10, marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
          <div className={running ? "pulse" : ""} style={{ width: 8, height: 8, borderRadius: "50%", background: running ? C.green : C.dim, flexShrink: 0 }} />
          <span style={{ ...mono, color: C.gold, fontSize: 18, fontWeight: 700 }}>XAU/USD</span>
          <div style={{ padding: "2px 7px", background: C.gold + "15", border: `1px solid ${C.gold}30`, borderRadius: 4 }}>
            <span style={{ ...mono, fontSize: 9, color: C.gold }}>AUTO TRADER v7.0 · MT5</span>
          </div>
          {/* Price source */}
          <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 8px", background: srcColor + "12", border: `1px solid ${srcColor}30`, borderRadius: 4 }}>
            {priceSource !== "simulation" ? <Wifi size={9} color={srcColor} /> : <WifiOff size={9} color={srcColor} />}
            <span style={{ fontSize: 9, color: srcColor, ...mono }}>{srcLabel}</span>
          </div>
          {/* Bridge ping */}
          {brokerConnected && (
            <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 8px", background: pingColor + "12", border: `1px solid ${pingColor}30`, borderRadius: 4 }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: pingColor }} />
              <span style={{ fontSize: 9, color: pingColor, ...mono }}>{bridgePing !== null ? `${bridgePing}ms` : "—"}</span>
            </div>
          )}
          {/* Broker connect button */}
          <div onClick={() => setShowLoginPanel(p => !p)} style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 10px", background: brokerConnected ? C.green + "12" : C.red + "10", border: `1px solid ${brokerConnected ? C.green + "40" : C.red + "30"}`, borderRadius: 4, cursor: "pointer" }}>
            {brokerConnected ? <Wifi size={10} color={C.green} /> : <Lock size={10} color={C.dim} />}
            <span style={{ fontSize: 10, color: brokerConnected ? C.green : C.dim, fontWeight: 700 }}>
              {brokerConnected ? "EXNESS CONNECTED" : "CONNECT BROKER"}
            </span>
          </div>
          {/* Sound toggle */}
          <button onClick={() => setSoundEnabled(p => !p)} style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 4, padding: "3px 7px", cursor: "pointer", color: soundEnabled ? C.gold : C.dim }}>
            {soundEnabled ? <Volume2 size={11} /> : <VolumeX size={11} />}
          </button>
          {/* Manual trade button */}
          {brokerConnected && (
            <button onClick={() => setShowManualTrade(p => !p)} style={{ padding: "4px 10px", background: C.purple + "15", border: `1px solid ${C.purple}40`, borderRadius: 4, color: C.purple, cursor: "pointer", fontSize: 10, fontWeight: 700, display: "flex", alignItems: "center", gap: 4 }}>
              <Phone size={10} />MANUAL
            </button>
          )}
        </div>

        <div style={{ textAlign: "center" }}>
          <div className="price-font" style={{ ...mono, fontSize: 30, fontWeight: 700, lineHeight: 1, color: priceDir > 0 ? C.green : priceDir < 0 ? C.red : C.text, transition: "color .3s" }}>
            {price.toFixed(2)}
            <span style={{ fontSize: 12, marginLeft: 4 }}>{priceDir > 0 ? "▲" : priceDir < 0 ? "▼" : ""}</span>
          </div>
          <div style={{ fontSize: 9, color: C.dimmer, marginTop: 2 }}>
            BID {price.toFixed(2)} · ASK {(price + SPREAD).toFixed(2)} · #{tick}
          </div>
        </div>

        <button onClick={() => { if (!running && circuitBreaker) { addLog("⚠️ Reset circuit breaker first!", "loss"); return; } setRunning(r => !r); addLog(running ? "⏸ Bot stopped." : "▶ Bot started — scanning XAUUSDm...", "info"); }}
          className={running ? "glow" : ""}
          style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 18px", borderRadius: 6, background: running ? C.red + "15" : C.gold + "15", border: `1.5px solid ${running ? C.red : C.gold}`, color: running ? C.red : C.gold, cursor: "pointer", fontSize: 13, fontWeight: 700, transition: "all .2s", opacity: circuitBreaker && !running ? 0.5 : 1 }}>
          {running ? <><Square size={13} />STOP</> : <><Play size={13} />START BOT</>}
        </button>
      </div>

      {/* ══ MANUAL TRADE PANEL ══ */}
      {showManualTrade && brokerConnected && (
        <div className="fadein" style={{ ...panel({ marginBottom: 10, border: `1px solid ${C.purple}44` }) }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: C.purple }}>⚡ MANUAL TRADE — XAUUSDm</span>
            <button onClick={() => setShowManualTrade(false)} style={{ background: "none", border: "none", color: C.dim, cursor: "pointer" }}><X size={14} /></button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 10 }}>
            {[
              { label: "Stop Loss", val: manualSL, set: setManualSL, placeholder: price > 0 ? (price - 15).toFixed(2) : "5145.00" },
              { label: "Take Profit", val: manualTP, set: setManualTP, placeholder: price > 0 ? (price + 30).toFixed(2) : "5190.00" },
              { label: "Volume (lots)", val: manualVol, set: setManualVol, placeholder: "0.01" },
            ].map(({ label, val, set, placeholder }) => (
              <div key={label}>
                <div style={{ fontSize: 10, color: C.dim, marginBottom: 4 }}>{label}</div>
                <input type="number" placeholder={placeholder} value={val} onChange={e => set(e.target.value)}
                  style={{ width: "100%", background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 5, padding: "7px 10px", color: C.text, fontSize: 12, ...mono }} />
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => { sendToMT5("BUY", parseFloat(manualSL) || price - 15, parseFloat(manualTP) || price + 30, parseFloat(manualVol) || 0.01); setShowManualTrade(false); }}
              style={{ flex: 1, padding: "10px", background: C.green + "18", border: `1px solid ${C.green}44`, borderRadius: 6, color: C.green, cursor: "pointer", fontWeight: 700, fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
              <ArrowUp size={14} /> BUY @ {price.toFixed(2)}
            </button>
            <button onClick={() => { sendToMT5("SELL", parseFloat(manualSL) || price + 15, parseFloat(manualTP) || price - 30, parseFloat(manualVol) || 0.01); setShowManualTrade(false); }}
              style={{ flex: 1, padding: "10px", background: C.red + "18", border: `1px solid ${C.red}44`, borderRadius: 6, color: C.red, cursor: "pointer", fontWeight: 700, fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
              <ArrowDown size={14} /> SELL @ {price.toFixed(2)}
            </button>
          </div>
        </div>
      )}

      {/* ══ BROKER LOGIN PANEL ══ */}
      {showLoginPanel && (
        <div className="fadein" style={{ ...panel({ marginBottom: 10, border: `1px solid ${brokerConnected ? C.green + "40" : C.gold + "40"}` }) }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <User size={14} color={C.gold} />
              <span style={{ fontSize: 12, fontWeight: 700, color: C.gold }}>EXNESS MT5 BROKER LOGIN</span>
              {reconnectCount > 0 && (
                <span style={{ fontSize: 9, color: C.amber, ...mono }}>RECONNECTING ({reconnectCount}/10)</span>
              )}
            </div>
            <div style={{ display: "flex", gap: 7 }}>
              {brokerConnected && (
                <button onClick={() => { wsRef.current?.send(JSON.stringify({ type: "GET_TRADES" })); wsRef.current?.send(JSON.stringify({ type: "GET_ACCOUNT" })); wsRef.current?.send(JSON.stringify({ type: "GET_HISTORY" })); }}
                  style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 10px", background: "transparent", border: `1px solid ${C.border}`, borderRadius: 4, color: C.dim, cursor: "pointer", fontSize: 10 }}>
                  <RefreshCw size={10} />Refresh
                </button>
              )}
              {brokerConnected && (
                <button onClick={disconnectBroker} style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 10px", background: C.red + "15", border: `1px solid ${C.red}40`, borderRadius: 5, color: C.red, cursor: "pointer", fontSize: 11, fontWeight: 700 }}>
                  <LogOut size={11} />DISCONNECT
                </button>
              )}
              <button onClick={() => setShowLoginPanel(false)} style={{ background: "none", border: "none", color: C.dim, cursor: "pointer", padding: 3 }}><X size={15} /></button>
            </div>
          </div>

          {brokerConnected && brokerAccount ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8 }}>
              {[
                { label: "ACCOUNT",     val: brokerAccount.login,                                  color: C.gold   },
                { label: "BALANCE",     val: `$${parseFloat(brokerAccount.balance||0).toFixed(2)}`,  color: C.green  },
                { label: "EQUITY",      val: `$${parseFloat(brokerAccount.equity||0).toFixed(2)}`,   color: C.blue   },
                { label: "FREE MARGIN", val: `$${parseFloat(brokerAccount.freeMargin||0).toFixed(2)}`, color: C.amber },
                { label: "SERVER",      val: brokerAccount.server,                                  color: C.dim    },
                { label: "LEVERAGE",    val: `1:${brokerAccount.leverage || 2000}`,                 color: C.purple },
                { label: "CURRENCY",    val: brokerAccount.currency || "USD",                       color: C.text   },
                // FIX: correct TYPE display
                { label: "TYPE",        val: brokerAccount.type_ || "DEMO",                         color: C.amber  },
              ].map(({ label, val, color }) => (
                <div key={label} style={{ background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 6, padding: "9px 11px" }}>
                  <div style={{ fontSize: 9, color: C.dim, letterSpacing: ".1em", marginBottom: 3 }}>{label}</div>
                  <div style={{ ...mono, fontSize: 13, fontWeight: 700, color }}>{val}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="login-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 8, alignItems: "end" }}>
              <div>
                <div style={{ fontSize: 10, color: C.dim, marginBottom: 4 }}>MT5 Account Number</div>
                <input type="text" placeholder="413455206" value={brokerLogin.login} onChange={e => setBrokerLogin(p => ({ ...p, login: e.target.value }))}
                  style={{ width: "100%", background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 5, padding: "8px 10px", color: C.text, fontSize: 12, ...mono }} />
              </div>
              <div>
                <div style={{ fontSize: 10, color: C.dim, marginBottom: 4 }}>Password</div>
                <div style={{ position: "relative" }}>
                  <input type={showPassword ? "text" : "password"} placeholder="MT5 password" value={brokerLogin.password} onChange={e => setBrokerLogin(p => ({ ...p, password: e.target.value }))}
                    style={{ width: "100%", background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 5, padding: "8px 10px", paddingRight: 40, color: C.text, fontSize: 12 }} />
                  <span onClick={() => setShowPassword(p => !p)} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", cursor: "pointer", color: C.dim, fontSize: 9 }}>
                    {showPassword ? "HIDE" : "SHOW"}
                  </span>
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: C.dim, marginBottom: 4 }}>Server</div>
                <select value={brokerLogin.server} onChange={e => setBrokerLogin(p => ({ ...p, server: e.target.value }))}
                  style={{ width: "100%", background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 5, padding: "8px 10px", color: C.text, fontSize: 12 }}>
                  <optgroup label="── DEMO ──">
                    {["Exness-MT5Trial","Exness-MT5Trial2","Exness-MT5Trial3","Exness-MT5Trial4","Exness-MT5Trial5","Exness-MT5Trial6","Exness-MT5Trial7","Exness-MT5Trial8","Exness-MT5Trial9","Exness-MT5Trial10","Exness-MT5Trial11","Exness-MT5Trial12","Exness-MT5Trial13","Exness-MT5Trial14","Exness-MT5Trial15","Exness-MT5Trial16","Exness-MT5Trial17","Exness-MT5Trial18","Exness-MT5Trial19","Exness-MT5Trial20"].map(s => (
                      <option key={s} value={s}>{s}{s==="Exness-MT5Trial6"?" ← YOURS":""}</option>
                    ))}
                  </optgroup>
                  <optgroup label="── LIVE ──">
                    {["Exness-MT5Real","Exness-MT5Real2","Exness-MT5Real3","Exness-MT5Real4","Exness-MT5Real5","Exness-MT5Real6","Exness-MT5Real7","Exness-MT5Real8"].map(s => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </optgroup>
                </select>
              </div>
              <button onClick={() => connectBridge(brokerLogin.login, brokerLogin.password, brokerLogin.server)}
                disabled={brokerConnecting || !brokerLogin.login || !brokerLogin.password}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 6, background: C.gold + "15", border: `1px solid ${C.gold}44`, color: C.gold, cursor: "pointer", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap", opacity: brokerConnecting ? 0.6 : 1 }}>
                {brokerConnecting ? <><RefreshCw size={12} />Connecting...</> : <><LogIn size={12} />CONNECT</>}
              </button>
            </div>
          )}
          <div style={{ marginTop: 8, padding: "7px 11px", background: C.amber + "08", border: `1px solid ${C.amber}20`, borderRadius: 5, fontSize: 11, color: C.amber }}>
            ⚠️ Requires <span style={mono}>bridge.py</span> running on your machine or VPS:
            <span style={mono}> python3 bridge.py</span>. Your MT5 password is sent only to this bridge process and is never stored externally.
            If you still get connection errors it is most likely a network/server issue — you can also consider exposing the bridge via a secure backend
            (for example Supabase Edge Functions or another authenticated API) instead of connecting to it directly from the browser.
          </div>
        </div>
      )}

      {/* ══ STATS ══ */}
      <div className="stat-grid" style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 7, marginBottom: 10 }}>
        {[
          { icon: <BarChart2 size={12} color={C.gold} />,  label: "EQUITY",    value: `$${equity.toFixed(2)}`,                              sub: `${totalReturnPct >= 0 ? "+" : ""}${totalReturnPct.toFixed(2)}% return`,                   col: totalReturnPct >= 0 ? C.green : C.red,  accent: C.gold   },
          { icon: <Zap size={12} color={C.amber} />,       label: "OPEN P&L",  value: `${openPnL >= 0 ? "+" : ""}$${openPnL.toFixed(2)}`,   sub: `${openTrades.length} position${openTrades.length !== 1 ? "s" : ""}`,                     col: openPnL >= 0 ? C.green : C.red,        accent: C.amber  },
          { icon: <Shield size={12} color={drawdown > 10 ? C.red : C.green} />, label: "DRAWDOWN", value: `${drawdown.toFixed(2)}%`,          sub: `Peak $${peakEq.toFixed(2)} · Limit ${settings.maxDD}%`,                                  col: drawdown > settings.maxDD * 0.7 ? C.red : C.green,  accent: drawdown > 10 ? C.red : C.green },
          { icon: <TrendingUp size={12} color={winRate > 50 ? C.green : C.red} />, label: "WIN RATE", value: `${winRate.toFixed(1)}%`,         sub: `${stats.wins}W / ${stats.losses}L · $${stats.totalPnL.toFixed(2)}`,                      col: winRate > 55 ? C.green : winRate > 40 ? C.amber : C.red, accent: winRate > 50 ? C.green : C.red },
        ].map(({ icon, label, value, sub, col, accent }) => (
          <div key={label} style={{ ...panel({ padding: "11px 12px" }), borderTop: `2px solid ${accent}33`, position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", top: 0, right: 0, width: 50, height: 50, borderRadius: "50%", background: accent + "08", transform: "translate(15px,-15px)" }} />
            <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 4 }}>
              {icon}<span style={{ fontSize: 9, color: C.dim, letterSpacing: ".1em" }}>{label}</span>
            </div>
            <div style={{ ...mono, fontSize: 20, fontWeight: 700, lineHeight: 1 }}>{value}</div>
            <div style={{ fontSize: 10, color: col, marginTop: 4 }}>{sub}</div>
          </div>
        ))}
      </div>

      {/* ══ PERFORMANCE METRICS ROW (Beefy-inspired) ══ */}
      <div style={{ display: "flex", gap: 7, marginBottom: 10, overflowX: "auto", paddingBottom: 3 }}>
        {[
          { label: "BEST TRADE",   val: closedTrades.length > 0 ? `+$${Math.max(...closedTrades.map(t => t.pnl)).toFixed(2)}` : "—", color: C.green },
          { label: "WORST TRADE",  val: closedTrades.length > 0 ? `$${Math.min(...closedTrades.map(t => t.pnl)).toFixed(2)}` : "—", color: C.red },
          { label: "AVG P&L",      val: (stats.wins + stats.losses) > 0 ? `${(stats.totalPnL / (stats.wins + stats.losses)) >= 0 ? "+" : ""}$${(stats.totalPnL / (stats.wins + stats.losses)).toFixed(2)}` : "—", color: C.amber },
          { label: "TOTAL TRADES", val: String(stats.wins + stats.losses), color: C.blue },
          { label: "REGIME",       val: regime, color: regime === "TRENDING" ? C.gold : regime === "RANGING" ? C.blue : C.dim },
          { label: "PRICE SOURCE", val: srcLabel, color: srcColor },
        ].map(({ label, val, color }) => (
          <div key={label} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 11px", flexShrink: 0 }}>
            <div style={{ fontSize: 8, color: C.dim, letterSpacing: ".1em", marginBottom: 2 }}>{label}</div>
            <div style={{ ...mono, fontSize: 12, fontWeight: 700, color }}>{val}</div>
          </div>
        ))}
      </div>

      {/* ══ TABS ══ */}
      <div className="tab-scroll" style={{ display: "flex", gap: 3, marginBottom: 10, borderBottom: `1px solid ${C.border}`, paddingBottom: 7 }}>
        {TABS.map(({ key, icon, label }) => (
          <button key={key} style={tabBtn(tab === key)} onClick={() => setTab(key)}>
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>{icon}{label}</span>
          </button>
        ))}
      </div>

      {/* ══ OVERVIEW ══ */}
      {tab === "overview" && (
        <div className="main-grid" style={{ display: "grid", gridTemplateColumns: "240px 1fr", gap: 9 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={panel()}>
              <div style={{ fontSize: 9, color: C.dim, letterSpacing: ".1em", marginBottom: 7 }}>MARKET REGIME</div>
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <div className="pulse" style={{ width: 7, height: 7, borderRadius: "50%", background: regimeColor }} />
                <span style={{ ...mono, fontSize: 19, color: regimeColor, fontWeight: 700 }}>{regime}</span>
              </div>
              <div style={{ marginTop: 5, fontSize: 10, color: C.dim }}>ADX: <span style={{ color: C.text }}>{ind.adx?.toFixed(1)}</span> {regime === "TRENDING" ? "· EMA Cross" : regime === "RANGING" ? "· BB/RSI" : "· Dual"}</div>
            </div>
            <div style={{ ...panel(), border: `1px solid ${lastSignal ? (lastSignal === "BUY" ? C.green + "44" : C.red + "44") : C.border}` }}>
              <div style={{ fontSize: 9, color: C.dim, letterSpacing: ".1em", marginBottom: 7 }}>LAST SIGNAL</div>
              {lastSignal ? (
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <div style={{ width: 38, height: 38, borderRadius: 8, background: (lastSignal === "BUY" ? C.green : C.red) + "15", border: `2px solid ${lastSignal === "BUY" ? C.green : C.red}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {lastSignal === "BUY" ? <TrendingUp size={17} color={C.green} /> : <TrendingDown size={17} color={C.red} />}
                  </div>
                  <div>
                    <div style={{ ...mono, fontSize: 20, fontWeight: 700, color: lastSignal === "BUY" ? C.green : C.red }}>{lastSignal}</div>
                    <div style={{ fontSize: 10, color: C.dim }}>{brokerConnected ? "→ Sent to MT5" : "Simulation"}</div>
                  </div>
                </div>
              ) : (
                <div style={{ color: C.dim, fontSize: 12 }}>{running ? "Scanning..." : "Start bot to scan"}</div>
              )}
            </div>
            <div style={panel()}>
              <div style={{ fontSize: 9, color: C.dim, letterSpacing: ".1em", marginBottom: 9 }}>INDICATORS</div>
              {[
                { label: "EMA 20",   val: ind.ema20?.toFixed(2), color: C.blue   },
                { label: "EMA 50",   val: ind.ema50?.toFixed(2), color: C.purple },
                { label: "RSI (14)", val: ind.rsi?.toFixed(1),   color: ind.rsi > 70 ? C.red : ind.rsi < 30 ? C.green : C.amber },
                { label: "BB Upper", val: ind.bb?.u?.toFixed(2), color: C.red    },
                { label: "BB Lower", val: ind.bb?.l?.toFixed(2), color: C.green  },
                { label: "ATR (14)", val: ind.atr?.toFixed(2),   color: C.amber  },
                { label: "ADX (14)", val: ind.adx?.toFixed(1),   color: ind.adx > 25 ? C.gold : C.dim },
              ].map(({ label, val, color }) => (
                <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderBottom: `1px solid ${C.border}20` }}>
                  <span style={{ fontSize: 11, color: C.dim }}>{label}</span>
                  <span style={{ ...mono, fontSize: 11, color, fontWeight: 600 }}>{val ?? "—"}</span>
                </div>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={panel()}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 7 }}>
                <span style={{ fontSize: 9, color: C.dim }}>EQUITY CURVE · ${initialBalance.toFixed(0)} BASE</span>
                <span style={{ ...mono, fontSize: 11, color: pnlColor(totalReturnPct) }}>
                  {totalReturnPct >= 0 ? "+" : ""}${totalReturn.toFixed(2)} ({totalReturnPct.toFixed(2)}%)
                </span>
              </div>
              <ResponsiveContainer width="100%" height={150}>
                <AreaChart data={eqHistory}>
                  <defs>
                    <linearGradient id="eg" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor={C.gold} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={C.gold} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis hide /><YAxis domain={["auto","auto"]} tick={{ fontSize: 9, fill: C.dim }} width={48} tickFormatter={v => `$${v.toFixed(0)}`} />
                  <Tooltip contentStyle={{ background: C.panel2, border: `1px solid ${C.border}`, fontSize: 10 }} formatter={v => [`$${v.toFixed(2)}`, "Equity"]} labelFormatter={() => ""} />
                  <ReferenceLine y={initialBalance} stroke={C.dimmer} strokeDasharray="4 4" />
                  <Area type="monotone" dataKey="v" stroke={C.gold} strokeWidth={2} fill="url(#eg)" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div style={panel()}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 9 }}>
                <span style={{ fontSize: 9, color: C.dim }}>OPEN POSITIONS</span>
                <span style={badge(openTrades.length > 0 ? C.amber : C.dim)}>{openTrades.length} / 2</span>
              </div>
              {openTrades.length === 0 ? (
                <div style={{ color: C.dim, fontSize: 12, textAlign: "center", padding: "16px 0" }}>
                  {running ? "🔍 Scanning XAUUSDm..." : "⏸ Start bot to begin"}
                </div>
              ) : openTrades.map(t => {
                const diff  = t.dir === "long" ? price - t.entry : t.entry - price;
                const sd    = Math.abs(t.entry - t.sl);
                const unreal = sd > 0 ? (diff / sd) * t.risk : 0;
                return (
                  <div key={t.id} className="fadein" style={{ background: C.panel2, border: `1px solid ${t.dir === "long" ? C.green : C.red}40`, borderRadius: 7, padding: "9px 11px", marginBottom: 6 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                      <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                        <span style={badge(t.dir === "long" ? C.green : C.red)}>{t.dir.toUpperCase()}</span>
                        <span style={{ fontSize: 11 }}>{t.strat}</span>
                        {brokerConnected && <span style={badge(C.green)}>→ MT5</span>}
                      </div>
                      <span style={{ ...mono, fontSize: 14, fontWeight: 700, color: pnlColor(unreal) }}>{unreal >= 0 ? "+" : ""}${unreal.toFixed(2)}</span>
                    </div>
                    <div style={{ display: "flex", gap: 10, fontSize: 10 }}>
                      <span style={{ color: C.dim }}>Entry <span style={{ color: C.text, ...mono }}>{t.entry.toFixed(2)}</span></span>
                      <span style={{ color: C.red }}>SL <span style={mono}>{t.sl.toFixed(2)}</span></span>
                      <span style={{ color: C.green }}>TP <span style={mono}>{t.tp.toFixed(2)}</span></span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ══ CHART ══ */}
      {tab === "chart" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          <div style={panel()}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 7 }}>
              <span style={{ fontSize: 9, color: C.dim }}>XAUUSDm · PRICE + EMA20 + EMA50</span>
              <div style={{ display: "flex", gap: 10, fontSize: 10 }}>
                <span style={{ color: C.gold }}>── Price</span>
                <span style={{ color: C.blue }}>── EMA20</span>
                <span style={{ color: C.purple }}>── EMA50</span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={priceData}>
                <XAxis hide /><YAxis domain={["auto","auto"]} tick={{ fontSize: 9, fill: C.dim }} width={55} tickFormatter={v => v.toFixed(0)} />
                <Tooltip contentStyle={{ background: C.panel2, border: `1px solid ${C.border}`, fontSize: 10 }} formatter={(v, n) => [`$${v}`, n]} labelFormatter={() => ""} />
                <Line type="monotone" dataKey="ema50" stroke={C.purple} strokeWidth={1.5} dot={false} strokeDasharray="5 3" />
                <Line type="monotone" dataKey="ema20" stroke={C.blue}   strokeWidth={1.5} dot={false} />
                <Line type="monotone" dataKey="price" stroke={C.gold}   strokeWidth={2.5} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 }}>
            <div style={panel()}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                <span style={{ fontSize: 9, color: C.dim }}>RSI (14)</span>
                <span style={{ ...mono, fontSize: 11, color: ind.rsi > 70 ? C.red : ind.rsi < 30 ? C.green : C.amber }}>
                  {ind.rsi?.toFixed(1)}{ind.rsi > 70 ? " OB" : ind.rsi < 30 ? " OS" : ""}
                </span>
              </div>
              <ResponsiveContainer width="100%" height={110}>
                <LineChart data={rsiData}>
                  <XAxis hide /><YAxis domain={[0,100]} hide />
                  <Tooltip contentStyle={{ background: C.panel2, border: `1px solid ${C.border}`, fontSize: 10 }} formatter={v => [v.toFixed(1),"RSI"]} labelFormatter={() => ""} />
                  <ReferenceLine y={70} stroke={C.red}    strokeDasharray="3 3" />
                  <ReferenceLine y={50} stroke={C.dimmer} strokeDasharray="2 3" />
                  <ReferenceLine y={30} stroke={C.green}  strokeDasharray="3 3" />
                  <Line type="monotone" dataKey="rsi" stroke={C.amber} strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div style={panel()}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                <span style={{ fontSize: 9, color: C.dim }}>ADX (14)</span>
                <span style={{ ...mono, fontSize: 11, color: ind.adx > 25 ? C.gold : C.dim }}>
                  {ind.adx?.toFixed(1)}{ind.adx > 25 ? " STRONG" : ind.adx < 18 ? " WEAK" : ""}
                </span>
              </div>
              <ResponsiveContainer width="100%" height={110}>
                <AreaChart data={adxData}>
                  <defs>
                    <linearGradient id="adxg" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor={C.purple} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={C.purple} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis hide /><YAxis domain={[0,60]} hide />
                  <Tooltip contentStyle={{ background: C.panel2, border: `1px solid ${C.border}`, fontSize: 10 }} formatter={v => [v.toFixed(1),"ADX"]} labelFormatter={() => ""} />
                  <ReferenceLine y={25} stroke={C.gold} strokeDasharray="4 3" />
                  <ReferenceLine y={18} stroke={C.blue} strokeDasharray="4 3" />
                  <Area type="monotone" dataKey="adx" stroke={C.purple} strokeWidth={2} fill="url(#adxg)" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {/* ══ NEWS ══ */}
      {tab === "overview" && (
        <div style={panel({ marginTop: 0 })}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 11 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Zap size={12} color={C.amber} />
              <span style={{ fontSize: 10, color: C.amber, letterSpacing: ".1em", fontWeight: 700 }}>LIVE MARKET NEWS</span>
              {newsLoading && <span style={{ fontSize: 9, color: C.dim }}>Loading...</span>}
            </div>
            <button onClick={fetchNews} style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 4, padding: "2px 8px", color: C.dim, cursor: "pointer", fontSize: 9, display: "flex", alignItems: "center", gap: 4 }}>
              <RefreshCw size={9} /> Refresh
            </button>
          </div>
          {news.length === 0 && !newsLoading && (
            <div style={{ color: C.dim, fontSize: 11, textAlign: "center", padding: "14px 0" }}>
              No news yet — using demo API key. Add your Finnhub key for live news.
            </div>
          )}
          {news.map(n => (
            <a key={n.id} href={n.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
              <div style={{ display: "flex", gap: 10, padding: "8px 0", borderBottom: `1px solid ${C.border}18`, cursor: "pointer" }}
                onMouseEnter={e => e.currentTarget.style.background = C.panel2}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <div style={{ width: 4, borderRadius: 2, background: n.sentiment === "bull" ? C.green : n.sentiment === "bear" ? C.red : C.dim, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: C.text, lineHeight: 1.4, marginBottom: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.headline}</div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span style={{ fontSize: 9, color: C.dim }}>{n.source}</span>
                    <span style={{ fontSize: 9, color: C.dimmer }}>· {n.time}</span>
                    <span style={{ fontSize: 9, fontWeight: 700, color: n.sentiment === "bull" ? C.green : n.sentiment === "bear" ? C.red : C.dim }}>
                      {n.sentiment === "bull" ? "↑ BULLISH" : n.sentiment === "bear" ? "↓ BEARISH" : "◆ NEUTRAL"}
                    </span>
                  </div>
                </div>
              </div>
            </a>
          ))}
        </div>
      )}

      {/* ══ TRADES ══ */}
      {tab === "trades" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          <div style={panel()}>
            <div style={{ fontSize: 9, color: C.dim, marginBottom: 9 }}>OPEN POSITIONS ({openTrades.length})</div>
            {openTrades.length === 0 ? <div style={{ color: C.dim, padding: "18px", textAlign: "center", fontSize: 12 }}>No open positions</div> : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                  <thead><tr style={{ borderBottom: `1px solid ${C.border}` }}>
                    {["#","SIDE","STRATEGY","ENTRY","SL","TP","RISK","P&L"].map(h => (
                      <th key={h} style={{ padding: "4px 7px", color: C.dim, fontSize: 9, textAlign: "left" }}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {openTrades.map(t => {
                      const diff = t.dir === "long" ? price - t.entry : t.entry - price;
                      const sd   = Math.abs(t.entry - t.sl);
                      const unreal = sd > 0 ? (diff / sd) * t.risk : 0;
                      return (
                        <tr key={t.id} style={{ borderBottom: `1px solid ${C.border}18` }}>
                          <td style={{ padding: "6px 7px", color: C.dim, ...mono }}>#{t.id}</td>
                          <td style={{ padding: "6px 7px" }}><span style={badge(t.dir === "long" ? C.green : C.red)}>{t.dir.toUpperCase()}</span></td>
                          <td style={{ padding: "6px 7px" }}>{t.strat}</td>
                          <td style={{ padding: "6px 7px", ...mono }}>{t.entry.toFixed(2)}</td>
                          <td style={{ padding: "6px 7px", ...mono, color: C.red }}>{t.sl.toFixed(2)}</td>
                          <td style={{ padding: "6px 7px", ...mono, color: C.green }}>{t.tp.toFixed(2)}</td>
                          <td style={{ padding: "6px 7px", ...mono, color: C.amber }}>${t.risk.toFixed(2)}</td>
                          <td style={{ padding: "6px 7px", ...mono, color: pnlColor(unreal), fontWeight: 700 }}>{unreal >= 0 ? "+" : ""}${unreal.toFixed(2)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div style={panel()}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 9 }}>
              <span style={{ fontSize: 9, color: C.dim }}>CLOSED TRADES ({closedTrades.length})</span>
              <span style={{ ...mono, fontSize: 11, color: pnlColor(stats.totalPnL) }}>Total: {stats.totalPnL >= 0 ? "+" : ""}${stats.totalPnL.toFixed(2)}</span>
            </div>
            {closedTrades.length === 0 ? <div style={{ color: C.dim, padding: "18px", textAlign: "center", fontSize: 12 }}>No closed trades</div> : (
              <div style={{ maxHeight: 300, overflowY: "auto", overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                  <thead><tr style={{ borderBottom: `1px solid ${C.border}` }}>
                    {["#","SIDE","STRATEGY","ENTRY","EXIT","RESULT","P&L"].map(h => (
                      <th key={h} style={{ padding: "4px 7px", color: C.dim, fontSize: 9, textAlign: "left", position: "sticky", top: 0, background: C.panel }}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {closedTrades.map(t => (
                      <tr key={t.id + "c"} className="fadein" style={{ borderBottom: `1px solid ${C.border}15` }}>
                        <td style={{ padding: "5px 7px", color: C.dim, ...mono }}>#{t.id}</td>
                        <td style={{ padding: "5px 7px" }}><span style={badge(t.dir === "long" ? C.green : C.red)}>{t.dir.toUpperCase()}</span></td>
                        <td style={{ padding: "5px 7px", fontSize: 10 }}>{t.strat}</td>
                        <td style={{ padding: "5px 7px", ...mono }}>{t.entry.toFixed(2)}</td>
                        <td style={{ padding: "5px 7px", ...mono }}>{t.exit?.toFixed(2)}</td>
                        <td style={{ padding: "5px 7px" }}><span style={badge(t.reason === "TP" ? C.green : C.red)}>{t.reason === "TP" ? "✓ TP" : "✗ SL"}</span></td>
                        <td style={{ padding: "5px 7px", ...mono, color: pnlColor(t.pnl), fontWeight: 700 }}>{t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ══ MT5 ══ */}
      {tab === "mt5" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          {!brokerConnected ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              {/* Status banner */}
              <div style={{ ...panel(), display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 38, height: 38, borderRadius: 8, background: C.red + "15", border: `1px solid ${C.red}30`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Lock size={18} color={C.red} />
                  </div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>MT5 Not Connected</div>
                    <div style={{ fontSize: 11, color: C.dim, marginTop: 2 }}>Follow the steps below to connect your Exness account</div>
                  </div>
                </div>
                <button onClick={() => setShowLoginPanel(true)} style={{ padding: "9px 20px", background: C.gold + "15", border: `1px solid ${C.gold}44`, borderRadius: 6, color: C.gold, cursor: "pointer", fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
                  <LogIn size={13} /> Open Login Panel
                </button>
              </div>
              {/* Step-by-step guide */}
              <div style={panel()}>
                <div style={{ fontSize: 10, color: C.gold, letterSpacing: ".12em", fontWeight: 700, marginBottom: 14 }}>⚡ HOW TO CONNECT YOUR MT5 ACCOUNT</div>
                {[
                  { num: "1", title: "Get a Windows VPS", desc: "Buy a cheap Windows VPS (e.g. Contabo, Vultr, AWS). Minimum: 1 CPU, 2GB RAM.", color: C.blue },
                  { num: "2", title: "Install MT5 on VPS", desc: "Download MetaTrader 5 from exness.com. Login with account #413455206 on Exness-MT5Trial6.", color: C.purple },
                  { num: "3", title: "Run bridge_windows.py", desc: "Copy bridge_windows.py to VPS Desktop. Open CMD and run: python bridge_windows.py", color: C.amber },
                  { num: "4", title: "Open Firewall Port", desc: "In Windows Firewall, allow inbound TCP port 8000. Or run: netsh advfirewall firewall add rule name=\"XAUBot\" dir=in action=allow protocol=TCP localport=8000", color: C.green },
                  { num: "5", title: "Set VPS IP in Settings", desc: "Go to SETTINGS → VPS Bridge URL. Change to ws://YOUR_VPS_IP:8000/ws. Then click CONNECT BROKER above.", color: C.gold },
                ].map(({ num, title, desc, color }) => (
                  <div key={num} style={{ display: "flex", gap: 12, padding: "11px 0", borderBottom: `1px solid ${C.border}22` }}>
                    <div style={{ width: 26, height: 26, borderRadius: "50%", background: color + "18", border: `1.5px solid ${color}44`, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "monospace", fontSize: 12, fontWeight: 700, color, flexShrink: 0, marginTop: 1 }}>{num}</div>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 3 }}>{title}</div>
                      <div style={{ fontSize: 11, color: C.dim, lineHeight: 1.5 }}>{desc}</div>
                    </div>
                  </div>
                ))}
              </div>
              {/* Quick info cards */}
              <div className="mt5-info-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
                {[
                  { label: "YOUR ACCOUNT",  val: "#413455206",          sub: "Exness Demo",          color: C.gold   },
                  { label: "SERVER",         val: "MT5Trial6",           sub: "Exness-MT5Trial6",     color: C.blue   },
                  { label: "BRIDGE PORT",    val: ":8000",               sub: "ws://VPS_IP:8000/ws",  color: C.green  },
                ].map(({ label, val, sub, color }) => (
                  <div key={label} style={{ ...panel({ padding: "11px 13px" }) }}>
                    <div style={{ fontSize: 9, color: C.dim, letterSpacing: ".1em", marginBottom: 4 }}>{label}</div>
                    <div style={{ fontFamily: "monospace", fontSize: 16, fontWeight: 700, color, marginBottom: 2 }}>{val}</div>
                    <div style={{ fontSize: 10, color: C.dim }}>{sub}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 7 }}>
                {[
                  { label: "BALANCE",     val: `$${parseFloat(brokerAccount?.balance||0).toFixed(2)}`,    color: C.green  },
                  { label: "EQUITY",      val: `$${parseFloat(brokerAccount?.equity||0).toFixed(2)}`,     color: C.blue   },
                  { label: "MARGIN",      val: `$${parseFloat(brokerAccount?.margin||0).toFixed(2)}`,     color: C.amber  },
                  { label: "FREE MARGIN", val: `$${parseFloat(brokerAccount?.freeMargin||0).toFixed(2)}`, color: C.purple },
                ].map(({ label, val, color }) => (
                  <div key={label} style={panel({ padding: "11px 13px" })}>
                    <div style={{ fontSize: 9, color: C.dim, letterSpacing: ".1em", marginBottom: 4 }}>{label}</div>
                    <div style={{ ...mono, fontSize: 22, fontWeight: 700, color }}>{val}</div>
                  </div>
                ))}
              </div>
              <div style={panel()}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 9 }}>
                  <span style={{ fontSize: 9, color: C.dim }}>MT5 OPEN POSITIONS</span>
                  <button onClick={() => wsRef.current?.send(JSON.stringify({ type: "GET_TRADES" }))}
                    style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 9px", background: "transparent", border: `1px solid ${C.border}`, borderRadius: 4, color: C.dim, cursor: "pointer", fontSize: 10 }}>
                    <RefreshCw size={10} />Refresh
                  </button>
                </div>
                {mt5Trades.length === 0 ? (
                  <div style={{ color: C.dim, padding: "18px", textAlign: "center", fontSize: 12 }}>No open positions on MT5</div>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                      <thead><tr style={{ borderBottom: `1px solid ${C.border}` }}>
                        {["TICKET","SYMBOL","TYPE","VOL","ENTRY","SL","TP","PROFIT","CLOSE"].map(h => (
                          <th key={h} style={{ padding: "4px 7px", color: C.dim, fontSize: 9, textAlign: "left" }}>{h}</th>
                        ))}
                      </tr></thead>
                      <tbody>
                        {mt5Trades.map(t => (
                          <tr key={t.ticket} style={{ borderBottom: `1px solid ${C.border}18` }}>
                            <td style={{ padding: "6px 7px", ...mono, color: C.dim }}>#{t.ticket}</td>
                            <td style={{ padding: "6px 7px", color: C.gold }}>{t.symbol}</td>
                            <td style={{ padding: "6px 7px" }}><span style={badge(t.type === "buy" ? C.green : C.red)}>{t.type?.toUpperCase()}</span></td>
                            <td style={{ padding: "6px 7px", ...mono }}>{t.volume}</td>
                            <td style={{ padding: "6px 7px", ...mono }}>{t.entry?.toFixed(2)}</td>
                            <td style={{ padding: "6px 7px", ...mono, color: C.red }}>{t.sl?.toFixed(2)}</td>
                            <td style={{ padding: "6px 7px", ...mono, color: C.green }}>{t.tp?.toFixed(2)}</td>
                            <td style={{ padding: "6px 7px", ...mono, color: pnlColor(t.profit), fontWeight: 700 }}>{t.profit >= 0 ? "+" : ""}${t.profit?.toFixed(2)}</td>
                            <td style={{ padding: "6px 7px" }}>
                              <button onClick={() => closeTradeOnMT5(t.ticket)}
                                style={{ padding: "3px 7px", background: C.red + "15", border: `1px solid ${C.red}40`, borderRadius: 4, color: C.red, cursor: "pointer", fontSize: 9, fontWeight: 700 }}>
                                CLOSE
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
              {mt5History.length > 0 && (
                <div style={panel()}>
                  <div style={{ fontSize: 9, color: C.dim, marginBottom: 9 }}>MT5 HISTORY (last 50)</div>
                  <div style={{ maxHeight: 260, overflowY: "auto", overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                      <thead><tr style={{ borderBottom: `1px solid ${C.border}` }}>
                        {["TICKET","TYPE","VOL","PRICE","PROFIT","TIME"].map(h => (
                          <th key={h} style={{ padding: "4px 7px", color: C.dim, fontSize: 9, textAlign: "left", position: "sticky", top: 0, background: C.panel }}>{h}</th>
                        ))}
                      </tr></thead>
                      <tbody>
                        {mt5History.map((t, i) => (
                          <tr key={i} style={{ borderBottom: `1px solid ${C.border}14` }}>
                            <td style={{ padding: "5px 7px", ...mono, color: C.dim }}>#{t.ticket}</td>
                            <td style={{ padding: "5px 7px" }}><span style={badge(t.type === "buy" ? C.green : C.red)}>{t.type?.toUpperCase()}</span></td>
                            <td style={{ padding: "5px 7px", ...mono }}>{t.volume}</td>
                            <td style={{ padding: "5px 7px", ...mono }}>{t.price?.toFixed(2)}</td>
                            <td style={{ padding: "5px 7px", ...mono, color: pnlColor(t.profit), fontWeight: 700 }}>{t.profit >= 0 ? "+" : ""}${t.profit?.toFixed(2)}</td>
                            <td style={{ padding: "5px 7px", fontSize: 10, color: C.dim }}>{t.time}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ══ LOG ══ */}
      {tab === "log" && (
        <div style={{ ...panel(), maxHeight: 520, overflowY: "auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 9 }}>
            <span style={{ fontSize: 9, color: C.dim }}>SYSTEM LOG ({logs.length})</span>
            <button onClick={() => setLogs([{ id: Date.now(), time: new Date().toLocaleTimeString(), msg: "Log cleared.", type: "info" }])}
              style={{ fontSize: 9, color: C.dim, background: "none", border: `1px solid ${C.border}`, borderRadius: 3, padding: "2px 7px", cursor: "pointer" }}>CLEAR</button>
          </div>
          {logs.map(l => (
            <div key={l.id} className="fadein" style={{ display: "flex", gap: 9, padding: "5px 0", borderBottom: `1px solid ${C.border}15` }}>
              <span style={{ ...mono, color: C.dimmer, fontSize: 9, whiteSpace: "nowrap" }}>{l.time}</span>
              <div style={{ width: 5, height: 5, borderRadius: "50%", background: l.type === "win" ? C.green : l.type === "loss" ? C.red : l.type === "signal" ? C.gold : C.dim, marginTop: 4, flexShrink: 0 }} />
              <span style={{ fontSize: 11, color: l.type === "win" ? C.green : l.type === "loss" ? C.red : l.type === "signal" ? C.gold : C.text, lineHeight: 1.4 }}>{l.msg}</span>
            </div>
          ))}
        </div>
      )}

      {/* ══ SETTINGS ══ */}
      {tab === "settings" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          {/* ── STRATEGY PRESETS ── */}
          <div style={panel()}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 13 }}>
              <Zap size={13} color={C.gold} />
              <span style={{ fontSize: 10, color: C.gold, letterSpacing: ".12em", fontWeight: 700 }}>QUICK STRATEGY PRESETS</span>
              <span style={{ fontSize: 9, color: C.dim, marginLeft: 4 }}>— tap to apply instantly</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
              {[
                { name: "Conservative", icon: "♟️", risk: 1,   maxDD: 8,  trend: true,  meanRev: false, color: C.green,  sub: "Low risk · 1% per trade · 8% max DD" },
                { name: "Balanced",     icon: "♞",  risk: 2,   maxDD: 15, trend: true,  meanRev: true,  color: C.gold,   sub: "Medium risk · 2% per trade · 15% max DD" },
                { name: "Aggressive",   icon: "♛",  risk: 4,   maxDD: 25, trend: true,  meanRev: true,  color: C.red,    sub: "High risk · 4% per trade · 25% max DD" },
              ].map(({ name, icon, risk, maxDD, trend, meanRev, color, sub }) => {
                const active = settings.risk === risk && settings.maxDD === maxDD;
                return (
                  <div key={name}
                    onClick={() => { setSettings(s => ({ ...s, risk, maxDD, trend, meanRev })); addAlert(`✅ ${name} preset applied`, "success"); addLog(`⚙️ Preset changed to ${name} (Risk ${risk}%, Max DD ${maxDD}%)`, "info"); }}
                    style={{ padding: "13px 12px", background: active ? color + "12" : C.panel2, border: `1.5px solid ${active ? color + "55" : C.border}`, borderRadius: 9, cursor: "pointer", transition: "all .2s" }}>
                    <div style={{ fontSize: 22, marginBottom: 6 }}>{icon}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: active ? color : C.text, marginBottom: 4 }}>{name}</div>
                    <div style={{ fontSize: 10, color: C.dim, lineHeight: 1.4 }}>{sub}</div>
                    {active && <div style={{ marginTop: 7, fontSize: 9, color, fontWeight: 700, letterSpacing: ".08em" }}>● ACTIVE</div>}
                  </div>
                );
              })}
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 }}>
            <div style={panel()}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 14 }}>
                <Shield size={13} color={C.gold} />
                <span style={{ fontSize: 10, color: C.gold, letterSpacing: ".1em", fontWeight: 700 }}>RISK MANAGEMENT</span>
              </div>
              {[
                { key: "risk",  label: "Risk per trade", min: 0.5, max: 5,  step: 0.5, unit: "%", color: C.gold },
                { key: "maxDD", label: "Max drawdown",    min: 5,   max: 30, step: 1,   unit: "%", color: C.red  },
              ].map(({ key, label, min, max, step, unit, color }) => (
                <div key={key} style={{ marginBottom: 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                    <span style={{ fontSize: 12 }}>{label}</span>
                    <span style={{ ...mono, color, fontSize: 13 }}>{settings[key]}{unit}</span>
                  </div>
                  <input type="range" min={min} max={max} step={step} value={settings[key]}
                    onChange={e => setSettings(s => ({ ...s, [key]: +e.target.value }))}
                    style={{ width: "100%", accentColor: color }} />
                </div>
              ))}
              <div style={{ marginTop: 6, padding: "8px 11px", background: C.amber + "08", border: `1px solid ${C.amber}20`, borderRadius: 5, fontSize: 11, color: C.amber }}>
                ⚠️ Circuit breaker stops bot at {settings.maxDD}% drawdown
              </div>
            </div>
            <div style={panel()}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12 }}>
                <Zap size={13} color={C.gold} />
                <span style={{ fontSize: 10, color: C.gold, letterSpacing: ".1em", fontWeight: 700 }}>STRATEGY</span>
              </div>
              {[
                { key: "trend",   label: "Trend Following",   sub: "EMA(20/50) + RSI(14) > 50",     color: C.gold },
                { key: "meanRev", label: "Mean Reversion",    sub: "BB(20,2σ) + RSI extremes 68/32", color: C.blue },
              ].map(({ key, label, sub, color }) => (
                <div key={key} onClick={() => setSettings(s => ({ ...s, [key]: !s[key] }))}
                  style={{ padding: 12, marginBottom: 7, background: settings[key] ? color + "0d" : C.panel2, border: `1.5px solid ${settings[key] ? color + "44" : C.border}`, borderRadius: 7, cursor: "pointer", transition: "all .2s" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: settings[key] ? color : C.dim }}>{label}</div>
                      <div style={{ fontSize: 10, color: C.dim, marginTop: 2 }}>{sub}</div>
                    </div>
                    <div style={{ width: 36, height: 19, borderRadius: 10, background: settings[key] ? color : C.border, position: "relative", transition: "all .2s", flexShrink: 0 }}>
                      <div style={{ position: "absolute", top: 2, left: settings[key] ? 18 : 2, width: 15, height: 15, borderRadius: "50%", background: "#fff", transition: "all .2s" }} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ── VPS BRIDGE SERVER ── */}
          <div style={panel()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Wifi size={13} color={C.blue} />
                <span style={{ fontSize: 10, color: C.blue, letterSpacing: ".1em", fontWeight: 700 }}>VPS BRIDGE SERVER</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "3px 10px", background: brokerConnected ? C.green + "15" : C.red + "12", border: `1px solid ${brokerConnected ? C.green + "40" : C.red + "30"}`, borderRadius: 4 }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: brokerConnected ? C.green : C.red }} />
                <span style={{ fontSize: 9, color: brokerConnected ? C.green : C.red, fontWeight: 700 }}>{brokerConnected ? `CONNECTED · ${bridgePing !== null ? bridgePing + "ms" : ""}` : "OFFLINE"}</span>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 8, alignItems: "center", marginBottom: 10 }}>
              <input type="text" value={settings.bridgeUrl}
                onChange={e => setSettings(s => ({ ...s, bridgeUrl: e.target.value }))}
                placeholder="ws://YOUR_VPS_IP:8000/ws"
                style={{ background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 5, padding: "9px 12px", color: C.text, fontSize: 12, ...mono }} />
              <button onClick={() => { addLog(`📡 Bridge URL updated to: ${settings.bridgeUrl}`, "info"); addAlert("✅ URL saved — use CONNECT BROKER to connect", "success"); }}
                style={{ padding: "9px 14px", background: C.blue + "15", border: `1px solid ${C.blue}40`, borderRadius: 5, color: C.blue, cursor: "pointer", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>
                SAVE
              </button>
              <button
                onClick={() => {
                  if (!brokerLogin.login || !brokerLogin.password) {
                    setShowLoginPanel(true);
                    addAlert("⚠️ Enter login credentials first", "warn");
                    return;
                  }
                  connectBridge(brokerLogin.login, brokerLogin.password, brokerLogin.server);
                }}
                style={{ padding: "9px 14px", background: C.green + "15", border: `1px solid ${C.green}40`, borderRadius: 5, color: C.green, cursor: "pointer", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap", opacity: brokerConnecting ? 0.6 : 1 }}>
                {brokerConnecting ? "CONNECTING..." : "TEST CONNECT"}
              </button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {[
                { label: "🍎 Local Mac", val: "ws://localhost:8000/ws",   desc: "For testing — bridge.py running on this Mac" },
                { label: "🖥 Windows VPS", val: "ws://YOUR_VPS_IP:8000/ws", desc: "Replace YOUR_VPS_IP with your VPS public IP" },
              ].map(({ label, val, desc }) => (
                <div key={label} onClick={() => setSettings(s => ({ ...s, bridgeUrl: val }))}
                  style={{ padding: "9px 11px", background: settings.bridgeUrl === val ? C.blue + "10" : C.panel2, border: `1px solid ${settings.bridgeUrl === val ? C.blue + "40" : C.border}`, borderRadius: 6, cursor: "pointer", transition: "all .2s" }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: C.text, marginBottom: 3 }}>{label}</div>
                  <div style={{ ...mono, fontSize: 9, color: C.gold, marginBottom: 3 }}>{val}</div>
                  <div style={{ fontSize: 9, color: C.dimmer }}>{desc}</div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 10, padding: "8px 11px", background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 5, fontSize: 11, color: C.dim }}>
              💡 After editing URL → click <strong style={{ color: C.text }}>SAVE</strong> → then <strong style={{ color: C.text }}>TEST CONNECT</strong>.
              For local testing run <span style={mono}>python3 bridge.py</span> and use <span style={mono}>ws://localhost:8000/ws</span>; on a VPS run the same bridge
              and point the URL to <span style={mono}>ws://YOUR_VPS_IP:8000/ws</span>.
            </div>
          </div>
        </div>
      )}

      {/* FOOTER */}
      <div style={{ marginTop: 10, paddingTop: 8, borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", fontSize: 9, color: C.dimmer, flexWrap: "wrap", gap: 4 }}>
        <span>XAUUSDm · EXNESS MT5 · v7.0 · Educational use · Not financial advice</span>
        <span style={mono}>{running ? <span style={{ color: C.green }}>● LIVE</span> : "○ IDLE"} · ${price.toFixed(2)} · {srcLabel} · {regime}</span>
      </div>
    </div>
  );
}
