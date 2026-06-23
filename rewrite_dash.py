import re

with open('dashboard.html', 'r') as f:
    html = f.read()

css_patch = """
/* ─── NEW DASH LAYOUT ─── */
.dash-header { display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:24px; }
.dash-greeting h1 { font-size:28px; font-weight:500; letter-spacing:-.01em; color:var(--text); margin-bottom:4px; }
.dash-greeting p { font-size:14px; font-weight:300; color:var(--text2); }
.dash-header .kpi-row { display:flex; gap:14px; margin-bottom:0; }
.kpi { min-width:140px; }
.col-stack { display:flex; flex-direction:column; gap:16px; }
.bottom-cards { display:grid; grid-template-columns:repeat(5, 1fr); gap:16px; margin-top:16px; margin-bottom:60px; }
.b-card { background:var(--surface); border:0.5px solid var(--border); border-radius:var(--r); padding:18px; display:flex; flex-direction:column; }
.b-card-head { display:flex; justify-content:space-between; align-items:center; font-size:12px; font-weight:600; color:var(--text); margin-bottom:14px; }
.b-card-head svg { color:var(--pink); }

/* Command Bar */
.cmd-dock { position:fixed; bottom:20px; left:50%; transform:translateX(-50%); z-index:100; background:rgba(22,22,26,0.85); backdrop-filter:blur(24px); border:0.5px solid var(--border2); border-radius:30px; padding:8px; display:flex; align-items:center; gap:12px; box-shadow:0 10px 40px rgba(0,0,0,0.5); width:100%; max-width:900px; }
.cmd-dock-input { flex:1; display:flex; align-items:center; gap:10px; background:var(--surface); border-radius:24px; padding:10px 16px; border:0.5px solid var(--border); }
.cmd-dock-input input { background:none; border:none; outline:none; color:var(--text); font-size:14px; flex:1; font-family:var(--ff); }
.cmd-dock-kbd { font-size:10px; color:var(--text3); border:0.5px solid var(--border2); padding:2px 6px; border-radius:4px; }
.cmd-chips { display:flex; gap:8px; overflow-x:auto; }
.cmd-chip { font-size:12px; color:var(--text2); background:var(--surface); border:0.5px solid var(--border); border-radius:20px; padding:6px 12px; white-space:nowrap; transition:0.2s; cursor:pointer; }
.cmd-chip:hover { color:var(--text); border-color:var(--text3); }
"""

html = html.replace('/* ─── HERO GREETING ─── */', css_patch + '\n/* ─── HERO GREETING ─── */')

# Strip old command bar
html = re.sub(r'<!-- COMMAND BAR -->.*?</div>', '', html, flags=re.DOTALL)

# Re-structure main grid
html_structure = """
    <!-- DASH HEADER -->
    <div class="dash-header">
      <div class="dash-greeting">
        <h1>Good Morning, <span id="greetingName">Meddy</span>. <span class="wave">👋</span></h1>
        <p>Here's what's happening in your salon today.</p>
      </div>
      <div class="kpi-row">
        <div class="kpi"><div class="kpi-val">7</div><div class="kpi-label">Appointments</div><div class="kpi-sub">Today</div></div>
        <div class="kpi"><div class="kpi-val">3</div><div class="kpi-label">Missed Calls</div><div class="kpi-sub">Need Follow Up</div></div>
        <div class="kpi"><div class="kpi-val">2</div><div class="kpi-label">New Leads</div><div class="kpi-sub">Hot Prospects</div></div>
        <div class="kpi accent"><div class="kpi-val">$2,850</div><div class="kpi-label">Potential Revenue</div><div class="kpi-sub">Today</div></div>
      </div>
    </div>

    <!-- MAIN GRID -->
    <div class="grid-main">
      <!-- LOLA HERO PANEL -->
      <div class="lola-panel">
        <div id="usageBanner" style="display:none"></div>
        <div class="lola-orb-zone">
          <div class="lola-orb-stage" id="orbStage" onclick="toggleVoice()">
            <canvas id="orbCanvas" width="300" height="300"></canvas>
            <div class="lola-core">
              <div class="lola-name">LOLA</div>
            </div>
          </div>
          <div class="lola-prompt">
            <div class="lola-prompt-title" id="orbTitle">Hey Lola…</div>
            <div class="lola-prompt-sub" id="orbSub">Tap to speak or type a command</div>
          </div>
          <button class="lola-mic" id="orbMic" onclick="toggleVoice()">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v3M8 22h8"/></svg>
          </button>
        </div>
      </div>

      <!-- MIDDLE COLUMN -->
      <div class="col-stack">
        <!-- SCHEDULE -->
        <div class="card" style="flex:1">
          <div class="card-head">
            <div class="card-title">Today's Schedule</div><span class="card-link">View all</span>
          </div>
          <div class="card-body" id="scheduleList" style="max-height:200px;overflow-y:auto"></div>
        </div>
        <!-- AI INSIGHTS -->
        <div class="card" style="flex:1">
          <div class="card-head">
            <div class="card-title">AI Insights</div><span class="card-link">View all</span>
          </div>
          <div class="card-body" id="insightsList"></div>
        </div>
      </div>

      <!-- RIGHT COLUMN -->
      <div class="col-stack">
        <!-- REVENUE -->
        <div class="card" style="flex:1">
          <div class="card-head">
            <div class="card-title">Today's Revenue</div><span class="card-link">Report</span>
          </div>
          <div style="padding:16px 18px">
            <div class="rev-big">$2,840</div>
            <div class="rev-change"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M7 17L17 7M17 7H8M17 7v9"/></svg>18% vs yesterday</div>
            <div class="rev-chart" style="margin-top:10px;"><canvas id="revChart" width="300" height="70"></canvas></div>
          </div>
        </div>
        <!-- TOP SERVICES -->
        <div class="card" style="flex:1">
          <div class="card-head">
            <div class="card-title">Top Services</div><span class="card-link">This month</span>
          </div>
          <div class="donut-wrap">
            <div class="donut"><canvas id="donutChart" width="100" height="100"></canvas></div>
            <div class="donut-legend" style="font-size:11px;">
              <div class="legend-item"><span class="legend-dot" style="background:#ff2d8e"></span>Blonde Services <span style="margin-left:auto">48%</span></div>
              <div class="legend-item"><span class="legend-dot" style="background:#ff6bb0"></span>Extensions <span style="margin-left:auto">28%</span></div>
              <div class="legend-item"><span class="legend-dot" style="background:#c44d8a"></span>Color <span style="margin-left:auto">16%</span></div>
              <div class="legend-item"><span class="legend-dot" style="background:#7a3a5c"></span>Haircut & Style <span style="margin-left:auto">8%</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- BOTTOM CARDS -->
    <div class="bottom-cards">
      <div class="b-card">
        <div class="b-card-head"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="9" cy="7" r="3"/><path d="M3 21v-1a5 5 0 015-5h2a5 5 0 015 5v1M16 3.5a3 3 0 010 6M21 21v-1a5 5 0 00-3-4.5"/></svg> Clients</div>
        <div style="display:flex;gap:12px;margin-bottom:16px;">
          <img src="https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=80&q=80" style="width:48px;height:48px;border-radius:6px;object-fit:cover;">
          <div>
            <div style="font-size:14px;font-weight:500;">Jennifer Adams <span style="font-size:8px;background:rgba(255,215,0,0.2);color:gold;padding:2px 4px;border-radius:4px;margin-left:4px;">VIP</span></div>
            <div style="font-size:11px;color:var(--text3);">VIP Blonde Client</div>
          </div>
        </div>
        <div style="font-size:11px;color:var(--text2);margin-bottom:4px;">Lifetime Value: <strong style="color:var(--text)">$14,250</strong></div>
        <div style="font-size:11px;color:var(--text2);margin-bottom:4px;">Next Visit: <strong style="color:var(--text)">June 18, 2024</strong></div>
        <div style="font-size:10px;background:var(--surface2);padding:8px;border-radius:6px;color:var(--text2);margin-top:auto;"><strong>AI Notes:</strong> Prefers cool blonde tones. Always books Friday afternoons. Loves scalp treatments.</div>
      </div>
      
      <div class="b-card">
        <div class="b-card-head"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M5 4h4l2 5-3 2a11 11 0 005 5l2-3 5 2v4a1 1 0 01-1 1A16 16 0 014 5a1 1 0 011-1z"/></svg> Live Call</div>
        <div style="text-align:center;margin-bottom:12px;">
           <div style="width:40px;height:40px;border-radius:50%;background:linear-gradient(45deg,var(--pink),var(--pink2));margin:0 auto 8px;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:18px;">L</div>
           <div style="font-size:13px;font-weight:500;">Lola AI</div>
           <div style="font-size:10px;color:var(--text2);">Talking to Sarah (02:18)</div>
        </div>
        <div style="font-size:11px;color:var(--text2);display:flex;justify-content:space-between;margin-bottom:4px;"><span>Probability to Book</span><strong style="color:var(--text)">92%</strong></div>
        <div style="height:4px;background:var(--surface2);border-radius:2px;margin-bottom:12px;overflow:hidden;"><div style="height:100%;width:92%;background:var(--pink);"></div></div>
        <div style="font-size:10px;color:var(--text3);line-height:1.4;">
          <strong>Sarah:</strong> Hi, I'm looking to get a balayage...<br>
          <strong style="color:var(--pink)">Lola:</strong> Great! I can definitely help with that...
        </div>
      </div>

      <div class="b-card">
        <div class="b-card-head"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg> Inbox</div>
        <div style="display:flex;flex-direction:column;gap:12px;" id="inboxList"></div>
      </div>

      <div class="b-card">
        <div class="b-card-head"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg> Revenue</div>
        <div style="font-size:24px;font-weight:600;margin-bottom:4px;">$38,200</div>
        <div style="font-size:11px;color:var(--pink2);margin-bottom:16px;">↑ 24% vs last month</div>
        <div style="flex:1;display:flex;align-items:flex-end;gap:4px;height:80px;">
           <div style="flex:1;background:var(--surface2);height:40%;border-radius:2px;"></div>
           <div style="flex:1;background:var(--surface2);height:60%;border-radius:2px;"></div>
           <div style="flex:1;background:var(--pink-dim);height:80%;border-radius:2px;"></div>
           <div style="flex:1;background:var(--pink);height:100%;border-radius:2px;"></div>
           <div style="flex:1;background:var(--pink-dim);height:70%;border-radius:2px;"></div>
           <div style="flex:1;background:var(--surface2);height:50%;border-radius:2px;"></div>
           <div style="flex:1;background:var(--surface2);height:90%;border-radius:2px;"></div>
        </div>
      </div>

      <div class="b-card">
        <div class="b-card-head"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0116 0v1"/></svg> Team</div>
        <div style="display:flex;flex-direction:column;gap:14px;" id="teamList"></div>
      </div>
    </div>
"""

# Replace from main grid start to quick-grid end
html = re.sub(r'<!-- MAIN GRID -->.*?</div>\s*<!-- BOTTOM PANELS -->.*?</div>', html_structure, html, flags=re.DOTALL)

# Add command bar before </main>
cmd_dock = """
    <!-- COMMAND DOCK -->
    <div class="cmd-dock">
      <div class="cmd-dock-input">
        <span class="cmd-dock-kbd">⌘K</span>
        <input placeholder="Ask Lola anything..."/>
      </div>
      <div class="cmd-chips">
        <button class="cmd-chip">Book Sarah for balayage</button>
        <button class="cmd-chip">Call clients overdue 12 weeks</button>
        <button class="cmd-chip">Show highest spending blondes</button>
        <button class="cmd-chip">What's my revenue this month?</button>
      </div>
      <button style="background:var(--pink-dim);color:var(--pink);width:32px;height:32px;border-radius:16px;display:flex;align-items:center;justify-content:center;border:none;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>
    </div>
"""
html = html.replace('</main>', cmd_dock + '\n  </main>')

with open('dashboard.html', 'w') as f:
    f.write(html)
