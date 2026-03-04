import asyncio, json, logging
import websockets
from websockets.server import WebSocketServerProtocol

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(message)s', datefmt='%H:%M:%S')
log = logging.getLogger("XAUBridge")

web_clients = set()
ea_client   = None
latest      = {"account": None, "price": None, "trades": [], "indicators": None}

async def broadcast(msg):
    if not web_clients: return
    data = json.dumps(msg)
    dead = set()
    for ws in web_clients:
        try: await ws.send(data)
        except: dead.add(ws)
    web_clients.difference_update(dead)

async def handle_web(ws):
    web_clients.add(ws)
    log.info(f"🌐 Web bot connected | Total: {len(web_clients)}")
    if latest["account"]: await ws.send(json.dumps(latest["account"]))
    if latest["price"]:   await ws.send(json.dumps(latest["price"]))
    if latest["trades"]:  await ws.send(json.dumps({"type":"MT5_TRADES","trades":latest["trades"]}))
    try:
        async for msg in ws:
            try:
                data = json.loads(msg)
                if data.get("type") == "GET_TRADES" and ea_client:
                    await ea_client.send(json.dumps({"type":"GET_TRADES"}))
            except: pass
    except websockets.exceptions.ConnectionClosed: pass
    finally:
        web_clients.discard(ws)
        log.info(f"🌐 Web bot disconnected")

async def handle_ea(ws):
    global ea_client
    ea_client = ws
    log.info("🤖 MT5 EA connected!")
    await broadcast({"type":"EA_STATUS","connected":True})
    try:
        async for msg in ws:
            try:
                data = json.loads(msg)
                t = data.get("type")
                if t == "PRICE":
                    latest["price"] = data
                    await broadcast(data)
                elif t == "ACCOUNT_UPDATE":
                    latest["account"] = {**data,"type":"ACCOUNT"}
                    await broadcast({**data,"type":"ACCOUNT"})
                    log.info(f"💰 #{data.get('login')} Balance:${data.get('balance',0):.2f} Equity:${data.get('equity',0):.2f}")
                elif t == "MT5_TRADES":
                    latest["trades"] = data.get("trades",[])
                    await broadcast(data)
                elif t == "INDICATORS":
                    latest["indicators"] = data
                    await broadcast(data)
                elif t == "ORDER_PLACED":
                    log.info(f"📊 {data.get('direction')} {data.get('strategy')} @ ${data.get('entry',0):.2f}")
                    await broadcast({**data,"type":"ORDER_RESULT","status":"ok"})
                elif t == "TRADE_CLOSED":
                    pnl = data.get("profit",0)
                    log.info(f"{'✅' if pnl>=0 else '❌'} Closed: {'+'if pnl>=0 else ''}${pnl:.2f}")
                    await broadcast(data)
                elif t == "EA_CONNECTED":
                    log.info(f"✅ EA: Account {data.get('account')} on {data.get('server')} Balance:${data.get('balance',0):.2f}")
                    await broadcast({"type":"ACCOUNT","login":data.get("account"),"balance":data.get("balance",0),"equity":data.get("balance",0),"margin":0,"freeMargin":data.get("balance",0),"leverage":200,"currency":"USD","server":data.get("server","Exness"),"accountType":"DEMO"})
                elif t == "CIRCUIT_BREAKER":
                    log.warning(f"⚠️ Circuit breaker! DD:{data.get('drawdown')}%")
                    await broadcast(data)
            except: pass
    except websockets.exceptions.ConnectionClosed: pass
    finally:
        ea_client = None
        await broadcast({"type":"EA_STATUS","connected":False})
        log.info("🤖 MT5 EA disconnected")

async def router(ws):
    path = ws.request.path if hasattr(ws,'request') and hasattr(ws.request,'path') else "/ws"
    if path == "/ea": await handle_ea(ws)
    else: await handle_web(ws)

async def main():
    print("\n" + "="*50)
    print("  XAUBot v3.0 — MT5 Bridge Server")
    print("="*50)
    print("  Web Bot: ws://localhost:8000/ws")
    print("  MT5 EA:  ws://localhost:8000/ea")
    print("="*50 + "\n")
    async with websockets.serve(router, "0.0.0.0", 8000):
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())
