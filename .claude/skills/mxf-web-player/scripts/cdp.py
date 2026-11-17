import asyncio, json, subprocess, sys, base64, urllib.request, time, os
import websockets
import tempfile, glob
# usage: python3 cdp.py URL [step ...]
#   step = 'wait:SEC' | 'shot:NAME' (PNG -> $OUT_DIR/NAME.png) | any JS expression (awaited, printed)
S=os.environ.get('OUT_DIR') or tempfile.mkdtemp(prefix='mxfcdp-')
CH=os.environ.get('CHROME') or (sorted(glob.glob(os.path.expanduser('~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome'))) or ['chromium'])[-1]
os.makedirs(S, exist_ok=True)
PROFILE=tempfile.mkdtemp(prefix='mxfcdp-profile-')
p=subprocess.Popen([CH,'--headless=new','--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader',
  '--autoplay-policy=no-user-gesture-required','--remote-debugging-port=9333',f'--user-data-dir={PROFILE}','--window-size=1600,1000','about:blank'],
  stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
time.sleep(1.5)
tabs=json.load(urllib.request.urlopen('http://127.0.0.1:9333/json'))
ws_url=[t for t in tabs if t['type']=='page'][0]['webSocketDebuggerUrl']
async def main():
  async with websockets.connect(ws_url,max_size=None) as ws:
    n=[0]; logs=[]
    async def cmd(method,**params):
      n[0]+=1; i=n[0]; await ws.send(json.dumps({'id':i,'method':method,'params':params}))
      while True:
        m=json.loads(await ws.recv())
        if m.get('method')=='Runtime.consoleAPICalled': logs.append(' '.join(str(a.get('value',a.get('description',''))) for a in m['params']['args']))
        if m.get('method')=='Runtime.exceptionThrown': logs.append('EXC '+json.dumps(m['params']['exceptionDetails'])[:400])
        if m.get('id')==i: return m.get('result')
    async def ev(expr):
      r=await cmd('Runtime.evaluate',expression=expr,awaitPromise=True,returnByValue=True); return r.get('result',{}).get('value', r)
    async def shot(name):
      r=await cmd('Page.captureScreenshot',format='png'); open(f'{S}/{name}.png','wb').write(base64.b64decode(r['data']))
    await cmd('Runtime.enable'); await cmd('Page.enable')
    await cmd('Emulation.setDeviceMetricsOverride',width=1600,height=1000,deviceScaleFactor=1,mobile=False)
    await cmd('Page.navigate',url=sys.argv[1])
    for step in sys.argv[2:]:
      if step.startswith('wait:'): await asyncio.sleep(float(step[5:]))
      elif step.startswith('shot:'): await shot(step[5:])
      else: print('EVAL', step[:60], '=>', await ev(step))
    for l in logs: print('LOG', l[:300])
try:
  asyncio.run(main())
finally:
  p.terminate()
  print('OUT_DIR', S)
