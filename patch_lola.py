import re

with open('lola-live.html', 'r') as f:
    html = f.read()

# Replace the field and aura logic
old_aura_regex = r"// ════════ ATMOSPHERE: drifting particle field ════════.*?// position aura canvas responsively"
new_aura_logic = """// ════════ ATMOSPHERE: drifting particle field ════════
const field=document.getElementById('field'), fx=field.getContext('2d');
let FW,FH, parts=[];
function sizeField(){ FW=field.width=field.offsetWidth; FH=field.height=field.offsetHeight;
  parts=Array.from({length:100},()=>({x:Math.random()*FW,y:Math.random()*FH,
    r:Math.random()*1.2+.2,s:Math.random()*.15+.02,o:Math.random()*.2+.05,
    h:Math.random()*40-20})); }
window.addEventListener('resize',sizeField); setTimeout(sizeField,30);
function drawField(){
  fx.clearRect(0,0,FW,FH);
  for(const p of parts){ p.y-=p.s; if(p.y<-5){p.y=FH+5;p.x=Math.random()*FW;}
    fx.beginPath(); fx.arc(p.x,p.y,p.r,0,7);
    fx.fillStyle=`rgba(255,${150+p.h},${190+p.h*.5},${p.o*(.3+amp*.5)})`; fx.fill(); }
  requestAnimationFrame(drawField);
}

// ════════ THE AURA: Steve Jobs Level Siri Fluid Orb ════════
const aura=document.getElementById('aura'), ax=aura.getContext('2d');
const AC=450; // center of 900 canvas
let mode='asleep', amp=0, ampTarget=0, t=0, bloom=0, bloomTarget=0;

// emotional color palette for the ribbons
const PAL={
  asleep:[ [255,45,142], [100,20,80], [30,10,30], [255,80,140] ],
  listening:[ [255,107,176], [166,75,255], [60,20,180], [255,200,255] ],
  thinking:[ [255,150,120], [255,45,142], [180,40,120], [255,220,180] ],
  speaking:[ [255,158,201], [255,45,142], [200,80,255], [255,255,255] ]
};

let curPal = PAL.asleep.map(c=>[...c]);

function drawAura(){
  t+=0.016;
  amp+=(ampTarget-amp)*0.15;
  bloom+=(bloomTarget-bloom)*0.05;
  
  const targetPal = PAL[mode]||PAL.asleep;
  for(let i=0; i<4; i++){
    curPal[i][0] += (targetPal[i][0] - curPal[i][0])*0.04;
    curPal[i][1] += (targetPal[i][1] - curPal[i][1])*0.04;
    curPal[i][2] += (targetPal[i][2] - curPal[i][2])*0.04;
  }

  ax.clearRect(0,0,900,900);
  ax.globalCompositeOperation='screen';
  
  const R = 150 + bloom*30 + amp*70; // base radius
  
  // draw 12 ribbons
  for(let i=0; i<12; i++){
    ax.beginPath();
    let colIdx = i % 4;
    let color = curPal[colIdx];
    
    // thickness and opacity
    let lw = 1.5 + (i%3)*1.0 + amp*2.5;
    let alpha = 0.5 + bloom*0.3 + amp*0.4 - (i*0.03);
    if(alpha>1) alpha=1;
    
    ax.lineWidth = lw;
    ax.strokeStyle = `rgba(${color[0]|0},${color[1]|0},${color[2]|0},${alpha})`;
    ax.shadowColor = ax.strokeStyle;
    ax.shadowBlur = 12 + amp*20;
    
    // ribbon geometry
    let points = [];
    let segments = 100;
    for(let j=0; j<=segments; j++){
      let a = (j/segments)*Math.PI*2;
      // complex sine wave noise for this layer
      let offset1 = Math.sin(a*3 + t*(0.8+i*0.15)) * (15 + amp*35);
      let offset2 = Math.cos(a*5 - t*1.2 + i) * (8 + amp*20);
      let offset3 = Math.sin(a*2 + t*0.7 - i*1.5) * (12 + amp*25);
      
      let r = R + offset1 + offset2 + offset3 + (i*4);
      
      let x = AC + Math.cos(a)*r;
      let y = AC + Math.sin(a)*r;
      points.push({x,y});
    }
    
    ax.moveTo(points[0].x, points[0].y);
    for(let j=1; j<points.length-2; j++){
      let xc = (points[j].x + points[j+1].x) / 2;
      let yc = (points[j].y + points[j+1].y) / 2;
      ax.quadraticCurveTo(points[j].x, points[j].y, xc, yc);
    }
    ax.quadraticCurveTo(
      points[points.length-2].x, 
      points[points.length-2].y, 
      points[points.length-1].x, 
      points[points.length-1].y
    );
    
    ax.stroke();
  }

  // Draw inner luminous core
  ax.globalCompositeOperation='lighter';
  let coreR = R * 0.7 + amp*30;
  const core = ax.createRadialGradient(AC,AC,0,AC,AC,coreR*1.2);
  core.addColorStop(0, `rgba(255,255,255,${0.25 + amp*0.4})`);
  core.addColorStop(0.4, `rgba(${curPal[0][0]|0},${curPal[0][1]|0},${curPal[0][2]|0},${0.3 + amp*0.3})`);
  core.addColorStop(1, 'rgba(0,0,0,0)');
  ax.fillStyle = core;
  ax.beginPath(); ax.arc(AC,AC,coreR*1.2,0,7); ax.fill();

  requestAnimationFrame(drawAura);
}
drawField(); drawAura();

// position aura canvas responsively"""
html = re.sub(old_aura_regex, new_aura_logic, html, flags=re.DOTALL)

with open('lola-live.html', 'w') as f:
    f.write(html)
