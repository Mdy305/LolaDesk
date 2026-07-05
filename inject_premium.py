import os
import re

css_path = '/Users/jeromet/Desktop/LolaDesk-prod/app.css'
with open(css_path, 'r', encoding='utf-8') as f:
    css = f.read()

# 1. Update body to include the aura
old_body = 'body{min-height:100vh; position: relative; background: var(--bg); margin: 0;}'
new_body = '''body{min-height:100vh; position: relative; background: var(--bg); margin: 0; z-index: 0;}

/* ── Ultra-Premium Neon Pink Aura (Steve Jobs Level) ── */
body::before {
  content: "";
  position: fixed;
  top: -20%; left: -20%; width: 140%; height: 140%;
  background: 
    radial-gradient(circle at 30% 30%, rgba(255, 45, 85, 0.18) 0%, transparent 35%),
    radial-gradient(circle at 70% 70%, rgba(255, 55, 95, 0.12) 0%, transparent 40%);
  z-index: -1;
  animation: siri-breathe 20s cubic-bezier(0.4, 0, 0.2, 1) infinite alternate;
  pointer-events: none;
  filter: blur(60px);
}
@keyframes siri-breathe {
  0% { transform: translate(0, 0) scale(1) rotate(0deg); opacity: 0.8;}
  50% { transform: translate(3%, 5%) scale(1.1) rotate(3deg); opacity: 1;}
  100% { transform: translate(-2%, -3%) scale(0.95) rotate(-2deg); opacity: 0.7;}
}
'''
if old_body in css:
    css = css.replace(old_body, new_body)

# 2. Make app transparent so background shows through
css = css.replace('min-height:100vh; background: var(--bg); position: relative; z-index: 1;', 'min-height:100vh; background: transparent; position: relative; z-index: 1;')

# 3. Update sidebar to ultra glass
old_sidebar = '.sidebar{width:260px;background:rgba(10, 10, 10, 0.65);backdrop-filter:blur(40px) saturate(180%);-webkit-backdrop-filter:blur(40px) saturate(180%);border-right:0.5px solid var(--border);display:flex;flex-direction:column;padding:24px 0;position:sticky;top:0;height:100vh;z-index:40;flex-shrink:0}'
new_sidebar = '.sidebar{width:260px;background:rgba(15, 15, 18, 0.55);backdrop-filter:blur(48px) saturate(200%);-webkit-backdrop-filter:blur(48px) saturate(200%);border-right:0.5px solid rgba(255,255,255,0.08);display:flex;flex-direction:column;padding:24px 0;position:sticky;top:0;height:100vh;z-index:40;flex-shrink:0;box-shadow: 1px 0 24px rgba(0,0,0,0.3);}'
if old_sidebar in css:
    css = css.replace(old_sidebar, new_sidebar)

# 4. Make card background true glass so the aura shows through the cards too!
old_card = '.card{background:var(--surface);border:0.5px solid var(--border);border-radius:var(--r-lg);padding:24px;margin-bottom:24px}'
new_card = '.card{background:rgba(20, 20, 25, 0.55);backdrop-filter:blur(32px) saturate(180%);-webkit-backdrop-filter:blur(32px) saturate(180%);border:0.5px solid rgba(255,255,255,0.08);border-radius:var(--r-lg);padding:24px;margin-bottom:24px;box-shadow: 0 12px 40px rgba(0,0,0,0.3); transition: transform 0.4s var(--spring-bounce);}'
if old_card in css:
    css = css.replace(old_card, new_card)

# 5. Buttons pop
old_btn = '.btn{display:inline-flex;align-items:center;gap:10px;padding:11px 18px;border-radius:var(--r-sm);font-size:13px;font-weight:500;cursor:pointer;transition:all .2s;border:.5px solid transparent}'
new_btn = '.btn{display:inline-flex;align-items:center;gap:10px;padding:12px 20px;border-radius:var(--r-sm);font-size:14px;font-weight:500;cursor:pointer;transition:all 0.4s var(--spring-bounce);border:0.5px solid transparent;position:relative;overflow:hidden;}'
css = css.replace(old_btn, new_btn)

# 6. Nav items pop
old_nav = '.nav-item{display:flex;align-items:center;gap:13px;padding:11px 14px;border-radius:var(--r-sm);color:var(--text2);font-size:13.5px;font-weight:400;transition:all .15s;cursor:pointer;position:relative}'
new_nav = '.nav-item{display:flex;align-items:center;gap:13px;padding:11px 14px;border-radius:var(--r-sm);color:var(--text2);font-size:13.5px;font-weight:400;transition:all 0.4s var(--spring-bounce);cursor:pointer;position:relative}'
css = css.replace(old_nav, new_nav)
css = css.replace('.nav-item:hover{background:var(--surface);color:var(--text)}', '.nav-item:hover{background:rgba(255,255,255,0.06);color:var(--text);transform:scale(1.02);}')
css = css.replace('.nav-item.active{background:var(--pink-dim);color:var(--text)}', '.nav-item.active{background:rgba(255,255,255,0.06);color:var(--text);box-shadow:inset 0 1px 0 rgba(255,255,255,0.04)}')


with open(css_path, 'w', encoding='utf-8') as f:
    f.write(css)

print("Injected ultra premium Steve Jobs glass aura successfully!")
