import asyncio, sys, json
from playwright.async_api import async_playwright
URL=sys.argv[1]
async def main():
  async with async_playwright() as p:
    br=await p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    pg=await br.new_page(viewport={'width':1360,'height':1100}); errs=[]
    pg.on('pageerror',lambda e:errs.append('PE '+str(e))); pg.on('console',lambda m: errs.append(m.type+' '+m.text) if m.type in('error','warning') else None)
    await pg.goto(URL); await pg.wait_for_timeout(500); print('pre',errs)
    await pg.click('#tapBtn'); 
    try: await pg.wait_for_function("window.__underkit.ready()",timeout=60000)
    except Exception as e: print('notready',e)
    r=await pg.evaluate("""()=>{const f=window.__underkit,h=f.harm(); return {load:document.getElementById('load').textContent,status:document.getElementById('status').textContent,
      chords:h.segs.map(s=>s.name+' '+s.fit.toFixed(2)+' '+s.conf.toFixed(2)), avg:h.avgFit, key:f.detectKey&&JSON.stringify(f.detectKey(f.melody()))}}""")
    print(json.dumps(r,indent=1))
    for st in ['simple','moody','color']:
      await pg.evaluate("s=>window.__underkit.setSetting('style',s)",st); print(st, await pg.evaluate("()=>window.__underkit.harm().segs.map(s=>s.name).join(' ')"))
    await pg.evaluate("()=>window.__underkit.setSetting('style','pop')")
    await pg.click('#play'); await pg.wait_for_timeout(3000); print('playing',await pg.evaluate("()=>window.__underkit.playing()"), await pg.evaluate("()=>(window.__schedLog||[]).length"))
    await pg.click('#play')
    w=await pg.evaluate("async()=>{const r=await window.__underkit.exportWavBytes({}); return {name:r.name,frames:r.frames,n:r.bytes.length}}"); print(w)
    m=await pg.evaluate("()=>{const r=window.__underkit.exportMidBytes(); return {name:r.name,n:r.bytes.length}}"); print(m)
    c=await pg.evaluate("()=>{const r=window.__underkit.exportChartBytes(); return {name:r.name,t:new TextDecoder().decode(r.bytes)}}"); print(c['name']); print(c['t'][:1500])
    s=await pg.evaluate("async()=>{const r=await window.__underkit.exportStemsBytes(); return {name:r.name,n:r.zip.length,files:r.files.map(f=>f.name)}}"); print(s)
    await pg.screenshot(path='/workspace/underkit/qa/out/smoke.png',full_page=True)
    print('ERRS',errs[:20]); await br.close()
asyncio.run(main())
