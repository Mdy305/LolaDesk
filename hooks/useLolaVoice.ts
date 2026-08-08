import { useState, useRef, useCallback } from 'react';

export function useLolaVoice() {
  const [isActive, setIsActive] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  const stopVoice = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    setIsActive(false);
    setIsSpeaking(false);
  }, []);

  const startVoice = useCallback(async () => {
    try {
      const res = await fetch('/api/lola/session', { method: 'POST' });
      if (!res.ok) throw new Error('Failed to create voice session');
      const { wsUrl, token } = await res.json();

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = async () => {
        setIsActive(true);

        ws.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              authorization: `Bearer ${token}`,
            },
          })
        );

        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const ctx = new AudioContext({ sampleRate: 16000 });
        audioCtxRef.current = ctx;

        const source = ctx.createMediaStreamSource(stream);
        const processor = ctx.createScriptProcessor(2048, 1, 1);

        processor.onaudioprocess = (e) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const inputBuffer = e.inputBuffer.getChannelData(0);

          const pcm16 = new Int16Array(inputBuffer.length);
          for (let i = 0; i < inputBuffer.length; i++) {
            const s = Math.max(-1, Math.min(1, inputBuffer[i]));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }

          const base64Audio = btoa(String.fromCharCode(...new Uint8Array(pcm16.buffer)));

          ws.send(
            JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: base64Audio,
            })
          );
        };

        source.connect(processor);
        processor.connect(ctx.destination);
      };

      ws.onmessage = (event) => {
        const frame = JSON.parse(event.data);

        switch (frame.type) {
          case 'input_audio_buffer.speech_started':
            setIsSpeaking(false);
            break;
          case 'response.output_audio.delta':
            setIsSpeaking(true);
            break;
          case 'response.done':
            setIsSpeaking(false);
            break;
        }
      };

      ws.onclose = () => stopVoice();
      ws.onerror = () => stopVoice();
    } catch (err) {
      console.error('Lola Voice Connection Error:', err);
      stopVoice();
    }
  }, [stopVoice]);

  const toggleVoice = () => (isActive ? stopVoice() : startVoice());

  return { isActive, isSpeaking, toggleVoice };
}
