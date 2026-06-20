import React, { useEffect, useRef } from 'react';

export interface LolaOrbProps {
  mode?: 'alive' | 'alert' | 'insight';
  className?: string;
  width?: number;
  height?: number;
  onTap?: () => void;
}

export const LolaOrb: React.FC<LolaOrbProps> = ({
  mode = 'alive',
  className = '',
  width = 360,
  height = 360,
  onTap
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const x = cv.getContext('2d');
    if (!x) return;

    let t = 0;
    let energy = 0;
    let energyTarget = 0;
    let flare = 0;
    let currentMode = mode;
    let animationId: number;

    // 3 electron orbits (ellipses at different tilts)
    const orbits = [
      { rx: 130, ry: 54, rot: 0, sp: 1.4, e: [0, Math.PI] },
      { rx: 130, ry: 54, rot: Math.PI / 3, sp: -1.1, e: [Math.PI / 2] },
      { rx: 130, ry: 54, rot: -Math.PI / 3, sp: 1.7, e: [Math.PI * 1.3] }
    ];

    const getCol = (a: number, m: string) => {
      if (m === 'alert') return `rgba(255, 176, 32, ${a})`;     // Gold flare
      if (m === 'insight') return `rgba(166, 75, 255, ${a})`;   // Violet pulse
      return `rgba(255, 45, 142, ${a})`;                         // Pink alive
    };

    // Mode-based changes
    if (mode === 'alert') {
      flare = 1.0;
      energyTarget = 0.6;
    } else if (mode === 'insight') {
      energyTarget = 0.4;
    } else {
      energyTarget = 0;
    }

    const draw = () => {
      t += 0.016;
      energy += (energyTarget - energy) * 0.08;
      flare *= 0.94;
      
      x.clearRect(0, 0, 720, 720);
      const cx = 360;
      const cy = 360;
      const pulse = 1 + Math.sin(t * 2) * 0.04 + energy * 0.2 + flare * 0.4;

      // Outer radial glow
      const gl = x.createRadialGradient(cx, cy, 20, cx, cy, 260 * pulse);
      gl.addColorStop(0, getCol(0.18 + flare * 0.4, currentMode));
      gl.addColorStop(1, getCol(0, currentMode));
      x.fillStyle = gl;
      x.beginPath();
      x.arc(cx, cy, 260 * pulse, 0, Math.PI * 2);
      x.fill();

      // Draw Orbit rings & electrons
      for (const o of orbits) {
        x.save();
        x.translate(cx, cy);
        x.rotate(o.rot + t * 0.05);
        x.strokeStyle = getCol(0.12, currentMode);
        x.lineWidth = 1;
        x.beginPath();
        x.ellipse(0, 0, o.rx * pulse, o.ry * pulse, 0, 0, Math.PI * 2);
        x.stroke();

        // Draw electrons
        for (const e0 of o.e) {
          const a = e0 + t * o.sp;
          const ex = Math.cos(a) * o.rx * pulse;
          const ey = Math.sin(a) * o.ry * pulse;
          const eg = x.createRadialGradient(ex, ey, 0, ex, ey, 12);
          eg.addColorStop(0, getCol(0.9, currentMode));
          eg.addColorStop(1, getCol(0, currentMode));
          x.fillStyle = eg;
          x.beginPath();
          x.arc(ex, ey, 12, 0, Math.PI * 2);
          x.fill();

          x.fillStyle = getCol(1, currentMode);
          x.beginPath();
          x.arc(ex, ey, 3, 0, Math.PI * 2);
          x.fill();
        }
        x.restore();
      }

      // Draw Nucleus
      const nr = (34 + Math.sin(t * 3) * 4) * pulse;
      const nuc = x.createRadialGradient(cx - 8, cy - 8, 2, cx, cy, nr);
      nuc.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
      nuc.addColorStop(0.4, getCol(0.95, currentMode));
      nuc.addColorStop(1, getCol(0.2, currentMode));
      x.fillStyle = nuc;
      x.beginPath();
      x.arc(cx, cy, nr, 0, Math.PI * 2);
      x.fill();

      animationId = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      cancelAnimationFrame(animationId);
    };
  }, [mode]);

  return (
    <canvas
      ref={canvasRef}
      width={720}
      height={720}
      className={className}
      style={{
        width: `${width}px`,
        height: `${height}px`,
        cursor: onTap ? 'pointer' : 'default',
        display: 'block'
      }}
      onClick={onTap}
    />
  );
};
