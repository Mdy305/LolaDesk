/* lola-mic-worklet.js — captures mic audio as 16kHz PCM16 chunks.
   Loaded by lola-telnyx-stt.js via AudioWorklet. Bundler-free. */
class LolaMicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = [];
    // 3200 samples = 200ms at 16kHz
    this.chunkSize = 3200;
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      this.chunk.push(s < 0 ? s * 32768 : s * 32767);
    }
    while (this.chunk.length >= this.chunkSize) {
      const buf = new Int16Array(this.chunk.splice(0, this.chunkSize));
      this.port.postMessage(buf, [buf.buffer]);
    }
    return true;
  }
}
registerProcessor('lola-mic', LolaMicProcessor);
