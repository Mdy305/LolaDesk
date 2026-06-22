import re

with open('lola-atom.html', 'r') as f:
    html = f.read()

old_logic_regex = r"// ════════ THE LIVING ATOM ════════.*?function setState\(m,state,sub\)\{"
new_logic = """// ════════ THE LIVING ATOM: Siri Fluid Orb ════════
  const cv=document.getElementById('atom'), ax=cv.getContext('2d');
  const AC=360; // center of 720 canvas
  let t=0, energy=0, energyTarget=0, flare=0, mode='alive';

  const PAL={
    alive:   [ [255,45,142], [100,20,80], [30,10,30], [255,80,140] ],
    alert:   [ [255,176,32], [255,80,0], [150,40,0], [255,220,100] ],
    insight: [ [166,75,255], [100,20,200], [40,10,120], [220,150,255] ]
  };
  let curPal = PAL.alive.map(c=>[...c]);

  function draw(){
    t+=0.016; 
    energy+=(energyTarget-energy)*0.08; 
    flare*=0.94;
    
    const targetPal = PAL[mode]||PAL.alive;
    for(let i=0; i<4; i++){
      curPal[i][0] += (targetPal[i][0] - curPal[i][0])*0.04;
      curPal[i][1] += (targetPal[i][1] - curPal[i][1])*0.04;
      curPal[i][2] += (targetPal[i][2] - curPal[i][2])*0.04;
    }

    ax.clearRect(0,0,720,720);
    ax.globalCompositeOperation='screen';
    
    // Scale pulse for atom dashboard
    const pulse = 1 + Math.sin(t*2)*0.04 + energy*0.2 + flare*0.4;
    const R = 150 * pulse; 
    
    for(let i=0; i<12; i++){
      ax.beginPath();
      let colIdx = i % 4;
      let color = curPal[colIdx];
      
      let lw = 1.5 + (i%3)*1.0 + energy*2.5 + flare*3;
      let alpha = 0.5 + energy*0.4 + flare*0.5 - (i*0.03);
      if(alpha>1) alpha=1;
      
      ax.lineWidth = lw;
      ax.strokeStyle = `rgba(${color[0]|0},${color[1]|0},${color[2]|0},${alpha})`;
      ax.shadowColor = ax.strokeStyle;
      ax.shadowBlur = 12 + energy*15 + flare*25;
      
      let points = [];
      let segments = 100;
      for(let j=0; j<=segments; j++){
        let a = (j/segments)*Math.PI*2;
        let offset1 = Math.sin(a*3 + t*(0.8+i*0.15)) * (15 + energy*25 + flare*40);
        let offset2 = Math.cos(a*5 - t*1.2 + i) * (8 + energy*15);
        let offset3 = Math.sin(a*2 + t*0.7 - i*1.5) * (12 + energy*20);
        
        let r = R + offset1 + offset2 + offset3 + (i*3);
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
      ax.quadraticCurveTo(points[points.length-2].x, points[points.length-2].y, points[points.length-1].x, points[points.length-1].y);
      ax.stroke();
    }

    ax.globalCompositeOperation='lighter';
    let coreR = R * 0.7 + energy*20 + flare*30;
    const core = ax.createRadialGradient(AC,AC,0,AC,AC,coreR*1.2);
    core.addColorStop(0, `rgba(255,255,255,${0.25 + energy*0.3 + flare*0.5})`);
    core.addColorStop(0.4, `rgba(${curPal[0][0]|0},${curPal[0][1]|0},${curPal[0][2]|0},${0.3 + energy*0.3 + flare*0.4})`);
    core.addColorStop(1, 'rgba(0,0,0,0)');
    ax.fillStyle = core;
    ax.beginPath(); ax.arc(AC,AC,coreR*1.2,0,7); ax.fill();

    requestAnimationFrame(draw);
  }
  draw();

  function setState(m,state,sub){"""

html = re.sub(old_logic_regex, new_logic, html, flags=re.DOTALL)

with open('lola-atom.html', 'w') as f:
    f.write(html)
