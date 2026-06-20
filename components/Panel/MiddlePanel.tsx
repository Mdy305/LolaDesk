import React from 'react';
import { LolaOrb } from '../LolaOrb';

export interface MiddlePanelProps {
  mode?: 'alive' | 'alert' | 'insight';
  stateText?: string;
  subText?: string;
  onAskClick?: () => void;
  onOrbTap?: () => void;
}

export const MiddlePanel: React.FC<MiddlePanelProps> = ({
  mode = 'alive',
  stateText = 'Lola is listening',
  subText = 'all systems live',
  onAskClick,
  onOrbTap
}) => {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      position: 'relative',
      gap: '16px',
      padding: '20px',
      minHeight: '400px'
    }}>
      {/* ATOM CONTAINER */}
      <div 
        onClick={onOrbTap}
        style={{
          position: 'relative',
          width: '360px',
          height: '360px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: onOrbTap ? 'pointer' : 'default'
        }}
        title="Tap or say Hey Lola"
      >
        <LolaOrb 
          mode={mode} 
          width={360} 
          height={360} 
          onTap={onOrbTap}
        />
        
        {/* CENTER LABELS (absolutely positioned inside container but pushed down) */}
        <div style={{
          position: 'absolute',
          bottom: '20px',
          left: '0',
          right: '0',
          textAlign: 'center',
          pointerEvents: 'none',
          zIndex: 2
        }}>
          <div style={{
            fontFamily: "'Cormorant Garamond', serif",
            fontStyle: 'italic',
            fontWeight: 300,
            fontSize: '23px',
            color: '#f4f4f7',
            textShadow: '0 2px 10px rgba(0,0,0,0.5)'
          }}>
            {stateText}
          </div>
          <div style={{
            fontSize: '12px',
            color: '#56565e',
            marginTop: '4px',
            letterSpacing: '0.02em',
            textTransform: 'uppercase'
          }}>
            {subText}
          </div>
        </div>
      </div>

      {/* ASK BUTTON */}
      <button 
        onClick={onAskClick}
        style={{
          marginTop: '18px',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '10px',
          padding: '12px 24px',
          borderRadius: '999px',
          backgroundColor: 'rgba(255, 45, 142, 0.1)',
          border: '0.5px solid rgba(255, 45, 142, 0.4)',
          color: '#ff6bb0',
          cursor: 'pointer',
          fontSize: '13px',
          letterSpacing: '0.03em',
          fontWeight: 500,
          transition: 'all 0.3s ease',
          outline: 'none',
          zIndex: 3
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = 'rgba(255, 45, 142, 0.18)';
          e.currentTarget.style.transform = 'translateY(-1px)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = 'rgba(255, 45, 142, 0.1)';
          e.currentTarget.style.transform = 'translateY(0)';
        }}
      >
        <svg 
          width="15" 
          height="15" 
          viewBox="0 0 24 24" 
          fill="none" 
          stroke="currentColor" 
          strokeWidth="2"
        >
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4"/>
        </svg>
        Ask Lola
      </button>
    </div>
  );
};
