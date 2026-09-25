declare const sampleRate: number;
declare class AudioWorkletProcessor { readonly port: MessagePort }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class PcmInputProcessor extends AudioWorkletProcessor {
  private bytes = new ArrayBuffer(960);
  private view = new DataView(this.bytes);
  private offset = 0;
  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    for (const output of outputs) for (const channel of output) channel.fill(0);
    if (sampleRate !== 24000) {
      this.port.postMessage({ error: 'Native audio requires a 24 kHz AudioContext.' });
      return false;
    }
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (const raw of input) {
      const sample = Math.max(-1, Math.min(1, raw));
      this.view.setInt16(this.offset, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
      this.offset += 2;
      if (this.offset === this.bytes.byteLength) {
        this.port.postMessage({ pcm: this.bytes }, [this.bytes]);
        this.bytes = new ArrayBuffer(960);
        this.view = new DataView(this.bytes);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('relay-pcm-input', PcmInputProcessor);
export {};
