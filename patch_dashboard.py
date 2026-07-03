import re

with open('dashboard.html', 'r') as f:
    html = f.read()

html = re.sub(r'<div class="lola-rings">\s*<div class="lring lring1">.*?</div>\s*</div>\s*</div>\s*</div>', '', html, flags=re.DOTALL)

with open('dashboard.html', 'w') as f:
    f.write(html)

with open('app.js', 'r') as f:
    app_js = f.read()

old_orb = r"const orbCanvas = document.getElementById\('orbCanvas'\);.*?drawOrb\(\);"

new_orb = """const orbCanvas = document.getElementById('orbCanvas');
const octx = orbCanvas?.getContext('2d');
let orbT = 0, energy=0, energyTarget=0, flare=0;
let orbState = 'idle'; // idle | listening | thinking | speaking | ambient

const PAL={
  idle:      [ [255,45,142], [100,20,80], [30,10,30], [255,80,140] ],
  ambient:   [ [255,45,142], [100,20,80], [30,10,30], [255,80,140] ],
  listening: [ [255,107,176], [166,75,255], [60,20,180], [255,200,255] ],
  thinking:  [ [255,150,120], [255,45,142], [180,40,120], [255,220,180] ],
  speaking:  [ [255,158,201], [255,45,142], [200,80,255], [255,255,255] ]
};
let curPal = PAL.idle.map(c=>[...c]);

function drawOrb(){
  if(!octx) return;
  orbT += 0.016;
  const active = orbState==='listening' || orbState==='speaking';
  const think = orbState==='thinking';
  
  if(active) energyTarget = 1.0;
  else if(think) energyTarget = 0.6;
  else energyTarget = 0.0;
  
  energy += (energyTarget - energy) * 0.1;
  flare *= 0.94;
  
  const targetPal = PAL[orbState]||PAL.idle;
  for(let i=0; i<4; i++){
    curPal[i][0] += (targetPal[i][0] - curPal[i][0])*0.04;
    curPal[i][1] += (targetPal[i][1] - curPal[i][1])*0.04;
    curPal[i][2] += (targetPal[i][2] - curPal[i][2])*0.04;
  }

  octx.clearRect(0,0,240,240);
  octx.globalCompositeOperation='screen';
  
  const cx = 120;
  const breath = orbState==='ambient' ? Math.sin(orbT*1.2)*0.1 : 0;
  const pulse = 1 + breath + energy*0.2 + flare*0.4;
  const R = 45 * pulse; 
  
  for(let i=0; i<10; i++){
    octx.beginPath();
    let colIdx = i % 4;
    let color = curPal[colIdx];
    
    let lw = 1.5 + (i%3)*0.8 + energy*2 + flare*2;
    let alpha = 0.5 + energy*0.3 + flare*0.5 - (i*0.04);
    if(alpha>1) alpha=1;
    
    octx.lineWidth = lw;
    octx.strokeStyle = `rgba(${color[0]|0},${color[1]|0},${color[2]|0},${alpha})`;
    octx.shadowColor = octx.strokeStyle;
    octx.shadowBlur = 8 + energy*10 + flare*20;
    
    let points = [];
    let segments = 60;
    for(let j=0; j<=segments; j++){
      let a = (j/segments)*Math.PI*2;
      let offset1 = Math.sin(a*3 + orbT*(0.8+i*0.15)) * (5 + energy*12 + flare*20);
      let offset2 = Math.cos(a*5 - orbT*1.2 + i) * (3 + energy*8);
      let offset3 = Math.sin(a*2 + orbT*0.7 - i*1.5) * (4 + energy*10);
      
      let r = R + offset1 + offset2 + offset3 + (i*2);
      let x = cx + Math.cos(a)*r;
      let y = cx + Math.sin(a)*r;
      points.push({x,y});
    }
    
    octx.moveTo(points[0].x, points[0].y);
    for(let j=1; j<points.length-2; j++){
      let xc = (points[j].x + points[j+1].x) / 2;
      let yc = (points[j].y + points[j+1].y) / 2;
      octx.quadraticCurveTo(points[j].x, points[j].y, xc, yc);
    }
    octx.quadraticCurveTo(points[points.length-2].x, points[points.length-2].y, points[points.length-1].x, points[points.length-1].y);
    octx.stroke();
  }

  octx.globalCompositeOperation='lighter';
  let coreR = R * 0.7 + energy*10 + flare*15;
  const core = octx.createRadialGradient(cx,cx,0,cx,cx,coreR*1.2);
  core.addColorStop(0, `rgba(255,255,255,${0.25 + energy*0.3 + flare*0.5})`);
  core.addColorStop(0.4, `rgba(${curPal[0][0]|0},${curPal[0][1]|0},${curPal[0][2]|0},${0.3 + energy*0.3 + flare*0.4})`);
  core.addColorStop(1, 'rgba(0,0,0,0)');
  octx.fillStyle = core;
  octx.beginPath(); octx.arc(cx,cx,coreR*1.2,0,7); octx.fill();

  requestAnimationFrame(drawOrb);
}
drawOrb();"""

app_js = re.sub(old_orb, new_orb, app_js, flags=re.DOTALL)

with open('app.js', 'w') as f:
    f.write(app_js)
