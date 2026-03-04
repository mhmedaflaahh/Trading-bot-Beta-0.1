import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  AreaChart, Area, LineChart, Line,
  XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine
} from "recharts";
import {
  Play, Square, TrendingUp, TrendingDown, Zap,
  Shield, BarChart2, FileText, Settings,
  Wifi, WifiOff, Lock, LogIn, LogOut, RefreshCw, User
} from "lucide-react";

// ═══════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════
const REAL_BASE   = 5110;
const PRICE_MIN   = 4800;
const PRICE_MAX   = 5600;
const SPREAD      = 0.30;

// Finnhub free API key — get yours free at finnhub.io
// Replace with your own key from finnhub.io/register
const FINNHUB_KEY = "d6jir81r01qkvh5q3gq0d6jir81r01qkvh5q3gqg"; // <-- replace with your key

// Python bridge URL — your local or deployed bridge.py
const BRIDGE_URL  = "ws://localhost:8000/ws";

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
  if (sl.length < p) { const c = closes.slice(-1)[0]; return { u: c + 30, mid: c, l: c - 30 }; }
  const mean = sl.reduce((a, b) => a + b, 0) / p;
  const std = Math.sqrt(sl.reduce((a, b) => a + (b - mean) ** 2, 0) / p);
  return { u: mean + m * std, mid: mean, l: mean - m * std };
};
const calcATR = (candles, p = 14) => {
  const sl = candles.slice(-p);
  if (sl.length < 2) return 15;
  const trs = sl.map((c, i, a) => {
    if (i === 0) return c.h - c.l;
    return Math.max(c.h - c.l, Math.abs(c.h - a[i - 1].c), Math.abs(c.l - a[i - 1].c));
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
    tR += Math.max(c.h - c.l, Math.abs(c.h - pv.c), Math.abs(c.l - pv.c));
  }
  if (tR === 0) return 20;
  const s = 100 * pDM / tR + 100 * mDM / tR;
  return s === 0 ? 20 : 100 * Math.abs(100 * pDM / tR - 100 * mDM / tR) / s;
};
const genCandles = (n = 120) => {
  let p = REAL_BASE, trend = 0;
  return Array.from({ length: n }, (_, i) => {
    const rev = (REAL_BASE - p) * 0.003;
    trend = trend * 0.94 + (Math.random() - 0.5) * 0.15;
    const ch = trend * 8 + rev + (Math.random() - 0.5) * 12;
    const o = p, c = Math.max(PRICE_MIN, Math.min(PRICE_MAX, p + ch));
    const hl = Math.random() * 5 + Math.abs(ch) * 0.4;
    p = c;
    return { o, h: Math.max(o, c) + hl, l: Math.min(o, c) - hl, c, t: i };
  });
};

// ═══════════════════════════════════════
//  COLORS
// ═══════════════════════════════════════
const C = {
  bg: '#06080f', panel: '#0d1220', panel2: '#111827',
  border: '#1a2840', gold: '#D4AF37', green: '#00C896',
  red: '#FF4050', blue: '#60A5FA', purple: '#A78BFA',
  amber: '#F59E0B', text: '#c8d8f0', dim: '#4a5a7a', dimmer: '#2a3a52',
};

// ═══════════════════════════════════════
//  MAIN COMPONENT
// ═══════════════════════════════════════
export default function XAUUSDBot() {
  const initCandles = useMemo(() => genCandles(), []);

  // ─── PRICE STATE ───
const [candles, setCandles]     = useState(initCandles);
const [price, setPrice]         = useState(REAL_BASE);
const [, setPrevPrice]          = useState(REAL_BASE);
const [priceDir, setPriceDir]   = useState(0);
const [priceSource, setPriceSource] = useState("simulation");
  // ─── BOT STATE ───
  const [equity, setEquity]       = useState(100);
  const [peakEq, setPeakEq]       = useState(100);
  const [eqHistory, setEqHistory] = useState([{ t: 0, v: 100 }]);
  const [openTrades, setOpenTrades]   = useState([]);
  const [closedTrades, setClosedTrades] = useState([]);
  const [ind, setInd]             = useState({});
  const [regime, setRegime]       = useState('SCANNING');
  const [lastSignal, setLastSignal] = useState(null);
  const [running, setRunning]     = useState(false);
  const [tab, setTab]             = useState('overview');
  const [tick, setTick]           = useState(0);
  const [stats, setStats]         = useState({ wins: 0, losses: 0, totalPnL: 0 });
  const [settings, setSettings]   = useState({ risk: 2, maxDD: 15, trend: true, meanRev: true });

  // ─── BROKER STATE ───
  const [brokerLogin, setBrokerLogin]   = useState({ login: '', password: '', server: 'Exness-MT5Trial' });
  const [brokerConnected, setBrokerConnected] = useState(false);
  const [brokerConnecting, setBrokerConnecting] = useState(false);
  const [brokerAccount, setBrokerAccount] = useState(null);
  const [bridgeConnected, setBridgeConnected] = useState(false);
  const [showLoginPanel, setShowLoginPanel] = useState(false);
  const [mt5Trades, setMt5Trades]   = useState([]);
  const [showPassword, setShowPassword] = useState(false);

  // ─── LOGS ───
  const [logs, setLogs] = useState([
    { id: 1, time: new Date().toLocaleTimeString(), msg: "XAUBot v3.0 ready. Connect broker or run simulation.", type: "info" }
  ]);

  const ref      = useRef({});
  const wsRef    = useRef(null);
  const finnRef  = useRef(null);
  const tradeId  = useRef(0);

  useEffect(() => {
    ref.current = { candles, equity, peakEq, openTrades, closedTrades, stats, tick, eqHistory, settings, price };
  });

  const addLog = useCallback((msg, type = "info") => {
    setLogs(p => [{ id: Date.now() + Math.random(), time: new Date().toLocaleTimeString(), msg, type }, ...p].slice(0, 300));
  }, []);

  // ═══════════════════════════════════════
  //  FINNHUB REAL PRICE CONNECTION
  // ═══════════════════════════════════════
  const connectFinnhub = useCallback(() => {
    if (finnRef.current) finnRef.current.close();
    const ws = new WebSocket("wss://ws.finnhub.io?token=" + FINNHUB_KEY);
    finnRef.current = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "subscribe", symbol: "OANDA:XAU_USD" }));
      setPriceSource("finnhub_live");
      addLog("📡 Finnhub connected — receiving real XAU/USD prices", "win");
    };
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "trade" && data.data && data.data.length > 0) {
          const latest = data.data[data.data.length - 1];
          const newP = latest.p;
          if (newP && newP > 1000) {
            setPrice(prev => {
              setPrevPrice(prev);
              setPriceDir(newP > prev ? 1 : newP < prev ? -1 : 0);
              return newP;
            });
            setPriceSource("finnhub_live");
          }
        }
      } catch {}
    };
    ws.onerror = () => {
      setPriceSource("simulation");
      addLog("⚠️ Finnhub unavailable — using simulation. Add your API key at finnhub.io", "info");
    };
    ws.onclose = () => setPriceSource("simulation");
    return () => ws.close();
  }, [addLog]);

  // Connect Finnhub on mount
  useEffect(() => {
    const cleanup = connectFinnhub();
    return cleanup;
  }, [connectFinnhub]);

  // ═══════════════════════════════════════
  //  PYTHON BRIDGE / MT5 CONNECTION
  // ═══════════════════════════════════════
  const connectBridge = useCallback((login, password, server) => {
    setBrokerConnecting(true);
    addLog("🔌 Connecting to MT5 bridge server...", "info");

    try {
      const ws = new WebSocket(BRIDGE_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setBridgeConnected(true);
        // Send login credentials to bridge
        ws.send(JSON.stringify({ type: "LOGIN", login, password, server }));
        addLog("🔗 Bridge connected — authenticating with Exness MT5...", "info");
      };

      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.type === "PRICE") {
            const newP = data.bid;
            setPrice(prev => {
              setPrevPrice(prev);
              setPriceDir(newP > prev ? 1 : -1);
              return newP;
            });
            setPriceSource("mt5_live");
          } else if (data.type === "ACCOUNT") {
            setBrokerAccount(data);
            setBrokerConnected(true);
            setBrokerConnecting(false);
            setEquity(data.equity);
            setPeakEq(prev => Math.max(prev, data.equity));
            addLog("✅ MT5 CONNECTED | Account: " + data.login + " | Balance: $" + data.balance.toFixed(2), "win");
          } else if (data.type === "CANDLES" && data.data.length) {
            setCandles(data.data);
            addLog("📊 Real H1 candles loaded from MT5 (" + data.data.length + " bars)", "info");
          } else if (data.type === "ORDER_RESULT") {
            addLog(
              data.status === "ok"
                ? "✅ ORDER PLACED on MT5 | Ticket #" + data.order
                : "❌ ORDER FAILED | " + data.msg,
              data.status === "ok" ? "win" : "loss"
            );
          } else if (data.type === "MT5_TRADES") {
            setMt5Trades(data.trades || []);
          } else if (data.type === "LOGIN_FAILED") {
            setBrokerConnecting(false);
            addLog("❌ MT5 Login failed — check your credentials", "loss");
          }
        } catch {}
      };

      ws.onclose = () => {
        setBridgeConnected(false);
        setBrokerConnected(false);
        setBrokerConnecting(false);
        addLog("🔴 Bridge disconnected", "info");
      };

      ws.onerror = () => {
        setBridgeConnected(false);
        setBrokerConnected(false);
        setBrokerConnecting(false);
        addLog("❌ Bridge not running. Start bridge.py on your machine first.", "loss");
      };
    } catch (err) {
      setBrokerConnecting(false);
      addLog("❌ Bridge connection error: " + err.message, "loss");
    }
  }, [addLog]);

  const disconnectBroker = useCallback(() => {
    if (wsRef.current) wsRef.current.close();
    setBrokerConnected(false);
    setBridgeConnected(false);
    setBrokerAccount(null);
    setMt5Trades([]);
    setPriceSource("simulation");
    addLog("⏹ Broker disconnected", "info");
  }, [addLog]);

  const sendOrderToMT5 = useCallback((direction, sl, tp, volume = 0.01) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "PLACE_ORDER", direction, sl, tp, volume }));
      addLog("📤 Sending " + direction + " order to MT5 @ $" + ref.current.price.toFixed(2), "signal");
    } else {
      addLog("⚠️ Not connected to MT5 — trade logged in simulation only", "info");
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
    const px = cands[cands.length - 1].c;
    const riskAmt = eq * (setts.risk / 100);
    const stopDist = atr * 1.5;
    const regime = adx > 25 ? "TRENDING" : adx < 18 ? "RANGING" : "NEUTRAL";
    if (openT.length >= 2) return { regime, signal: null };
    const hasLong  = openT.some(t => t.dir === "long");
    const hasShort = openT.some(t => t.dir === "short");
    let signal = null, strat = "", sl = 0, tp = 0;

    if (setts.trend && regime !== "RANGING") {
      const bullCross = prevEma20 <= prevEma50 && ema20 > ema50;
      const bearCross = prevEma20 >= prevEma50 && ema20 < ema50;
      if (bullCross && rsi > 50 && !hasLong)  { signal = "BUY";  strat = "EMA Cross ↗"; sl = px - stopDist; tp = px + stopDist * 2; }
      if (bearCross && rsi < 50 && !hasShort) { signal = "SELL"; strat = "EMA Cross ↘"; sl = px + stopDist; tp = px - stopDist * 2; }
    }
    if (!signal && setts.meanRev && regime !== "TRENDING") {
      const lastC = cands[cands.length - 1];
      const bullC = lastC.c > lastC.o, bearC = lastC.c < lastC.o;
      if (px >= bb.u && rsi > 68 && bearC && !hasShort) { signal = "SELL"; strat = "BB Reversion ↘"; sl = px + atr; tp = bb.mid; }
      if (px <= bb.l && rsi < 32 && bullC && !hasLong)  { signal = "BUY";  strat = "BB Reversion ↗"; sl = px - atr; tp = bb.mid; }
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
      const lastC = st.candles[st.candles.length - 1];
      const lastP = lastC.c;

// Only simulate price if not on live feed
if (priceSource === "simulation") {
  const rev = (REAL_BASE - lastP) * 0.002;
  const change = rev + (Math.random() - 0.5) * lastP * 0.0009;
  const newP = Math.max(
    PRICE_MIN,
    Math.min(PRICE_MAX, lastP + change)
  );

  setPrevPrice(lastP);
  setPriceDir(newP > lastP ? 1 : -1);
  setPrice(newP);
}
      const newTick = st.tick + 1;
      setTick(newTick);

      // Update candles
      const curP = st.price;
      let newCandles;
      if (newTick % 15 === 0) {
        const fin = { ...lastC, c: curP, h: Math.max(lastC.h, curP), l: Math.min(lastC.l, curP) };
        newCandles = [...st.candles.slice(-119), fin, { o: curP, h: curP, l: curP, c: curP, t: newTick }];
      } else {
        const upd = { ...lastC, c: curP, h: Math.max(lastC.h, curP), l: Math.min(lastC.l, curP) };
        newCandles = [...st.candles.slice(0, -1), upd];
      }
      setCandles(newCandles);

      const newInd = computeInd(newCandles);
      setInd(newInd);

      // Close trades
      let eq = st.equity, newStats = { ...st.stats };
      let newOpen = [], newClosed = [...st.closedTrades];
      for (const trade of st.openTrades) {
        const slHit = trade.dir === "long" ? curP <= trade.sl : curP >= trade.sl;
        const tpHit = trade.dir === "long" ? curP >= trade.tp : curP <= trade.tp;
        if (slHit || tpHit) {
          const pnl = slHit ? -trade.risk : trade.risk * 2;
          eq += pnl; newStats.totalPnL += pnl;
          pnl > 0 ? newStats.wins++ : newStats.losses++;
          newClosed = [{ ...trade, exit: curP, pnl, reason: slHit ? "SL" : "TP" }, ...newClosed].slice(0, 60);
          addLog((slHit ? "🛑 STOP LOSS" : "✅ TAKE PROFIT") + " | " + trade.strat + " | P&L: " + (pnl >= 0 ? "+" : "") + "$" + pnl.toFixed(2), pnl >= 0 ? "win" : "loss");
        } else newOpen.push(trade);
      }

      const newPeak = Math.max(st.peakEq, eq);

      // Signal check
      if (newTick % 6 === 0) {
        const res = strategize(newCandles, newInd, eq, newOpen, st.settings);
        setRegime(res.regime);
        setLastSignal(res.signal);
        if (res.signal && res.strat) {
          const id = ++tradeId.current;
          newOpen.push({ id, dir: res.signal === "BUY" ? "long" : "short", entry: curP, sl: res.sl, tp: res.tp, risk: res.riskAmt, strat: res.strat });
          addLog("📡 " + res.signal + " | " + res.strat + " @ $" + curP.toFixed(2) + " | SL $" + res.sl.toFixed(2) + " | TP $" + res.tp.toFixed(2), "signal");
          // Send to MT5 if connected
          if (bridgeConnected) sendOrderToMT5(res.signal, res.sl, res.tp, 0.01);
        }
      }

      setEquity(eq); setPeakEq(newPeak);
      setOpenTrades(newOpen); setClosedTrades(newClosed); setStats(newStats);
      if (newTick % 5 === 0) setEqHistory(p => [...p, { t: newTick, v: parseFloat(eq.toFixed(2)) }].slice(-120));
    }, 1200);
    return () => clearInterval(iv);
  }, [running, priceSource, computeInd, strategize, addLog, sendOrderToMT5, bridgeConnected]);

  // ─── DERIVED ───
  const drawdown = peakEq > 0 ? Math.max(0, (peakEq - equity) / peakEq * 100) : 0;
  const totalReturn = equity - 100;
  const winRate = (stats.wins + stats.losses) > 0 ? stats.wins / (stats.wins + stats.losses) * 100 : 0;
  const openPnL = openTrades.reduce((sum, t) => {
    const diff = t.dir === "long" ? price - t.entry : t.entry - price;
    const sd = Math.abs(t.entry - t.sl);
    return sum + (sd > 0 ? (diff / sd) * t.risk : 0);
  }, 0);
  const regimeColor = regime === "TRENDING" ? C.gold : regime === "RANGING" ? C.blue : C.dim;

  // ─── CHART DATA ───
  const priceData = useMemo(() => {
    const sl = candles.slice(-80);
    const closes = sl.map(c => c.c);
    const e20 = emaArr(closes, 20);
    const e50 = emaArr(closes, Math.min(50, closes.length - 1));
    return sl.map((c, i) => ({ i, price: +c.c.toFixed(2), ema20: +e20[i].toFixed(2), ema50: +e50[i].toFixed(2) }));
  }, [candles]);

  const rsiData  = useMemo(() => candles.slice(-60).map((_, i, a) => ({ i, rsi: +calcRSI(a.slice(0, i + 1).map(x => x.c)).toFixed(1) })), [candles]);
  const adxData  = useMemo(() => candles.slice(-60).map((_, i, a) => ({ i, adx: +calcADX(a.slice(0, i + 1)).toFixed(1) })), [candles]);

  // ─── STYLES ───
  const panel = (extra = {}) => ({ background: C.panel, border: "1px solid " + C.border, borderRadius: 8, padding: "14px 16px", ...extra });
  const mono = { fontFamily: "monospace" };
  const tabBtn = (active) => ({
    padding: "7px 14px", borderRadius: 4, background: active ? C.gold : "transparent",
    color: active ? "#000" : C.dim, border: "none", cursor: "pointer",
    fontWeight: 700, fontSize: 12, letterSpacing: "0.06em", transition: "all 0.18s",
  });
  const badge = (color) => ({
    fontSize: 10, padding: "1px 7px", borderRadius: 3,
    background: color + "22", color, fontWeight: 700, ...mono, border: "1px solid " + color + "44",
  });

  const srcColor = priceSource === "mt5_live" ? C.green : priceSource === "finnhub_live" ? C.blue : C.amber;
  const srcLabel = priceSource === "mt5_live" ? "MT5 LIVE" : priceSource === "finnhub_live" ? "FINNHUB LIVE" : "SIMULATION";

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", background: C.bg, color: C.text, minHeight: "100vh", padding: "12px 14px" }}>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 3px; }
        ::-webkit-scrollbar-thumb { background: #1a2840; border-radius: 2px; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
        @keyframes glow  { 0%,100%{box-shadow:0 0 10px rgba(212,175,55,.2)} 50%{box-shadow:0 0 22px rgba(212,175,55,.5)} }
        @keyframes fadein{ from{opacity:0;transform:translateY(-4px)} to{opacity:1;transform:translateY(0)} }
        .pulse{animation:pulse 2s infinite} .glow{animation:glow 2.5s infinite} .fadein{animation:fadein 0.3s ease}
        input { outline: none; }
      `}</style>

      {/* ══ HEADER ══ */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid " + C.border, paddingBottom: 10, marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div className={running ? "pulse" : ""} style={{ width: 9, height: 9, borderRadius: "50%", background: running ? C.green : C.dim }} />
          <span style={{ ...mono, color: C.gold, fontSize: 20, fontWeight: 700 }}>XAU/USD</span>
          <div style={{ padding: "2px 8px", background: C.gold + "18", border: "1px solid " + C.gold + "33", borderRadius: 4 }}>
            <span style={{ ...mono, fontSize: 10, color: C.gold }}>AUTO TRADER v3.0 · MT5</span>
          </div>
          {/* Data source badge */}
          <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 8px", background: srcColor + "12", border: "1px solid " + srcColor + "33", borderRadius: 4 }}>
            {priceSource !== "simulation" ? <Wifi size={10} color={srcColor} /> : <WifiOff size={10} color={srcColor} />}
            <span style={{ fontSize: 10, color: srcColor, ...mono }}>{srcLabel}</span>
          </div>
          {/* Broker status */}
          <div
            onClick={() => setShowLoginPanel(p => !p)}
            style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 10px", background: brokerConnected ? C.green + "15" : C.red + "12", border: "1px solid " + (brokerConnected ? C.green + "44" : C.red + "33"), borderRadius: 4, cursor: "pointer" }}
          >
            {brokerConnected ? <Wifi size={11} color={C.green} /> : <Lock size={11} color={C.dim} />}
            <span style={{ fontSize: 11, color: brokerConnected ? C.green : C.dim, fontWeight: 700 }}>
              {brokerConnected ? "EXNESS CONNECTED" : "CONNECT BROKER"}
            </span>
          </div>
        </div>

        {/* PRICE */}
        <div style={{ textAlign: "center" }}>
          <div style={{ ...mono, fontSize: 32, fontWeight: 700, lineHeight: 1, color: priceDir > 0 ? C.green : priceDir < 0 ? C.red : C.text }}>
            {price.toFixed(2)}
            <span style={{ fontSize: 13, marginLeft: 5 }}>{priceDir > 0 ? "▲" : priceDir < 0 ? "▼" : ""}</span>
          </div>
          <div style={{ fontSize: 9, color: C.dimmer, marginTop: 2 }}>
            BID {price.toFixed(2)} · ASK {(price + SPREAD).toFixed(2)} · TICK #{tick}
          </div>
        </div>

        <button
          onClick={() => { setRunning(r => !r); addLog(running ? "⏸ Bot stopped." : "▶ Bot started — scanning XAUUSDm...", "info"); }}
          className={running ? "glow" : ""}
          style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 20px", borderRadius: 6, background: running ? C.red + "18" : C.gold + "18", border: "1.5px solid " + (running ? C.red : C.gold), color: running ? C.red : C.gold, cursor: "pointer", fontSize: 14, fontWeight: 700, transition: "all 0.2s" }}
        >
          {running ? <><Square size={14} /> STOP</> : <><Play size={14} /> START BOT</>}
        </button>
      </div>

      {/* ══ BROKER LOGIN PANEL ══ */}
      {showLoginPanel && (
        <div className="fadein" style={{ ...panel({ marginBottom: 12, border: "1px solid " + (brokerConnected ? C.green + "44" : C.gold + "44") }) }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <User size={16} color={C.gold} />
              <span style={{ fontSize: 13, fontWeight: 700, color: C.gold, letterSpacing: ".08em" }}>
                EXNESS MT5 BROKER LOGIN
              </span>
            </div>
            {brokerConnected && (
              <button onClick={disconnectBroker} style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 12px", background: C.red + "18", border: "1px solid " + C.red + "44", borderRadius: 5, color: C.red, cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
                <LogOut size={12} /> DISCONNECT
              </button>
            )}
          </div>

          {brokerConnected && brokerAccount ? (
            // ─── ACCOUNT INFO ───
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
              {[
                { label: "ACCOUNT", val: brokerAccount.login, color: C.gold },
                { label: "BALANCE", val: "$" + brokerAccount.balance?.toFixed(2), color: C.green },
                { label: "EQUITY", val: "$" + brokerAccount.equity?.toFixed(2), color: C.blue },
                { label: "FREE MARGIN", val: "$" + brokerAccount.freeMargin?.toFixed(2), color: C.amber },
                { label: "SERVER", val: brokerAccount.server || "Exness-MT5Trial", color: C.dim },
                { label: "LEVERAGE", val: "1:" + (brokerAccount.leverage || "200"), color: C.purple },
                { label: "CURRENCY", val: brokerAccount.currency || "USD", color: C.text },
                { label: "TYPE", val: brokerAccount.type || "DEMO", color: C.amber },
              ].map(({ label, val, color }) => (
                <div key={label} style={{ background: C.panel2, border: "1px solid " + C.border, borderRadius: 6, padding: "10px 12px" }}>
                  <div style={{ fontSize: 9, color: C.dim, letterSpacing: ".1em", marginBottom: 4 }}>{label}</div>
                  <div style={{ ...mono, fontSize: 14, fontWeight: 700, color }}>{val}</div>
                </div>
              ))}
            </div>
          ) : (
            // ─── LOGIN FORM ───
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 10, alignItems: "end" }}>
              <div>
                <div style={{ fontSize: 11, color: C.dim, marginBottom: 5 }}>MT5 Account Number</div>
                <input
                  type="text" placeholder="e.g. 463055053"
                  value={brokerLogin.login}
                  onChange={e => setBrokerLogin(p => ({ ...p, login: e.target.value }))}
                  style={{ width: "100%", background: C.panel2, border: "1px solid " + C.border, borderRadius: 5, padding: "8px 12px", color: C.text, fontSize: 13, ...mono }}
                />
              </div>
              <div>
                <div style={{ fontSize: 11, color: C.dim, marginBottom: 5 }}>Password</div>
                <div style={{ position: "relative" }}>
                  <input
                    type={showPassword ? "text" : "password"} placeholder="MT5 password"
                    value={brokerLogin.password}
                    onChange={e => setBrokerLogin(p => ({ ...p, password: e.target.value }))}
                    style={{ width: "100%", background: C.panel2, border: "1px solid " + C.border, borderRadius: 5, padding: "8px 12px", paddingRight: 36, color: C.text, fontSize: 13 }}
                  />
                  <span onClick={() => setShowPassword(p => !p)} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", cursor: "pointer", color: C.dim, fontSize: 10 }}>
                    {showPassword ? "HIDE" : "SHOW"}
                  </span>
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: C.dim, marginBottom: 5 }}>Server</div>
                <select
                  value={brokerLogin.server}
                  onChange={e => setBrokerLogin(p => ({ ...p, server: e.target.value }))}
                  style={{ width: "100%", background: C.panel2, border: "1px solid " + C.border, borderRadius: 5, padding: "8px 12px", color: C.text, fontSize: 13 }}
                >
<option value="Exness-MT5Trial">Exness-MT5Trial</option>
<option value="Exness-MT5Trial2">Exness-MT5Trial2</option>
<option value="Exness-MT5Trial3">Exness-MT5Trial3</option>
<option value="Exness-MT5Trial4">Exness-MT5Trial4</option>
<option value="Exness-MT5Trial5">Exness-MT5Trial5</option>
<option value="Exness-MT5Trial6">Exness-MT5Trial6</option>
<option value="Exness-MT5Trial7">Exness-MT5Trial7</option>
<option value="Exness-MT5Trial8">Exness-MT5Trial8</option>
<option value="Exness-MT5Trial9">Exness-MT5Trial9</option>
<option value="Exness-MT5Trial10">Exness-MT5Trial10</option>
<option value="Exness-MT5Trial11">Exness-MT5Trial11</option>
<option value="Exness-MT5Trial12">Exness-MT5Trial12</option>
<option value="Exness-MT5Trial13">Exness-MT5Trial13</option>
<option value="Exness-MT5Trial14">Exness-MT5Trial14</option>
<option value="Exness-MT5Trial15">Exness-MT5Trial15</option>
<option value="Exness-MT5Trial16">Exness-MT5Trial16</option>
<option value="Exness-MT5Trial17">Exness-MT5Trial17 ← YOURS</option>
<option value="Exness-MT5Trial18">Exness-MT5Trial18</option>
<option value="Exness-MT5Trial19">Exness-MT5Trial19</option>
<option value="Exness-MT5Trial20">Exness-MT5Trial20</option>
<option value="Exness-MT5Real">Exness-MT5Real (Live)</option>
<option value="Exness-MT5Real2">Exness-MT5Real2</option>
<option value="Exness-MT5Real3">Exness-MT5Real3</option>
<option value="Exness-MT5Real4">Exness-MT5Real4</option>
<option value="Exness-MT5Real5">Exness-MT5Real5</option>
<option value="Exness-MT5Real6">Exness-MT5Real6</option>
<option value="Exness-MT5Real7">Exness-MT5Real7</option>
<option value="Exness-MT5Real8">Exness-MT5Real8</option>
```

Then save and push:
```
git add .
git commit -m "add all Exness servers"
git push origin main --force                </select>
              </div>
              <button
                onClick={() => connectBridge(brokerLogin.login, brokerLogin.password, brokerLogin.server)}
                disabled={brokerConnecting || !brokerLogin.login || !brokerLogin.password}
                style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 18px", borderRadius: 6, background: C.gold + "18", border: "1px solid " + C.gold + "55", color: C.gold, cursor: "pointer", fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", opacity: brokerConnecting ? 0.6 : 1 }}
              >
                {brokerConnecting ? <><RefreshCw size={13} /> Connecting...</> : <><LogIn size={13} /> CONNECT</>}
              </button>
            </div>
          )}

          <div style={{ marginTop: 10, padding: "8px 12px", background: C.amber + "0a", border: "1px solid " + C.amber + "22", borderRadius: 5, fontSize: 11, color: C.amber }}>
            ⚠️ Requires bridge.py running locally: <span style={{ ...mono }}>python3 bridge.py</span> · Your password is sent only to your local bridge — never stored externally
          </div>
        </div>
      )}

      {/* ══ STATS ══ */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 12 }}>
        {[
          { icon: <BarChart2 size={13} color={C.gold} />, label: "EQUITY", value: "$" + equity.toFixed(2), sub: (totalReturn >= 0 ? "+" : "") + totalReturn.toFixed(2) + "% return", col: totalReturn >= 0 ? C.green : C.red },
          { icon: <Zap size={13} color={C.amber} />, label: "OPEN P&L", value: (openPnL >= 0 ? "+" : "") + "$" + openPnL.toFixed(2), sub: openTrades.length + " position" + (openTrades.length !== 1 ? "s" : ""), col: openPnL >= 0 ? C.green : C.red },
          { icon: <Shield size={13} color={drawdown > 10 ? C.red : C.green} />, label: "DRAWDOWN", value: drawdown.toFixed(2) + "%", sub: "Peak $" + peakEq.toFixed(2) + " · Limit " + settings.maxDD + "%", col: drawdown > settings.maxDD * 0.7 ? C.red : C.green },
          { icon: <TrendingUp size={13} color={winRate > 50 ? C.green : C.red} />, label: "WIN RATE", value: winRate.toFixed(1) + "%", sub: stats.wins + "W / " + stats.losses + "L · $" + stats.totalPnL.toFixed(2), col: winRate > 55 ? C.green : winRate > 40 ? C.amber : C.red },
        ].map(({ icon, label, value, sub, col }) => (
          <div key={label} style={panel({ padding: "10px 13px" })}>
            <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 4 }}>
              {icon}<span style={{ fontSize: 10, color: C.dim, letterSpacing: ".1em" }}>{label}</span>
            </div>
            <div style={{ ...mono, fontSize: 22, fontWeight: 700, lineHeight: 1 }}>{value}</div>
            <div style={{ fontSize: 11, color: col, marginTop: 3 }}>{sub}</div>
          </div>
        ))}
      </div>

      {/* ══ TABS ══ */}
      <div style={{ display: "flex", gap: 3, marginBottom: 12, borderBottom: "1px solid " + C.border, paddingBottom: 8 }}>
        {[
          { key: "overview", icon: <Zap size={12} />, label: "OVERVIEW" },
          { key: "chart", icon: <BarChart2 size={12} />, label: "CHART" },
          { key: "trades", icon: <TrendingUp size={12} />, label: "TRADES" },
          { key: "mt5", icon: <Wifi size={12} />, label: "MT5 ACCOUNT" },
          { key: "log", icon: <FileText size={12} />, label: "LOG" },
          { key: "settings", icon: <Settings size={12} />, label: "SETTINGS" },
        ].map(({ key, icon, label }) => (
          <button key={key} style={tabBtn(tab === key)} onClick={() => setTab(key)}>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>{icon}{label}</span>
          </button>
        ))}
      </div>

      {/* ══ OVERVIEW ══ */}
      {tab === "overview" && (
        <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 10 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={panel()}>
              <div style={{ fontSize: 10, color: C.dim, letterSpacing: ".1em", marginBottom: 8 }}>MARKET REGIME</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div className="pulse" style={{ width: 8, height: 8, borderRadius: "50%", background: regimeColor }} />
                <span style={{ ...mono, fontSize: 20, color: regimeColor, fontWeight: 700 }}>{regime}</span>
              </div>
              <div style={{ marginTop: 6, fontSize: 11, color: C.dim }}>
                ADX: <span style={{ color: C.text }}>{ind.adx?.toFixed(1)}</span>
                {regime === "TRENDING" ? " · EMA Cross active" : regime === "RANGING" ? " · BB/RSI active" : " · Dual mode"}
              </div>
            </div>

            <div style={{ ...panel(), border: "1px solid " + (lastSignal ? (lastSignal === "BUY" ? C.green + "55" : C.red + "55") : C.border) }}>
              <div style={{ fontSize: 10, color: C.dim, letterSpacing: ".1em", marginBottom: 8 }}>LAST SIGNAL</div>
              {lastSignal ? (
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 40, height: 40, borderRadius: 8, background: (lastSignal === "BUY" ? C.green : C.red) + "18", border: "2px solid " + (lastSignal === "BUY" ? C.green : C.red), display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {lastSignal === "BUY" ? <TrendingUp size={18} color={C.green} /> : <TrendingDown size={18} color={C.red} />}
                  </div>
                  <div>
                    <div style={{ ...mono, fontSize: 22, fontWeight: 700, color: lastSignal === "BUY" ? C.green : C.red }}>{lastSignal}</div>
                    <div style={{ fontSize: 11, color: C.dim }}>{bridgeConnected ? "→ Sent to MT5" : "Simulation only"}</div>
                  </div>
                </div>
              ) : (
                <div style={{ color: C.dim, fontSize: 13 }}>{running ? "Scanning..." : "Start bot to scan"}</div>
              )}
            </div>

            <div style={panel()}>
              <div style={{ fontSize: 10, color: C.dim, letterSpacing: ".1em", marginBottom: 10 }}>LIVE INDICATORS</div>
              {[
                { label: "EMA 20", val: ind.ema20?.toFixed(2), color: C.blue },
                { label: "EMA 50", val: ind.ema50?.toFixed(2), color: C.purple },
                { label: "RSI (14)", val: ind.rsi?.toFixed(1), color: ind.rsi > 70 ? C.red : ind.rsi < 30 ? C.green : C.amber },
                { label: "BB Upper", val: ind.bb?.u?.toFixed(2), color: C.red },
                { label: "BB Lower", val: ind.bb?.l?.toFixed(2), color: C.green },
                { label: "ATR (14)", val: ind.atr?.toFixed(2), color: C.amber },
                { label: "ADX (14)", val: ind.adx?.toFixed(1), color: ind.adx > 25 ? C.gold : C.dim },
              ].map(({ label, val, color }) => (
                <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid " + C.border + "22" }}>
                  <span style={{ fontSize: 12, color: C.dim }}>{label}</span>
                  <span style={{ ...mono, fontSize: 12, color, fontWeight: 600 }}>{val ?? "—"}</span>
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={panel()}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 10, color: C.dim }}>EQUITY CURVE · $100 BASE</span>
                <span style={{ ...mono, fontSize: 12, color: totalReturn >= 0 ? C.green : C.red }}>
                  {totalReturn >= 0 ? "+" : ""}${totalReturn.toFixed(2)} ({totalReturn.toFixed(2)}%)
                </span>
              </div>
              <ResponsiveContainer width="100%" height={160}>
                <AreaChart data={eqHistory}>
                  <defs>
                    <linearGradient id="eg" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={C.gold} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={C.gold} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis hide /><YAxis domain={["auto","auto"]} tick={{ fontSize: 10, fill: C.dim }} width={48} tickFormatter={v => "$" + v.toFixed(0)} />
                  <Tooltip contentStyle={{ background: C.panel2, border: "1px solid " + C.border, fontSize: 11 }} formatter={v => ["$" + v.toFixed(2), "Equity"]} labelFormatter={() => ""} />
                  <ReferenceLine y={100} stroke={C.dimmer} strokeDasharray="4 4" />
                  <Area type="monotone" dataKey="v" stroke={C.gold} strokeWidth={2} fill="url(#eg)" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            <div style={panel()}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
                <span style={{ fontSize: 10, color: C.dim }}>OPEN POSITIONS</span>
                <span style={badge(openTrades.length > 0 ? C.amber : C.dim)}>{openTrades.length} / 2 MAX</span>
              </div>
              {openTrades.length === 0 ? (
                <div style={{ color: C.dim, fontSize: 13, textAlign: "center", padding: "18px 0" }}>
                  {running ? "🔍 Scanning XAUUSDm..." : "⏸ Start bot to begin"}
                </div>
              ) : openTrades.map(t => {
                const diff = t.dir === "long" ? price - t.entry : t.entry - price;
                const sd = Math.abs(t.entry - t.sl);
                const unreal = sd > 0 ? (diff / sd) * t.risk : 0;
                return (
                  <div key={t.id} className="fadein" style={{ background: C.panel2, border: "1px solid " + (t.dir === "long" ? C.green : C.red) + "44", borderRadius: 7, padding: "10px 12px", marginBottom: 6 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <span style={badge(t.dir === "long" ? C.green : C.red)}>{t.dir.toUpperCase()}</span>
                        <span style={{ fontSize: 12 }}>{t.strat}</span>
                        {bridgeConnected && <span style={badge(C.green)}>→ MT5</span>}
                      </div>
                      <span style={{ ...mono, fontSize: 15, fontWeight: 700, color: unreal >= 0 ? C.green : C.red }}>
                        {unreal >= 0 ? "+" : ""}${unreal.toFixed(2)}
                      </span>
                    </div>
                    <div style={{ display: "flex", gap: 12, fontSize: 11 }}>
                      <span style={{ color: C.dim }}>Entry <span style={{ color: C.text, ...mono }}>{t.entry.toFixed(2)}</span></span>
                      <span style={{ color: C.red }}>SL <span style={{ ...mono }}>{t.sl.toFixed(2)}</span></span>
                      <span style={{ color: C.green }}>TP <span style={{ ...mono }}>{t.tp.toFixed(2)}</span></span>
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
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={panel()}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ fontSize: 10, color: C.dim }}>XAUUSDm · PRICE + EMA20 + EMA50</span>
              <div style={{ display: "flex", gap: 12, fontSize: 11 }}>
                <span style={{ color: C.gold }}>── Price</span>
                <span style={{ color: C.blue }}>── EMA20</span>
                <span style={{ color: C.purple }}>── EMA50</span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={priceData}>
                <XAxis hide />
                <YAxis domain={["auto","auto"]} tick={{ fontSize: 10, fill: C.dim }} width={58} tickFormatter={v => v.toFixed(0)} />
                <Tooltip contentStyle={{ background: C.panel2, border: "1px solid " + C.border, fontSize: 11 }} formatter={(v, n) => ["$" + v, n]} labelFormatter={() => ""} />
                <Line type="monotone" dataKey="ema50" stroke={C.purple} strokeWidth={1.5} dot={false} strokeDasharray="5 3" />
                <Line type="monotone" dataKey="ema20" stroke={C.blue} strokeWidth={1.5} dot={false} />
                <Line type="monotone" dataKey="price" stroke={C.gold} strokeWidth={2.5} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div style={panel()}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontSize: 10, color: C.dim }}>RSI (14)</span>
                <span style={{ ...mono, fontSize: 12, color: ind.rsi > 70 ? C.red : ind.rsi < 30 ? C.green : C.amber }}>
                  {ind.rsi?.toFixed(1)}{ind.rsi > 70 ? " OVERBOUGHT" : ind.rsi < 30 ? " OVERSOLD" : ""}
                </span>
              </div>
              <ResponsiveContainer width="100%" height={120}>
                <LineChart data={rsiData}>
                  <XAxis hide /><YAxis domain={[0, 100]} hide />
                  <Tooltip contentStyle={{ background: C.panel2, border: "1px solid " + C.border, fontSize: 11 }} formatter={v => [v.toFixed(1), "RSI"]} labelFormatter={() => ""} />
                  <ReferenceLine y={70} stroke={C.red} strokeDasharray="3 3" />
                  <ReferenceLine y={50} stroke={C.dimmer} strokeDasharray="2 3" />
                  <ReferenceLine y={30} stroke={C.green} strokeDasharray="3 3" />
                  <Line type="monotone" dataKey="rsi" stroke={C.amber} strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div style={panel()}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontSize: 10, color: C.dim }}>ADX (14)</span>
                <span style={{ ...mono, fontSize: 12, color: ind.adx > 25 ? C.gold : C.dim }}>
                  {ind.adx?.toFixed(1)}{ind.adx > 25 ? " STRONG" : ind.adx < 18 ? " WEAK" : " MED"}
                </span>
              </div>
              <ResponsiveContainer width="100%" height={120}>
                <AreaChart data={adxData}>
                  <defs>
                    <linearGradient id="adxg" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={C.purple} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={C.purple} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis hide /><YAxis domain={[0, 60]} hide />
                  <Tooltip contentStyle={{ background: C.panel2, border: "1px solid " + C.border, fontSize: 11 }} formatter={v => [v.toFixed(1), "ADX"]} labelFormatter={() => ""} />
                  <ReferenceLine y={25} stroke={C.gold} strokeDasharray="4 3" />
                  <ReferenceLine y={18} stroke={C.blue} strokeDasharray="4 3" />
                  <Area type="monotone" dataKey="adx" stroke={C.purple} strokeWidth={2} fill="url(#adxg)" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {/* ══ TRADES ══ */}
      {tab === "trades" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={panel()}>
            <div style={{ fontSize: 10, color: C.dim, marginBottom: 10 }}>OPEN POSITIONS ({openTrades.length})</div>
            {openTrades.length === 0 ? <div style={{ color: C.dim, padding: 20, textAlign: "center" }}>No open positions</div> : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead><tr style={{ borderBottom: "1px solid " + C.border }}>
                  {["#","SIDE","STRATEGY","ENTRY","SL","TP","RISK","P&L"].map(h => (
                    <th key={h} style={{ padding: "4px 8px", color: C.dim, fontSize: 10, textAlign: "left" }}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {openTrades.map(t => {
                    const diff = t.dir === "long" ? price - t.entry : t.entry - price;
                    const sd = Math.abs(t.entry - t.sl);
                    const unreal = sd > 0 ? (diff / sd) * t.risk : 0;
                    return (
                      <tr key={t.id} style={{ borderBottom: "1px solid " + C.border + "22" }}>
                        <td style={{ padding: "7px 8px", color: C.dim, ...mono }}>#{t.id}</td>
                        <td style={{ padding: "7px 8px" }}><span style={badge(t.dir === "long" ? C.green : C.red)}>{t.dir.toUpperCase()}</span></td>
                        <td style={{ padding: "7px 8px" }}>{t.strat}</td>
                        <td style={{ padding: "7px 8px", ...mono }}>{t.entry.toFixed(2)}</td>
                        <td style={{ padding: "7px 8px", ...mono, color: C.red }}>{t.sl.toFixed(2)}</td>
                        <td style={{ padding: "7px 8px", ...mono, color: C.green }}>{t.tp.toFixed(2)}</td>
                        <td style={{ padding: "7px 8px", ...mono, color: C.amber }}>${t.risk.toFixed(2)}</td>
                        <td style={{ padding: "7px 8px", ...mono, color: unreal >= 0 ? C.green : C.red, fontWeight: 700 }}>{unreal >= 0 ? "+" : ""}${unreal.toFixed(2)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          <div style={panel()}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
              <span style={{ fontSize: 10, color: C.dim }}>CLOSED TRADES ({closedTrades.length})</span>
              <span style={{ ...mono, fontSize: 12, color: stats.totalPnL >= 0 ? C.green : C.red }}>Total: {stats.totalPnL >= 0 ? "+" : ""}${stats.totalPnL.toFixed(2)}</span>
            </div>
            {closedTrades.length === 0 ? <div style={{ color: C.dim, padding: 20, textAlign: "center" }}>No closed trades</div> : (
              <div style={{ maxHeight: 320, overflowY: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead><tr style={{ borderBottom: "1px solid " + C.border }}>
                    {["#","SIDE","STRATEGY","ENTRY","EXIT","RESULT","P&L"].map(h => (
                      <th key={h} style={{ padding: "4px 8px", color: C.dim, fontSize: 10, textAlign: "left", position: "sticky", top: 0, background: C.panel }}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {closedTrades.map(t => (
                      <tr key={t.id + "c"} className="fadein" style={{ borderBottom: "1px solid " + C.border + "18" }}>
                        <td style={{ padding: "6px 8px", color: C.dim, ...mono }}>#{t.id}</td>
                        <td style={{ padding: "6px 8px" }}><span style={badge(t.dir === "long" ? C.green : C.red)}>{t.dir.toUpperCase()}</span></td>
                        <td style={{ padding: "6px 8px", fontSize: 11 }}>{t.strat}</td>
                        <td style={{ padding: "6px 8px", ...mono }}>{t.entry.toFixed(2)}</td>
                        <td style={{ padding: "6px 8px", ...mono }}>{t.exit?.toFixed(2)}</td>
                        <td style={{ padding: "6px 8px" }}><span style={badge(t.reason === "TP" ? C.green : C.red)}>{t.reason === "TP" ? "✓ TP" : "✗ SL"}</span></td>
                        <td style={{ padding: "6px 8px", ...mono, color: t.pnl >= 0 ? C.green : C.red, fontWeight: 700 }}>{t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ══ MT5 ACCOUNT ══ */}
      {tab === "mt5" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {!brokerConnected ? (
            <div style={{ ...panel(), textAlign: "center", padding: "50px 20px" }}>
              <Lock size={40} color={C.dim} style={{ margin: "0 auto 16px" }} />
              <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 8 }}>Not Connected to Broker</div>
              <div style={{ color: C.dim, fontSize: 13, marginBottom: 18 }}>Click "CONNECT BROKER" in the header to link your Exness MT5 account</div>
              <button onClick={() => setShowLoginPanel(true)} style={{ padding: "10px 24px", background: C.gold + "18", border: "1px solid " + C.gold + "55", borderRadius: 6, color: C.gold, cursor: "pointer", fontSize: 14, fontWeight: 700 }}>
                Open Login Panel
              </button>
            </div>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
                {[
                  { label: "BALANCE", val: "$" + (brokerAccount?.balance?.toFixed(2) || "—"), color: C.green },
                  { label: "EQUITY", val: "$" + (brokerAccount?.equity?.toFixed(2) || "—"), color: C.blue },
                  { label: "MARGIN", val: "$" + (brokerAccount?.margin?.toFixed(2) || "0.00"), color: C.amber },
                  { label: "FREE MARGIN", val: "$" + (brokerAccount?.freeMargin?.toFixed(2) || "—"), color: C.purple },
                ].map(({ label, val, color }) => (
                  <div key={label} style={panel({ padding: "12px 14px" })}>
                    <div style={{ fontSize: 10, color: C.dim, letterSpacing: ".1em", marginBottom: 5 }}>{label}</div>
                    <div style={{ ...mono, fontSize: 24, fontWeight: 700, color }}>{val}</div>
                  </div>
                ))}
              </div>

              <div style={panel()}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
                  <span style={{ fontSize: 10, color: C.dim }}>MT5 OPEN POSITIONS (from broker)</span>
                  <button onClick={() => wsRef.current?.send(JSON.stringify({ type: "GET_TRADES" }))}
                    style={{ display: "flex", alignItems: "center", gap: 5, padding: "3px 10px", background: "transparent", border: "1px solid " + C.border, borderRadius: 4, color: C.dim, cursor: "pointer", fontSize: 11 }}>
                    <RefreshCw size={11} /> Refresh
                  </button>
                </div>
                {mt5Trades.length === 0 ? (
                  <div style={{ color: C.dim, padding: "20px", textAlign: "center", fontSize: 13 }}>
                    No open positions on MT5 account
                  </div>
                ) : (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead><tr style={{ borderBottom: "1px solid " + C.border }}>
                      {["TICKET","SYMBOL","TYPE","VOLUME","ENTRY","SL","TP","PROFIT"].map(h => (
                        <th key={h} style={{ padding: "4px 8px", color: C.dim, fontSize: 10, textAlign: "left" }}>{h}</th>
                      ))}
                    </tr></thead>
                    <tbody>
                      {mt5Trades.map(t => (
                        <tr key={t.ticket} style={{ borderBottom: "1px solid " + C.border + "22" }}>
                          <td style={{ padding: "7px 8px", ...mono, color: C.dim }}>#{t.ticket}</td>
                          <td style={{ padding: "7px 8px", color: C.gold }}>{t.symbol}</td>
                          <td style={{ padding: "7px 8px" }}><span style={badge(t.type === "buy" ? C.green : C.red)}>{t.type?.toUpperCase()}</span></td>
                          <td style={{ padding: "7px 8px", ...mono }}>{t.volume}</td>
                          <td style={{ padding: "7px 8px", ...mono }}>{t.entry?.toFixed(2)}</td>
                          <td style={{ padding: "7px 8px", ...mono, color: C.red }}>{t.sl?.toFixed(2)}</td>
                          <td style={{ padding: "7px 8px", ...mono, color: C.green }}>{t.tp?.toFixed(2)}</td>
                          <td style={{ padding: "7px 8px", ...mono, color: t.profit >= 0 ? C.green : C.red, fontWeight: 700 }}>{t.profit >= 0 ? "+" : ""}${t.profit?.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* ══ LOG ══ */}
      {tab === "log" && (
        <div style={{ ...panel(), maxHeight: 540, overflowY: "auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
            <span style={{ fontSize: 10, color: C.dim }}>SYSTEM EVENT LOG ({logs.length})</span>
            <button onClick={() => setLogs([{ id: Date.now(), time: new Date().toLocaleTimeString(), msg: "Log cleared.", type: "info" }])}
              style={{ fontSize: 10, color: C.dim, background: "none", border: "1px solid " + C.border, borderRadius: 3, padding: "2px 8px", cursor: "pointer" }}>CLEAR</button>
          </div>
          {logs.map(l => (
            <div key={l.id} className="fadein" style={{ display: "flex", gap: 10, padding: "5px 0", borderBottom: "1px solid " + C.border + "18" }}>
              <span style={{ ...mono, color: C.dimmer, fontSize: 10, whiteSpace: "nowrap" }}>{l.time}</span>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: l.type === "win" ? C.green : l.type === "loss" ? C.red : l.type === "signal" ? C.gold : C.dim, marginTop: 4, flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: l.type === "win" ? C.green : l.type === "loss" ? C.red : l.type === "signal" ? C.gold : C.text, lineHeight: 1.4 }}>{l.msg}</span>
            </div>
          ))}
        </div>
      )}

      {/* ══ SETTINGS ══ */}
      {tab === "settings" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div style={panel()}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 16 }}>
              <Shield size={14} color={C.gold} />
              <span style={{ fontSize: 11, color: C.gold, letterSpacing: ".1em", fontWeight: 700 }}>RISK MANAGEMENT</span>
            </div>
            {[
              { key: "risk", label: "Risk per trade", min: 0.5, max: 5, step: 0.5, unit: "%", color: C.gold },
              { key: "maxDD", label: "Max drawdown circuit breaker", min: 5, max: 30, step: 1, unit: "%", color: C.red },
            ].map(({ key, label, min, max, step, unit, color }) => (
              <div key={key} style={{ marginBottom: 18 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 13 }}>{label}</span>
                  <span style={{ ...mono, color, fontSize: 14 }}>{settings[key]}{unit}</span>
                </div>
                <input type="range" min={min} max={max} step={step} value={settings[key]}
                  onChange={e => setSettings(s => ({ ...s, [key]: +e.target.value }))}
                  style={{ width: "100%", accentColor: color }} />
              </div>
            ))}
          </div>
          <div style={panel()}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 14 }}>
              <Zap size={14} color={C.gold} />
              <span style={{ fontSize: 11, color: C.gold, letterSpacing: ".1em", fontWeight: 700 }}>STRATEGY CONFIG</span>
            </div>
            {[
              { key: "trend", label: "Trend Following", sub: "EMA(20/50) + RSI(14) > 50", color: C.gold },
              { key: "meanRev", label: "Mean Reversion", sub: "BB(20,2σ) + RSI extremes 68/32", color: C.blue },
            ].map(({ key, label, sub, color }) => (
              <div key={key} onClick={() => setSettings(s => ({ ...s, [key]: !s[key] }))}
                style={{ padding: 14, marginBottom: 8, background: settings[key] ? color + "0d" : C.panel2, border: "1.5px solid " + (settings[key] ? color + "55" : C.border), borderRadius: 8, cursor: "pointer", transition: "all 0.2s" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: settings[key] ? color : C.dim }}>{label}</div>
                    <div style={{ fontSize: 11, color: C.dim, marginTop: 2 }}>{sub}</div>
                  </div>
                  <div style={{ width: 38, height: 20, borderRadius: 10, background: settings[key] ? color : C.border, position: "relative", transition: "all 0.2s", flexShrink: 0 }}>
                    <div style={{ position: "absolute", top: 2, left: settings[key] ? 19 : 2, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: "all 0.2s" }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* FOOTER */}
      <div style={{ marginTop: 12, paddingTop: 8, borderTop: "1px solid " + C.border, display: "flex", justifyContent: "space-between", fontSize: 10, color: C.dimmer }}>
        <span>XAUUSDm · EXNESS MT5 · v3.0 · Educational use · Not financial advice</span>
        <span style={mono}>{running ? <span style={{ color: C.green }}>● LIVE</span> : "○ IDLE"} · ${price.toFixed(2)} · {srcLabel} · {regime}</span>
      </div>
    </div>
  );
}