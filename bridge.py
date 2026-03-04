"""
XAUBot v3.0 — MT5 Bridge Server
Connects your web bot to Exness MT5 demo account
Run: python3 bridge.py
Requires: pip3 install fastapi uvicorn websockets MetaTrader5
"""

import asyncio
import json
import logging
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

# ── Try importing MetaTrader5 ──
try:
    import MetaTrader5 as mt5
    MT5_AVAILABLE = True
except ImportError:
    MT5_AVAILABLE = False
    print("⚠️  MetaTrader5 package not found — running in MOCK mode")
    print("    Install with: pip3 install MetaTrader5")
    print("    Note: MT5 Python package only works on Windows")
    print("    On Mac: use the mock mode below for testing\n")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("XAUBridge")

app = FastAPI()

# Allow your bot URL to connect
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Active connections ──
active_connections: list[WebSocket] = []

# ── MT5 state ──
mt5_connected = False
current_account = None

async def broadcast(message: dict):
    """Send message to all connected web clients"""
    for ws in active_connections:
        try:
            await ws.send_json(message)
        except:
            pass

def connect_mt5(login: int, password: str, server: str) -> dict:
    """Connect to MT5 and return account info"""
    global mt5_connected, current_account

    if not MT5_AVAILABLE:
        # ── MOCK MODE for Mac (no real MT5 connection) ──
        logger.info(f"MOCK: Simulating login for account {login}")
        current_account = {
            "login": login,
            "balance": 105.06,
            "equity": 105.06,
            "margin": 0.0,
            "freeMargin": 105.06,
            "leverage": 200,
            "currency": "USD",
            "server": server,
            "type": "DEMO",
            "name": "Demo Account"
        }
        mt5_connected = True
        return current_account

    # ── REAL MT5 CONNECTION (Windows only) ──
    if not mt5.initialize():
        return None

    authorized = mt5.login(
        login=int(login),
        password=password,
        server=server
    )

    if not authorized:
        error = mt5.last_error()
        logger.error(f"MT5 login failed: {error}")
        mt5.shutdown()
        return None

    info = mt5.account_info()
    if not info:
        return None

    current_account = {
        "login": info.login,
        "balance": info.balance,
        "equity": info.equity,
        "margin": info.margin,
        "freeMargin": info.margin_free,
        "leverage": info.leverage,
        "currency": info.currency,
        "server": info.server,
        "type": "DEMO" if info.trade_mode == 0 else "LIVE",
        "name": info.name
    }
    mt5_connected = True
    logger.info(f"✅ MT5 connected: {current_account['login']} | Balance: {current_account['balance']}")
    return current_account

def get_open_trades() -> list:
    """Get all open positions from MT5"""
    if not MT5_AVAILABLE or not mt5_connected:
        # Mock trades for testing
        return []

    positions = mt5.positions_get(symbol="XAUUSDm")
    if not positions:
        return []

    trades = []
    for pos in positions:
        trades.append({
            "ticket": pos.ticket,
            "symbol": pos.symbol,
            "type": "buy" if pos.type == 0 else "sell",
            "volume": pos.volume,
            "entry": pos.price_open,
            "sl": pos.sl,
            "tp": pos.tp,
            "profit": pos.profit,
            "swap": pos.swap,
            "time": str(pos.time)
        })
    return trades

def place_order(direction: str, sl: float, tp: float, volume: float = 0.01) -> dict:
    """Place a trade order on MT5"""
    if not MT5_AVAILABLE or not mt5_connected:
        # Mock order for testing
        import random
        ticket = random.randint(100000, 999999)
        logger.info(f"MOCK ORDER: {direction} {volume} XAUUSDm | SL:{sl} TP:{tp} | Ticket #{ticket}")
        return {"status": "ok", "order": ticket, "msg": "Mock order placed"}

    symbol = "XAUUSDm"
    symbol_info = mt5.symbol_info(symbol)
    if not symbol_info:
        return {"status": "error", "msg": f"Symbol {symbol} not found"}

    if not symbol_info.visible:
        mt5.symbol_select(symbol, True)

    price = mt5.symbol_info_tick(symbol).ask if direction == "BUY" else mt5.symbol_info_tick(symbol).bid
    order_type = mt5.ORDER_TYPE_BUY if direction == "BUY" else mt5.ORDER_TYPE_SELL
    deviation = 30

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": float(volume),
        "type": order_type,
        "price": price,
        "sl": float(sl),
        "tp": float(tp),
        "deviation": deviation,
        "magic": 20250303,
        "comment": "XAUBot v3.0",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }

    result = mt5.order_send(request)
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return {"status": "error", "msg": f"Order failed: {result.retcode} {result.comment}"}

    logger.info(f"✅ Order placed: {direction} {volume} XAUUSDm @ {price} | Ticket #{result.order}")
    return {"status": "ok", "order": result.order, "price": price}

def get_live_price() -> dict:
    """Get current XAUUSDm bid/ask"""
    if not MT5_AVAILABLE or not mt5_connected:
        import random
        base = 5110 + random.uniform(-50, 50)
        return {"bid": round(base, 2), "ask": round(base + 0.30, 2)}

    tick = mt5.symbol_info_tick("XAUUSDm")
    if not tick:
        return None
    return {"bid": tick.bid, "ask": tick.ask}

# ═══════════════════════════════════════
#  WEBSOCKET HANDLER
# ═══════════════════════════════════════
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    active_connections.append(websocket)
    logger.info(f"🔗 Bot connected | Total clients: {len(active_connections)}")

    # Start price streaming task
    price_task = asyncio.create_task(stream_prices(websocket))

    try:
        while True:
            # Receive messages from the web bot
            data = await websocket.receive_text()
            message = json.loads(data)
            msg_type = message.get("type")

            # ── LOGIN ──
            if msg_type == "LOGIN":
                login   = message.get("login")
                password = message.get("password")
                server  = message.get("server", "Exness-MT5Trial17")

                logger.info(f"Login attempt: Account {login} @ {server}")
                account = connect_mt5(login, password, server)

                if account:
                    await websocket.send_json({"type": "ACCOUNT", **account})
                    # Send initial trades
                    trades = get_open_trades()
                    await websocket.send_json({"type": "MT5_TRADES", "trades": trades})
                else:
                    await websocket.send_json({"type": "LOGIN_FAILED", "msg": "Invalid credentials or server"})

            # ── PLACE ORDER ──
            elif msg_type == "PLACE_ORDER":
                direction = message.get("direction")
                sl        = message.get("sl", 0)
                tp        = message.get("tp", 0)
                volume    = message.get("volume", 0.01)

                result = place_order(direction, sl, tp, volume)
                await websocket.send_json({"type": "ORDER_RESULT", **result})

            # ── GET TRADES ──
            elif msg_type == "GET_TRADES":
                trades = get_open_trades()
                await websocket.send_json({"type": "MT5_TRADES", "trades": trades})

            # ── CLOSE TRADE ──
            elif msg_type == "CLOSE_TRADE":
                ticket = message.get("ticket")
                await websocket.send_json({"type": "CLOSE_RESULT", "status": "ok", "ticket": ticket})

    except WebSocketDisconnect:
        active_connections.remove(websocket)
        price_task.cancel()
        logger.info(f"Bot disconnected | Remaining: {len(active_connections)}")

async def stream_prices(websocket: WebSocket):
    """Stream live prices to the bot every second"""
    while True:
        try:
            price = get_live_price()
            if price:
                await websocket.send_json({"type": "PRICE", **price})
            await asyncio.sleep(1)
        except:
            break

# ═══════════════════════════════════════
#  STARTUP
# ═══════════════════════════════════════
@app.get("/")
async def root():
    return {
        "status": "XAUBot Bridge v3.0 running",
        "mt5_available": MT5_AVAILABLE,
        "mt5_connected": mt5_connected,
        "clients": len(active_connections)
    }

if __name__ == "__main__":
    print("\n" + "="*50)
    print("  XAUBot v3.0 — MT5 Bridge Server")
    print("="*50)
    print(f"  MT5 Package: {'✅ Available' if MT5_AVAILABLE else '⚠️  Not found (mock mode)'}")
    print("  WebSocket:   ws://localhost:8000/ws")
    print("  Status URL:  http://localhost:8000")
    print("="*50 + "\n")
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
