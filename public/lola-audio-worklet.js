/* LolaDesk — mic capture AudioWorklet.
   Down-samples float32 to PCM16 at the AudioContext sample rate and posts
   ~100 ms Int16Array chunks to the main thread for streaming to Telnyx.
   Telnyx expects raw little-endian PCM16 at 16 kHz. */
class LolaMicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.bufferSize = 1600; // 100 ms @ 16 kHz
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const channel = input[0];
    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i] || 0));
      this.buffer.push(s < 0 ? s * 0x8000 : s * 0x7fff);
    }
    while (this.buffer.length >= this.bufferSize) {
      const chunk = new Int16Array(this.buffer.splice(0, this.bufferSize));
      this.port.postMessage(chunk, [chunk.buffer]);
    }
    return true;
  }
}
registerProcessor('lola-mic-processor', LolaMicProcessor);