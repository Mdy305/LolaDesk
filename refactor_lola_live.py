import re

filepath = '/Users/jeromet/Desktop/LolaDesk-prod/lola-live.html'
with open(filepath, 'r', encoding='utf-8') as f:
    html = f.read()

# 1. Add lola-orb.js script
if '<script src="lola-orb.js"></script>' not in html:
    html = html.replace('<script src="auth-guard.js"></script>', '<script src="lola-orb.js"></script>\n<script src="auth-guard.js"></script>')

# 2. Fix the background and remove veil
html = html.replace('.veil{position:absolute;inset:0;z-index:2;pointer-events:none;\n  background:radial-gradient(120% 80% at 50% 46%, transparent 30%, rgba(7,7,8,.55) 78%, var(--bg) 100%)}', '')
html = html.replace('<canvas id="field"></canvas>\n      <canvas id="aura" width="900" height="900"></canvas>\n      <div class="veil"></div>', '<div style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; z-index:1; pointer-events:none;"><canvas id="lolaOrbCanvas"></canvas></div>')

# Make sure background is black
html = html.replace('<body data-page="lola-live">', '<body data-page="lola-live" style="background:#000;">')

# 3. Remove the old atmosphere and aura JS
# Find the start of ATMOSPHERE and the end of THE AURA
start_idx = html.find('// ════════ ATMOSPHERE:')
end_idx = html.find('// ════════ INTERACTION ════════')
if start_idx != -1 and end_idx != -1:
    old_js = html[start_idx:end_idx]
    
    new_js = """// ════════ THE ORB ════════
const orbCanvas = document.getElementById('lolaOrbCanvas');
let orb = null;
if (window.LolaOrb && orbCanvas) {
  // Mobile responsive sizing
  const sz = Math.min(420, window.innerWidth * 0.85);
  orbCanvas.style.width = sz + 'px';
  orbCanvas.style.height = sz + 'px';
  orb = LolaOrb.mount(orbCanvas, { size: sz, particles: 140 });
  orb.setState('idle');
  window.orb = orb;
}

// Global amplitude for mic / voice
let ampTarget = 0;
function tickOrbLevel() {
  if (window.orb) window.orb.setLevel(ampTarget);
  requestAnimationFrame(tickOrbLevel);
}
tickOrbLevel();

"""
    html = html.replace(old_js, new_js + '// ════════ INTERACTION ════════\n')

# 4. Update setMode
old_setmode = "function setMode(m){ mode=m; bloomTarget = (m==='asleep')?0:1; }"
new_setmode = """function setMode(m) { 
  if (window.orb) {
    if (m === 'asleep') window.orb.setState('idle');
    else window.orb.setState(m);
  }
}"""
if old_setmode in html:
    html = html.replace(old_setmode, new_setmode)
else:
    # try regex
    html = re.sub(r'function setMode\(m\)\{ mode=m; bloomTarget.*?\}', new_setmode, html)

with open(filepath, 'w', encoding='utf-8') as f:
    f.write(html)

print("Updated lola-live.html to use the new Siri plasma orb!")
