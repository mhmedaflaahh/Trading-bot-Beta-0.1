import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  AreaChart, Area, LineChart, Line,
  XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine
} from "recharts";
import { Play, Square, TrendingUp, TrendingDown, Zap, Shield, BarChart2, FileText, Settings } from "lucide-react";

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
  const rs = (g / p) / (l / p);
  return 100 - 100 / (1 + rs);
};

const calcBB = (closes, p = 20, m = 2) => {
  const sl = closes.slice(-p);
  if (sl.length < p) { const c = closes.slice(-1)[0]; return { u: c + 15, mid: c, l: c - 15 }; }
  const mean = sl.reduce((a, b) => a + b, 0) / p;
  const std = Math.sqrt(sl.reduce((a, b) => a + (b - mean) ** 2, 0) / p);
  return { u: mean + m * std, mid: mean, l: mean - m * std };
};

const calcATR = (candles, p = 14) => {
  const sl = candles.slice(-p);
  if (sl.length < 2) return 5;
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
  const diP = 100 * pDM / tR, diM = 100 * mDM / tR;
  const s = diP + diM;
  return s === 0 ? 20 : 100 * Math.abs(diP - diM) / s;
};

// ═══════════════════════════════════════
//  CANDLE GENERATOR
// ═══════════════════════════════════════
const genCandles = (n = 120, base = 2652) => {
  let p = base, trend = 0;
  return Array.from({ length: n }, (_, i) => {
    trend = trend * 0.92 + (Math.random() - 0.5) * 0.2;
    const ch = trend * 5 + (Math.random() - 0.5) * 7;
    const o = p, c = Math.max(2400, p + ch);
    const hl = Math.random() * 3 + Math.abs(ch) * 0.3;
    p = c;
    return { o, h: Math.max(o, c) + hl, l: Math.min(o, c) - hl, c, t: i };
  });
};

// ═══════════════════════════════════════
//  COLORS
// ═══════════════════════════════════════
const C = {
  bg: '#06080f',
  panel: '#0d1220',
  panel2: '#111827',
  border: '#1a2840',
  gold: '#D4AF37',
  goldBright: '#F4C430',
  green: '#00C896',
  red: '#FF4050',
  blue: '#60A5FA',
  purple: '#A78BFA',
  amber: '#F59E0B',
  text: '#c8d8f0',
  dim: '#4a5a7a',
  dimmer: '#2a3a52',
};

// ═══════════════════════════════════════
//  MAIN COMPONENT
// ═══════════════════════════════════════
export default function XAUUSDBot() {
  const initCandles = useMemo(() => genCandles(), []);
  const [candles, setCandles] = useState(initCandles);
  const [price, setPrice] = useState(initCandles[initCandles.length - 1].c);
  const [priceDir, setPriceDir] = useState(0);
  const [equity, setEquity] = useState(100);
  const [peakEq, setPeakEq] = useState(100);
  const [eqHistory, setEqHistory] = useState([{ t: 0, v: 100 }]);
  const [openTrades, setOpenTrades] = useState([]);
  const [closedTrades, setClosedTrades] = useState([]);
  const [ind, setInd] = useState({});
  const [regime, setRegime] = useState('SCANNING');
  const [lastSignal, setLastSignal] = useState(null);
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState('overview');
  const [logs, setLogs] = useState([
    { id: 1, time: new Date().toLocaleTimeString(), msg: '🟡 System initialized. Press START BOT to begin live simulation.', type: 'info' }
  ]);
  const [stats, setStats] = useState({ wins: 0, losses: 0, totalPnL: 0 });
  const [tick, setTick] = useState(0);
  const [settings, setSettings] = useState({ risk: 2, maxDD: 15, trend: true, meanRev: true });

  const ref = useRef({});
  const tradeId = useRef(0);

  useEffect(() => {
    ref.current = { candles, equity, peakEq, openTrades, closedTrades, stats, tick, eqHistory, settings };
  });

  const addLog = useCallback((msg, type = 'info') => {
    setLogs(p => [{ id: Date.now() + Math.random(), time: new Date().toLocaleTimeString(), msg, type }, ...p].slice(0, 300));
  }, []);

  // ─── COMPUTE INDICATORS ───
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

  // ─── STRATEGY ENGINE ───
  const strategize = useCallback((cands, indicators, eq, openT, setts) => {
    const { ema20, ema50, prevEma20, prevEma50, rsi, bb, atr, adx } = indicators;
    const px = cands[cands.length - 1].c;
    const riskAmt = eq * (setts.risk / 100);
    const stopDist = atr * 1.5;
    const regime = adx > 25 ? 'TRENDING' : adx < 18 ? 'RANGING' : 'NEUTRAL';

    if (openT.length >= 2) return { regime, signal: null };

    const hasLong = openT.some(t => t.dir === 'long');
    const hasShort = openT.some(t => t.dir === 'short');
    let signal = null, strat = '', sl = 0, tp = 0;

    // TREND: EMA Cross + RSI
    if (setts.trend && regime !== 'RANGING') {
      const bullCross = prevEma20 <= prevEma50 && ema20 > ema50;
      const bearCross = prevEma20 >= prevEma50 && ema20 < ema50;
      if (bullCross && rsi > 50 && !hasLong) {
        signal = 'BUY'; strat = 'EMA Cross ↗';
        sl = px - stopDist; tp = px + stopDist * 2;
      } else if (bearCross && rsi < 50 && !hasShort) {
        signal = 'SELL'; strat = 'EMA Cross ↘';
        sl = px + stopDist; tp = px - stopDist * 2;
      }
    }

    // MEAN REVERSION: BB + RSI
    if (!signal && setts.meanRev && regime !== 'TRENDING') {
      const lastC = cands[cands.length - 1];
      const bullC = lastC.c > lastC.o;
      const bearC = lastC.c < lastC.o;
      if (px >= bb.u && rsi > 68 && bearC && !hasShort) {
        signal = 'SELL'; strat = 'BB Reversion ↘';
        sl = px + atr; tp = bb.mid;
      } else if (px <= bb.l && rsi < 32 && bullC && !hasLong) {
        signal = 'BUY'; strat = 'BB Reversion ↗';
        sl = px - atr; tp = bb.mid;
      }
    }

    return { regime, signal, strat, sl, tp, riskAmt };
  }, []);

  // ─── MAIN TICK ENGINE ───
  useEffect(() => {
    if (!running) return;
    const iv = setInterval(() => {
      const st = ref.current;
      const last = st.candles[st.candles.length - 1];
      const lastC = last.c;

      // New price tick
      const vol = 0.0013;
      const drift = Math.sin(Date.now() / 22000) * 0.0003;
      const newP = Math.max(2420, lastC + lastC * (drift + (Math.random() - 0.5) * vol * 2));
      const dir = newP > lastC ? 1 : -1;
      setPrice(newP);
      setPriceDir(dir);

      const newTick = st.tick + 1;
      setTick(newTick);

      // Update or create candle
      let newCandles;
      if (newTick % 12 === 0) {
        const fin = { ...last, c: newP, h: Math.max(last.h, newP), l: Math.min(last.l, newP), t: newTick };
        const nc = { o: newP, h: newP, l: newP, c: newP, t: newTick + 0.1 };
        newCandles = [...st.candles.slice(-119), fin, nc];
      } else {
        const upd = { ...last, c: newP, h: Math.max(last.h, newP), l: Math.min(last.l, newP) };
        newCandles = [...st.candles.slice(0, -1), upd];
      }
      setCandles(newCandles);

      const newInd = computeInd(newCandles);
      setInd(newInd);

      // Close trades on SL/TP
      let eq = st.equity;
      let newStats = { ...st.stats };
      let newOpen = [];
      let newClosed = [...st.closedTrades];

      for (const trade of st.openTrades) {
        const slHit = trade.dir === 'long' ? newP <= trade.sl : newP >= trade.sl;
        const tpHit = trade.dir === 'long' ? newP >= trade.tp : newP <= trade.tp;
        if (slHit || tpHit) {
          const pnl = slHit ? -trade.risk : trade.risk * 2;
          eq += pnl;
          newStats.totalPnL += pnl;
          pnl > 0 ? newStats.wins++ : newStats.losses++;
          newClosed = [{ ...trade, exit: newP, pnl, reason: slHit ? 'SL' : 'TP', at: newTick }, ...newClosed].slice(0, 60);
          addLog(
            `${slHit ? '🛑 STOP LOSS' : '✅ TAKE PROFIT'} | ${trade.strat} ${trade.dir.toUpperCase()} @ $${newP.toFixed(2)} | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`,
            pnl >= 0 ? 'win' : 'loss'
          );
        } else {
          newOpen.push(trade);
        }
      }

      const newPeak = Math.max(st.peakEq, eq);

      // Strategy signals every 5 ticks
      if (newTick % 5 === 0) {
        const res = strategize(newCandles, newInd, eq, newOpen, st.settings);
        setRegime(res.regime);
        setLastSignal(res.signal);
        if (res.signal && res.strat) {
          const id = ++tradeId.current;
          newOpen.push({ id, dir: res.signal === 'BUY' ? 'long' : 'short', entry: newP, sl: res.sl, tp: res.tp, risk: res.riskAmt, strat: res.strat, at: newTick });
          addLog(
            `📡 ${res.signal} SIGNAL | ${res.strat} @ $${newP.toFixed(2)} | SL $${res.sl.toFixed(2)} | TP $${res.tp.toFixed(2)} | Risk $${res.riskAmt.toFixed(2)}`,
            'signal'
          );
        }
      }

      setEquity(eq);
      setPeakEq(newPeak);
      setOpenTrades(newOpen);
      setClosedTrades(newClosed);
      setStats(newStats);
      if (newTick % 4 === 0) {
        setEqHistory(p => [...p, { t: newTick, v: parseFloat(eq.toFixed(2)) }].slice(-100));
      }
    }, 1300);
    return () => clearInterval(iv);
  }, [running, computeInd, strategize, addLog]);

  // Initial indicators
  useEffect(() => {
    setInd(computeInd(initCandles));
  }, [computeInd, initCandles]);

  // ─── DERIVED VALUES ───
  const drawdown = peakEq > 0 ? Math.max(0, (peakEq - equity) / peakEq * 100) : 0;
  const totalReturn = equity - 100;
  const totalReturnPct = totalReturn;
  const winRate = (stats.wins + stats.losses) > 0 ? stats.wins / (stats.wins + stats.losses) * 100 : 0;
  const openPnL = openTrades.reduce((sum, t) => {
    const diff = t.dir === 'long' ? price - t.entry : t.entry - price;
    const sd = Math.abs(t.entry - t.sl);
    return sum + (sd > 0 ? (diff / sd) * t.risk : 0);
  }, 0);

  // ─── CHART DATA (memoized) ───
  const priceChartData = useMemo(() => {
    const sl = candles.slice(-60);
    const closes = sl.map(c => c.c);
    const e20 = emaArr(closes, 20);
    const e50 = emaArr(closes, Math.min(50, closes.length - 1));
    return sl.map((c, i) => ({ i, price: +c.c.toFixed(2), ema20: +e20[i].toFixed(2), ema50: +e50[i].toFixed(2) }));
  }, [candles]);

  const rsiChartData = useMemo(() => {
    const sl = candles.slice(-60);
    return sl.map((_, i, arr) => ({
      i,
      rsi: +calcRSI(arr.slice(0, i + 1).map(x => x.c)).toFixed(1)
    }));
  }, [candles]);

  const adxChartData = useMemo(() => {
    const sl = candles.slice(-60);
    return sl.map((_, i, arr) => ({
      i,
      adx: +calcADX(arr.slice(0, i + 1)).toFixed(1)
    }));
  }, [candles]);

  // ─── STYLES ───
  const panel = (extra = {}) => ({
    background: C.panel, border: `1px solid ${C.border}`,
    borderRadius: 8, padding: '14px 16px', ...extra,
  });

  const tabBtn = (active) => ({
    padding: '7px 14px', borderRadius: 4,
    background: active ? C.gold : 'transparent',
    color: active ? '#000' : C.dim,
    border: 'none', cursor: 'pointer',
    fontFamily: 'Rajdhani, sans-serif', fontWeight: 700,
    fontSize: 12, letterSpacing: '0.06em', transition: 'all 0.18s',
  });

  const mono = { fontFamily: "'Share Tech Mono', monospace" };

  const badge = (color) => ({
    fontSize: 10, padding: '1px 7px', borderRadius: 3,
    background: `${color}22`, color, fontWeight: 700, ...mono,
    border: `1px solid ${color}44`,
  });

  const regimeColor = regime === 'TRENDING' ? C.gold : regime === 'RANGING' ? C.blue : C.dim;

  return (
    <div style={{ fontFamily: 'Rajdhani, sans-serif', background: C.bg, color: C.text, minHeight: '100vh', padding: '12px 14px' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Share+Tech+Mono&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 3px; height: 3px; }
        ::-webkit-scrollbar-track { background: ${C.panel}; }
        ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 2px; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.35} }
        @keyframes glow { 0%,100%{box-shadow:0 0 10px rgba(212,175,55,.25)} 50%{box-shadow:0 0 22px rgba(212,175,55,.55)} }
        @keyframes slidein { from{opacity:0;transform:translateY(-3px)} to{opacity:1;transform:translateY(0)} }
        @keyframes pricetick { 0%{opacity:.6} 100%{opacity:1} }
        .pulse { animation: pulse 2s infinite; }
        .glow { animation: glow 2.5s infinite; }
        .slidein { animation: slidein 0.25s ease; }
        .tick { animation: pricetick 0.4s ease; }
        input[type=range] { cursor: pointer; }
        input[type=range]::-webkit-slider-thumb { background: ${C.gold}; }
      `}</style>

      {/* ── HEADER ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: `1px solid ${C.border}`, paddingBottom: 10, marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div className={running ? 'pulse' : ''} style={{ width: 9, height: 9, borderRadius: '50%', background: running ? C.green : C.dim }} />
            <span style={{ ...mono, color: C.gold, fontSize: 22, letterSpacing: '.1em', fontWeight: 700 }}>XAU/USD</span>
          </div>
          <div style={{ padding: '2px 8px', background: `${C.gold}18`, border: `1px solid ${C.gold}33`, borderRadius: 4 }}>
            <span style={{ ...mono, fontSize: 10, color: C.gold, letterSpacing: '.08em' }}>AUTO TRADER v2.0 · MT5</span>
          </div>
        </div>

        {/* PRICE */}
        <div className="tick" key={Math.round(price * 10)} style={{ textAlign: 'center' }}>
          <div style={{ ...mono, fontSize: 30, fontWeight: 700, lineHeight: 1, color: priceDir > 0 ? C.green : priceDir < 0 ? C.red : C.text }}>
            {price.toFixed(2)}
            <span style={{ fontSize: 14, marginLeft: 4 }}>{priceDir > 0 ? '▲' : priceDir < 0 ? '▼' : ''}</span>
          </div>
          <div style={{ fontSize: 10, color: C.dim, letterSpacing: '.05em' }}>USD/OZ · EXNESS · TICK #{tick}</div>
        </div>

        {/* START/STOP */}
        <button
          onClick={() => { setRunning(r => !r); addLog(running ? '⏸ Bot stopped by user.' : '▶ Bot started. Scanning for signals...', 'info'); }}
          className={running ? 'glow' : ''}
          style={{
            display: 'flex', alignItems: 'center', gap: 7,
            padding: '9px 22px', borderRadius: 6,
            background: running ? `${C.red}18` : `${C.gold}18`,
            border: `1.5px solid ${running ? C.red : C.gold}`,
            color: running ? C.red : C.gold,
            cursor: 'pointer', fontSize: 14, fontWeight: 700,
            fontFamily: 'Rajdhani, sans-serif', letterSpacing: '.06em', transition: 'all 0.2s',
          }}
        >
          {running ? <><Square size={14} /> STOP BOT</> : <><Play size={14} /> START BOT</>}
        </button>
      </div>

      {/* ── STATS ROW ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 12 }}>
        {[
          {
            icon: <BarChart2 size={14} color={C.gold} />, label: 'EQUITY',
            value: `$${equity.toFixed(2)}`,
            sub: `${totalReturnPct >= 0 ? '+' : ''}${totalReturnPct.toFixed(2)}% total return`,
            subColor: totalReturn >= 0 ? C.green : C.red,
          },
          {
            icon: <Zap size={14} color={C.amber} />, label: 'OPEN P&L',
            value: `${openPnL >= 0 ? '+' : ''}$${openPnL.toFixed(2)}`,
            sub: `${openTrades.length} active position${openTrades.length !== 1 ? 's' : ''}`,
            subColor: openPnL >= 0 ? C.green : C.red,
          },
          {
            icon: <Shield size={14} color={drawdown > 10 ? C.red : C.green} />, label: 'DRAWDOWN',
            value: `${drawdown.toFixed(2)}%`,
            sub: `Peak $${peakEq.toFixed(2)} · Limit ${settings.maxDD}%`,
            subColor: drawdown > settings.maxDD * 0.8 ? C.red : drawdown > settings.maxDD * 0.5 ? C.amber : C.green,
          },
          {
            icon: <TrendingUp size={14} color={winRate > 50 ? C.green : C.red} />, label: 'WIN RATE',
            value: `${winRate.toFixed(1)}%`,
            sub: `${stats.wins}W / ${stats.losses}L · P&L $${stats.totalPnL.toFixed(2)}`,
            subColor: winRate > 55 ? C.green : winRate > 40 ? C.amber : C.red,
          },
        ].map(({ icon, label, value, sub, subColor }) => (
          <div key={label} style={panel({ padding: '10px 13px' })}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 5 }}>
              {icon}
              <span style={{ fontSize: 10, color: C.dim, letterSpacing: '.1em' }}>{label}</span>
            </div>
            <div style={{ ...mono, fontSize: 22, fontWeight: 700, color: C.text, lineHeight: 1 }}>{value}</div>
            <div style={{ fontSize: 11, color: subColor, marginTop: 3 }}>{sub}</div>
          </div>
        ))}
      </div>

      {/* ── TABS ── */}
      <div style={{ display: 'flex', gap: 3, marginBottom: 12, borderBottom: `1px solid ${C.border}`, paddingBottom: 8 }}>
        {[
          { key: 'overview', icon: <Zap size={12} />, label: 'OVERVIEW' },
          { key: 'chart', icon: <BarChart2 size={12} />, label: 'CHART' },
          { key: 'trades', icon: <TrendingUp size={12} />, label: 'TRADES' },
          { key: 'log', icon: <FileText size={12} />, label: 'LOG' },
          { key: 'settings', icon: <Settings size={12} />, label: 'SETTINGS' },
        ].map(({ key, icon, label }) => (
          <button key={key} style={tabBtn(tab === key)} onClick={() => setTab(key)}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>{icon}{label}</span>
          </button>
        ))}
      </div>

      {/* ═══════════════════════════════ OVERVIEW TAB ═══════════════════════════════ */}
      {tab === 'overview' && (
        <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 10 }}>

          {/* LEFT COLUMN */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>

            {/* Regime */}
            <div style={panel()}>
              <div style={{ fontSize: 10, color: C.dim, letterSpacing: '.1em', marginBottom: 8 }}>MARKET REGIME</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div className="pulse" style={{ width: 8, height: 8, borderRadius: '50%', background: regimeColor }} />
                <span style={{ ...mono, fontSize: 20, color: regimeColor, fontWeight: 700 }}>{regime}</span>
              </div>
              <div style={{ marginTop: 7, fontSize: 11, color: C.dim, lineHeight: 1.5 }}>
                {regime === 'TRENDING' ? <>ADX &gt;25 → EMA Cross strategy<br />Trend-following mode active</> :
                  regime === 'RANGING' ? <>ADX &lt;18 → BB/RSI strategy<br />Mean reversion mode active</> :
                    <>ADX 18–25 → Both strategies<br />Dual mode scanning...</>}
              </div>
            </div>

            {/* Signal */}
            <div style={{ ...panel(), border: `1px solid ${lastSignal ? (lastSignal === 'BUY' ? C.green + '66' : C.red + '66') : C.border}` }}>
              <div style={{ fontSize: 10, color: C.dim, letterSpacing: '.1em', marginBottom: 8 }}>LAST SIGNAL</div>
              {lastSignal ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 38, height: 38, borderRadius: 8, background: lastSignal === 'BUY' ? `${C.green}20` : `${C.red}20`, border: `2px solid ${lastSignal === 'BUY' ? C.green : C.red}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {lastSignal === 'BUY' ? <TrendingUp size={18} color={C.green} /> : <TrendingDown size={18} color={C.red} />}
                  </div>
                  <div>
                    <div style={{ ...mono, fontSize: 20, fontWeight: 700, color: lastSignal === 'BUY' ? C.green : C.red }}>{lastSignal}</div>
                    <div style={{ fontSize: 11, color: C.dim }}>XAUUSD · {running ? 'Live' : 'Paused'}</div>
                  </div>
                </div>
              ) : (
                <div style={{ color: C.dim, fontSize: 13 }}>{running ? 'Scanning market...' : 'Start bot to scan'}</div>
              )}
            </div>

            {/* Indicators */}
            <div style={panel()}>
              <div style={{ fontSize: 10, color: C.dim, letterSpacing: '.1em', marginBottom: 10 }}>LIVE INDICATORS</div>
              {[
                { label: 'EMA 20', val: ind.ema20?.toFixed(2), color: C.blue },
                { label: 'EMA 50', val: ind.ema50?.toFixed(2), color: C.purple },
                { label: 'RSI (14)', val: ind.rsi?.toFixed(1), color: ind.rsi > 70 ? C.red : ind.rsi < 30 ? C.green : C.amber },
                { label: 'BB Upper', val: ind.bb?.u?.toFixed(2), color: C.red },
                { label: 'BB Mid', val: ind.bb?.mid?.toFixed(2), color: C.dim },
                { label: 'BB Lower', val: ind.bb?.l?.toFixed(2), color: C.green },
                { label: 'ATR (14)', val: ind.atr?.toFixed(2), color: C.amber },
                { label: 'ADX (14)', val: ind.adx?.toFixed(1), color: ind.adx > 25 ? C.gold : C.dim },
              ].map(({ label, val, color }) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: `1px solid ${C.border}33` }}>
                  <span style={{ fontSize: 12, color: C.dim }}>{label}</span>
                  <span style={{ ...mono, fontSize: 12, color, fontWeight: 600 }}>{val ?? '—'}</span>
                </div>
              ))}
            </div>
          </div>

          {/* RIGHT COLUMN */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>

            {/* Equity Chart */}
            <div style={panel()}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 10, color: C.dim, letterSpacing: '.1em' }}>EQUITY CURVE · $100 BASE</span>
                <span style={{ ...mono, fontSize: 12, color: totalReturn >= 0 ? C.green : C.red }}>
                  {totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)} ({totalReturnPct.toFixed(2)}%)
                </span>
              </div>
              <ResponsiveContainer width="100%" height={165}>
                <AreaChart data={eqHistory}>
                  <defs>
                    <linearGradient id="eg1" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={C.gold} stopOpacity={0.35} />
                      <stop offset="95%" stopColor={C.gold} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="t" hide />
                  <YAxis domain={['auto', 'auto']} tick={{ fontSize: 10, fill: C.dim }} width={46} tickFormatter={v => `$${v.toFixed(0)}`} />
                  <Tooltip contentStyle={{ background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 11, fontFamily: 'Share Tech Mono' }} formatter={v => [`$${v.toFixed(2)}`, 'Equity']} labelFormatter={() => ''} />
                  <ReferenceLine y={100} stroke={C.dimmer} strokeDasharray="4 4" strokeWidth={1} />
                  <Area type="monotone" dataKey="v" stroke={C.gold} strokeWidth={2} fill="url(#eg1)" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            {/* Open Trades */}
            <div style={panel()}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
                <span style={{ fontSize: 10, color: C.dim, letterSpacing: '.1em' }}>OPEN POSITIONS</span>
                <span style={{ ...badge(openTrades.length > 0 ? C.amber : C.dim) }}>{openTrades.length} / 2 MAX</span>
              </div>
              {openTrades.length === 0 ? (
                <div style={{ color: C.dim, fontSize: 13, textAlign: 'center', padding: '18px 0' }}>
                  {running ? '🔍 No open positions — bot is scanning...' : '⏸ Start bot to begin trading'}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {openTrades.map(t => {
                    const diff = t.dir === 'long' ? price - t.entry : t.entry - price;
                    const sd = Math.abs(t.entry - t.sl);
                    const unreal = sd > 0 ? (diff / sd) * t.risk : 0;
                    const pct = (Math.abs(diff) / sd * 100).toFixed(0);
                    return (
                      <div key={t.id} style={{ background: C.panel2, border: `1px solid ${t.dir === 'long' ? C.green + '44' : C.red + '44'}`, borderRadius: 7, padding: '9px 12px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            <span style={badge(t.dir === 'long' ? C.green : C.red)}>{t.dir.toUpperCase()}</span>
                            <span style={{ fontSize: 12, color: C.text }}>{t.strat}</span>
                          </div>
                          <span style={{ ...mono, fontSize: 14, fontWeight: 700, color: unreal >= 0 ? C.green : C.red }}>
                            {unreal >= 0 ? '+' : ''}${unreal.toFixed(2)}
                          </span>
                        </div>
                        <div style={{ display: 'flex', gap: 14 }}>
                          <span style={{ fontSize: 10, color: C.dim }}>Entry <span style={{ color: C.text, ...mono }}>{t.entry.toFixed(2)}</span></span>
                          <span style={{ fontSize: 10, color: C.red }}>SL <span style={{ ...mono }}>{t.sl.toFixed(2)}</span></span>
                          <span style={{ fontSize: 10, color: C.green }}>TP <span style={{ ...mono }}>{t.tp.toFixed(2)}</span></span>
                          <span style={{ fontSize: 10, color: C.dim }}>Risk <span style={{ color: C.amber, ...mono }}>${t.risk.toFixed(2)}</span></span>
                        </div>
                        {/* Progress bar */}
                        <div style={{ marginTop: 6, height: 3, background: C.border, borderRadius: 2, overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${Math.min(100, pct)}%`, background: unreal >= 0 ? C.green : C.red, borderRadius: 2, transition: 'width 0.4s ease' }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════ CHART TAB ═══════════════════════════════ */}
      {tab === 'chart' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

          {/* Price + EMA chart */}
          <div style={panel()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 10, color: C.dim, letterSpacing: '.1em' }}>XAUUSD PRICE · LIVE SIMULATION (60 CANDLES)</span>
              <div style={{ display: 'flex', gap: 12, fontSize: 11 }}>
                <span style={{ color: C.gold }}>── Price</span>
                <span style={{ color: C.blue }}>── EMA 20</span>
                <span style={{ color: C.purple }}>── EMA 50</span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={priceChartData}>
                <defs>
                  <linearGradient id="pg" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={C.gold} stopOpacity={0.15} />
                    <stop offset="95%" stopColor={C.gold} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="i" hide />
                <YAxis domain={['auto', 'auto']} tick={{ fontSize: 10, fill: C.dim }} width={55} tickFormatter={v => v.toFixed(0)} />
                <Tooltip contentStyle={{ background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 11, fontFamily: 'Share Tech Mono' }} formatter={(v, n) => [`$${v}`, n === 'price' ? 'Price' : n === 'ema20' ? 'EMA 20' : 'EMA 50']} labelFormatter={() => ''} />
                <Line type="monotone" dataKey="price" stroke={C.gold} strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="ema20" stroke={C.blue} strokeWidth={1.5} dot={false} strokeDasharray="0" />
                <Line type="monotone" dataKey="ema50" stroke={C.purple} strokeWidth={1.5} dot={false} strokeDasharray="5 3" />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>

            {/* RSI */}
            <div style={panel()}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 10, color: C.dim, letterSpacing: '.1em' }}>RSI (14)</span>
                <span style={{ ...mono, fontSize: 12, color: ind.rsi > 70 ? C.red : ind.rsi < 30 ? C.green : C.amber }}>
                  {ind.rsi?.toFixed(1) ?? '—'}
                  {ind.rsi > 70 ? ' OVERBOUGHT' : ind.rsi < 30 ? ' OVERSOLD' : ''}
                </span>
              </div>
              <ResponsiveContainer width="100%" height={110}>
                <LineChart data={rsiChartData}>
                  <XAxis dataKey="i" hide />
                  <YAxis domain={[0, 100]} hide />
                  <Tooltip contentStyle={{ background: C.panel2, border: `1px solid ${C.border}`, fontSize: 11, fontFamily: 'Share Tech Mono' }} formatter={v => [v.toFixed(1), 'RSI']} labelFormatter={() => ''} />
                  <ReferenceLine y={70} stroke={C.red} strokeDasharray="4 3" strokeWidth={1} label={{ value: '70', fill: C.red, fontSize: 9 }} />
                  <ReferenceLine y={30} stroke={C.green} strokeDasharray="4 3" strokeWidth={1} label={{ value: '30', fill: C.green, fontSize: 9 }} />
                  <ReferenceLine y={50} stroke={C.dimmer} strokeDasharray="2 3" strokeWidth={1} />
                  <Line type="monotone" dataKey="rsi" stroke={C.amber} strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* ADX */}
            <div style={panel()}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 10, color: C.dim, letterSpacing: '.1em' }}>ADX (14) — TREND STRENGTH</span>
                <span style={{ ...mono, fontSize: 12, color: ind.adx > 25 ? C.gold : C.dim }}>
                  {ind.adx?.toFixed(1) ?? '—'}
                  {ind.adx > 25 ? ' STRONG' : ind.adx < 18 ? ' WEAK' : ' MED'}
                </span>
              </div>
              <ResponsiveContainer width="100%" height={110}>
                <AreaChart data={adxChartData}>
                  <defs>
                    <linearGradient id="adxg" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={C.purple} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={C.purple} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="i" hide />
                  <YAxis domain={[0, 60]} hide />
                  <Tooltip contentStyle={{ background: C.panel2, border: `1px solid ${C.border}`, fontSize: 11, fontFamily: 'Share Tech Mono' }} formatter={v => [v.toFixed(1), 'ADX']} labelFormatter={() => ''} />
                  <ReferenceLine y={25} stroke={C.gold} strokeDasharray="4 3" strokeWidth={1} label={{ value: '25', fill: C.gold, fontSize: 9 }} />
                  <ReferenceLine y={18} stroke={C.blue} strokeDasharray="4 3" strokeWidth={1} label={{ value: '18', fill: C.blue, fontSize: 9 }} />
                  <Area type="monotone" dataKey="adx" stroke={C.purple} strokeWidth={2} fill="url(#adxg)" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Full equity curve */}
          <div style={panel()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 10, color: C.dim, letterSpacing: '.1em' }}>EQUITY CURVE</span>
              <div style={{ display: 'flex', gap: 14, fontSize: 11, ...mono }}>
                <span style={{ color: C.dim }}>Start: <span style={{ color: C.text }}>$100.00</span></span>
                <span style={{ color: C.dim }}>Peak: <span style={{ color: C.gold }}>${peakEq.toFixed(2)}</span></span>
                <span style={{ color: C.dim }}>DD: <span style={{ color: drawdown > 10 ? C.red : C.green }}>{drawdown.toFixed(2)}%</span></span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={130}>
              <AreaChart data={eqHistory}>
                <defs>
                  <linearGradient id="eg2" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={totalReturn >= 0 ? C.green : C.red} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={totalReturn >= 0 ? C.green : C.red} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="t" hide />
                <YAxis domain={['auto', 'auto']} tick={{ fontSize: 10, fill: C.dim }} width={48} tickFormatter={v => `$${v.toFixed(0)}`} />
                <Tooltip contentStyle={{ background: C.panel2, border: `1px solid ${C.border}`, fontSize: 11, fontFamily: 'Share Tech Mono' }} formatter={v => [`$${v.toFixed(2)}`, 'Equity']} labelFormatter={() => ''} />
                <ReferenceLine y={100} stroke={C.dimmer} strokeDasharray="4 4" />
                <Area type="monotone" dataKey="v" stroke={totalReturn >= 0 ? C.green : C.red} strokeWidth={2} fill="url(#eg2)" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════ TRADES TAB ═══════════════════════════════ */}
      {tab === 'trades' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

          {/* Open Positions */}
          <div style={panel()}>
            <div style={{ fontSize: 10, color: C.dim, letterSpacing: '.1em', marginBottom: 10 }}>OPEN POSITIONS ({openTrades.length})</div>
            {openTrades.length === 0 ? (
              <div style={{ color: C.dim, fontSize: 13, padding: '20px', textAlign: 'center' }}>No open positions</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                    {['#', 'SIDE', 'STRATEGY', 'ENTRY', 'STOP LOSS', 'TAKE PROFIT', 'RISK $', 'UNREAL PnL'].map(h => (
                      <th key={h} style={{ textAlign: 'left', padding: '4px 8px', color: C.dim, fontSize: 10, letterSpacing: '.05em', fontWeight: 600 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {openTrades.map(t => {
                    const diff = t.dir === 'long' ? price - t.entry : t.entry - price;
                    const sd = Math.abs(t.entry - t.sl);
                    const unreal = sd > 0 ? (diff / sd) * t.risk : 0;
                    return (
                      <tr key={t.id} style={{ borderBottom: `1px solid ${C.border}22` }}>
                        <td style={{ padding: '7px 8px', color: C.dim, ...mono }}>#{t.id}</td>
                        <td style={{ padding: '7px 8px' }}><span style={badge(t.dir === 'long' ? C.green : C.red)}>{t.dir.toUpperCase()}</span></td>
                        <td style={{ padding: '7px 8px', color: C.text }}>{t.strat}</td>
                        <td style={{ padding: '7px 8px', ...mono, color: C.text }}>{t.entry.toFixed(2)}</td>
                        <td style={{ padding: '7px 8px', ...mono, color: C.red }}>{t.sl.toFixed(2)}</td>
                        <td style={{ padding: '7px 8px', ...mono, color: C.green }}>{t.tp.toFixed(2)}</td>
                        <td style={{ padding: '7px 8px', ...mono, color: C.amber }}>${t.risk.toFixed(2)}</td>
                        <td style={{ padding: '7px 8px', ...mono, color: unreal >= 0 ? C.green : C.red, fontWeight: 700 }}>
                          {unreal >= 0 ? '+' : ''}${unreal.toFixed(2)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Closed Trades */}
          <div style={panel()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10, alignItems: 'center' }}>
              <span style={{ fontSize: 10, color: C.dim, letterSpacing: '.1em' }}>TRADE HISTORY ({closedTrades.length})</span>
              <span style={{ ...mono, fontSize: 12, color: stats.totalPnL >= 0 ? C.green : C.red }}>
                Total: {stats.totalPnL >= 0 ? '+' : ''}${stats.totalPnL.toFixed(2)}
              </span>
            </div>
            {closedTrades.length === 0 ? (
              <div style={{ color: C.dim, fontSize: 13, padding: '20px', textAlign: 'center' }}>No closed trades yet</div>
            ) : (
              <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                      {['#', 'SIDE', 'STRATEGY', 'ENTRY', 'EXIT', 'RESULT', 'P&L'].map(h => (
                        <th key={h} style={{ textAlign: 'left', padding: '4px 8px', color: C.dim, fontSize: 10, letterSpacing: '.05em', position: 'sticky', top: 0, background: C.panel }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {closedTrades.map(t => (
                      <tr key={t.id + 'c'} className="slidein" style={{ borderBottom: `1px solid ${C.border}18` }}>
                        <td style={{ padding: '6px 8px', color: C.dim, ...mono }}>#{t.id}</td>
                        <td style={{ padding: '6px 8px' }}><span style={badge(t.dir === 'long' ? C.green : C.red)}>{t.dir.toUpperCase()}</span></td>
                        <td style={{ padding: '6px 8px', color: C.text, fontSize: 11 }}>{t.strat}</td>
                        <td style={{ padding: '6px 8px', ...mono, color: C.text }}>{t.entry.toFixed(2)}</td>
                        <td style={{ padding: '6px 8px', ...mono, color: C.text }}>{t.exit?.toFixed(2)}</td>
                        <td style={{ padding: '6px 8px' }}>
                          <span style={badge(t.reason === 'TP' ? C.green : C.red)}>{t.reason === 'TP' ? '✓ TP' : '✗ SL'}</span>
                        </td>
                        <td style={{ padding: '6px 8px', ...mono, color: t.pnl >= 0 ? C.green : C.red, fontWeight: 700 }}>
                          {t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══════════════════════════════ LOG TAB ═══════════════════════════════ */}
      {tab === 'log' && (
        <div style={{ ...panel(), maxHeight: 520, overflowY: 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ fontSize: 10, color: C.dim, letterSpacing: '.1em' }}>SYSTEM EVENT LOG ({logs.length})</span>
            <button onClick={() => setLogs([{ id: Date.now(), time: new Date().toLocaleTimeString(), msg: 'Log cleared.', type: 'info' }])}
              style={{ fontSize: 10, color: C.dim, background: 'none', border: `1px solid ${C.border}`, borderRadius: 3, padding: '2px 8px', cursor: 'pointer' }}>
              CLEAR
            </button>
          </div>
          {logs.map(l => (
            <div key={l.id} className="slidein" style={{ display: 'flex', gap: 10, padding: '5px 0', borderBottom: `1px solid ${C.border}18`, alignItems: 'flex-start' }}>
              <span style={{ ...mono, color: C.dimmer, fontSize: 10, whiteSpace: 'nowrap', marginTop: 1 }}>{l.time}</span>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: l.type === 'win' ? C.green : l.type === 'loss' ? C.red : l.type === 'signal' ? C.gold : C.dim, marginTop: 4, flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: l.type === 'win' ? C.green : l.type === 'loss' ? C.red : l.type === 'signal' ? C.goldBright : C.text, fontFamily: l.type === 'signal' ? "'Share Tech Mono', monospace" : 'Rajdhani, sans-serif', lineHeight: 1.4 }}>
                {l.msg}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ═══════════════════════════════ SETTINGS TAB ═══════════════════════════════ */}
      {tab === 'settings' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>

          {/* Risk Management */}
          <div style={panel()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 16 }}>
              <Shield size={14} color={C.gold} />
              <span style={{ fontSize: 11, color: C.gold, letterSpacing: '.1em', fontWeight: 700 }}>RISK MANAGEMENT</span>
            </div>

            <div style={{ marginBottom: 18 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 13, color: C.text }}>Risk per trade</span>
                <span style={{ ...mono, color: C.gold, fontSize: 14 }}>{settings.risk}%</span>
              </div>
              <input type="range" min={0.5} max={5} step={0.5} value={settings.risk}
                onChange={e => setSettings(s => ({ ...s, risk: +e.target.value }))}
                style={{ width: '100%', accentColor: C.gold, height: 4 }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: C.dim, marginTop: 3 }}>
                <span>0.5% Conservative</span><span>5% Aggressive</span>
              </div>
            </div>

            <div style={{ marginBottom: 18 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 13, color: C.text }}>Max drawdown circuit breaker</span>
                <span style={{ ...mono, color: drawdown > settings.maxDD * 0.8 ? C.red : C.gold, fontSize: 14 }}>{settings.maxDD}%</span>
              </div>
              <input type="range" min={5} max={30} step={1} value={settings.maxDD}
                onChange={e => setSettings(s => ({ ...s, maxDD: +e.target.value }))}
                style={{ width: '100%', accentColor: C.red, height: 4 }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: C.dim, marginTop: 3 }}>
                <span>5% Tight</span><span>30% Loose</span>
              </div>
            </div>

            <div style={{ background: `${C.gold}0c`, border: `1px solid ${C.gold}25`, borderRadius: 6, padding: '12px 14px', fontSize: 12 }}>
              <div style={{ color: C.text, fontWeight: 600, marginBottom: 8, fontSize: 13 }}>Position Sizing Summary</div>
              {[
                ['Current equity', `$${equity.toFixed(2)}`, C.text],
                ['Risk per trade', `$${(equity * settings.risk / 100).toFixed(2)} (${settings.risk}%)`, C.amber],
                ['Estimated lot size', `0.0${Math.max(1, Math.round(equity * settings.risk / 100 / (ind.atr * 1.5 * 10)))} lots`, C.blue],
                ['R:R ratio', '1 : 2 (SL × 1.5 ATR, TP × 3 ATR)', C.green],
                ['Circuit breaker at', `$${(peakEq * (1 - settings.maxDD / 100)).toFixed(2)}`, C.red],
              ].map(([k, v, col]) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: `1px solid ${C.border}22` }}>
                  <span style={{ color: C.dim }}>{k}</span>
                  <span style={{ ...mono, color: col, fontSize: 11 }}>{v}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Strategy Config */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={panel()}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 14 }}>
                <Zap size={14} color={C.gold} />
                <span style={{ fontSize: 11, color: C.gold, letterSpacing: '.1em', fontWeight: 700 }}>STRATEGY CONFIG</span>
              </div>

              {[
                { key: 'trend', label: 'Trend Following', sub: 'EMA(20/50) crossover + RSI(14) > 50 filter', color: C.gold, info: 'Active when ADX > 25 (TRENDING regime)' },
                { key: 'meanRev', label: 'Mean Reversion', sub: 'Bollinger Bands(20,2) + RSI(14) extremes', color: C.blue, info: 'Active when ADX < 18 (RANGING regime)' },
              ].map(({ key, label, sub, color, info }) => (
                <div key={key} onClick={() => setSettings(s => ({ ...s, [key]: !s[key] }))}
                  style={{ padding: '14px', marginBottom: 8, background: settings[key] ? `${color}0d` : C.panel2, border: `1.5px solid ${settings[key] ? color + '55' : C.border}`, borderRadius: 8, cursor: 'pointer', transition: 'all 0.2s' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: settings[key] ? color : C.dim }}>{label}</div>
                      <div style={{ fontSize: 11, color: C.dim, marginTop: 2 }}>{sub}</div>
                    </div>
                    <div style={{ width: 38, height: 20, borderRadius: 10, background: settings[key] ? color : C.border, position: 'relative', transition: 'all 0.2s', flexShrink: 0 }}>
                      <div style={{ position: 'absolute', top: 2, left: settings[key] ? 19 : 2, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'all 0.2s' }} />
                    </div>
                  </div>
                  <div style={{ fontSize: 10, color: settings[key] ? color : C.dimmer, marginTop: 4 }}>{info}</div>
                </div>
              ))}
            </div>

            <div style={{ ...panel(), fontSize: 12, color: C.dim, lineHeight: 1.7 }}>
              <div style={{ color: C.text, fontWeight: 700, marginBottom: 8, fontSize: 13 }}>Regime Detection Logic</div>
              <div>ADX <span style={{ color: C.text }}>&gt; 25</span> → <span style={{ color: C.gold }}>TRENDING</span> (EMA priority)</div>
              <div>ADX <span style={{ color: C.text }}>18–25</span> → <span style={{ color: C.text }}>NEUTRAL</span> (Both active)</div>
              <div>ADX <span style={{ color: C.text }}>&lt; 18</span> → <span style={{ color: C.blue }}>RANGING</span> (BB/RSI priority)</div>
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${C.border}` }}>
                <div>Stop Loss: <span style={{ color: C.text }}>1.5 × ATR(14)</span></div>
                <div>Take Profit: <span style={{ color: C.text }}>3.0 × ATR(14)</span></div>
                <div>Max open trades: <span style={{ color: C.text }}>2 positions</span></div>
                <div>Negative balance protection: <span style={{ color: C.green }}>ENABLED</span></div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── FOOTER ── */}
      <div style={{ marginTop: 12, paddingTop: 8, borderTop: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between', fontSize: 10, color: C.dimmer }}>
        <span>XAU/USD · EXNESS MT5 SIMULATION · For educational/learning purposes only · Not financial advice</span>
        <span style={mono}>
          {running ? <span style={{ color: C.green }}>● ACTIVE</span> : <span>○ IDLE</span>}
          {' '}· Risk {settings.risk}% · DD Limit {settings.maxDD}% · {regime}
        </span>
      </div>
    </div>
  );
}
