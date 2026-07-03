/**
 * lolaWakeTrigger.ts
 * Passive ambient wake-word recognizer for "Hey Lola" using the Web Speech API.
 */

export interface LolaWakeTriggerOptions {
  wakeWords?: string[];
  lang?: string;
  onWake: (transcript: string) => void;
  onError?: (error: string) => void;
  onStatusChange?: (listening: boolean) => void;
}

export class LolaWakeTrigger {
  private recognition: any = null;
  private wakeWords: string[];
  private lang: string;
  private onWake: (transcript: string) => void;
  private onError?: (error: string) => void;
  private onStatusChange?: (listening: boolean) => void;
  private isActive: boolean = false;

  constructor(options: LolaWakeTriggerOptions) {
    this.wakeWords = options.wakeWords || ['lola', 'hey lola', 'hi lola'];
    this.lang = options.lang || 'en-US';
    this.onWake = options.onWake;
    this.onError = options.onError;
    this.onStatusChange = options.onStatusChange;

    this.initSpeechRecognition();
  }

  private initSpeechRecognition() {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      if (this.onError) {
        this.onError('Web Speech API is not supported in this browser.');
      }
      return;
    }

    const r = new SpeechRecognition();
    r.continuous = true;
    r.interimResults = true;
    r.lang = this.lang;

    r.onresult = (e: any) => {
      if (!this.isActive) return;
      
      let transcript = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        transcript += e.results[i][0].transcript;
      }
      
      const lower = transcript.toLowerCase();
      
      // Match wake words with word boundary checking
      for (const word of this.wakeWords) {
        const wakeRe = new RegExp(`\\b${word}\\b`, 'i');
        const match = wakeRe.exec(lower);
        
        if (match) {
          this.isActive = false;
          try {
            r.stop();
          } catch {}
          
          this.onWake(transcript);
          return;
        }
      }
    };

    r.onerror = (e: any) => {
      if (e.error === 'no-speech') return; // ignore silence timeouts
      if (this.onError) {
        this.onError(`Speech recognition error: ${e.error}`);
      }
      this.isActive = false;
      if (this.onStatusChange) this.onStatusChange(false);
    };

    r.onend = () => {
      // Loop recognition if it ends unexpectedly while active
      if (this.isActive) {
        try {
          r.start();
        } catch {}
      } else {
        if (this.onStatusChange) this.onStatusChange(false);
      }
    };

    this.recognition = r;
  }

  /**
   * Starts listening passively for the wake words.
   */
  public start() {
    if (!this.recognition) {
      if (this.onError) this.onError('Speech Recognition not initialized.');
      return;
    }

    if (this.isActive) return;

    this.isActive = true;
    if (this.onStatusChange) this.onStatusChange(true);

    try {
      this.recognition.start();
    } catch (e: any) {
      console.warn('[LolaWakeTrigger] start failed:', e.message);
    }
  }

  /**
   * Stops the passive recognition.
   */
  public stop() {
    this.isActive = false;
    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch {}
    }
    if (this.onStatusChange) this.onStatusChange(false);
  }
}
