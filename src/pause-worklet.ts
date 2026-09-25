import { AudioPauseDetector } from '../shared/audio-pause';
import type { AudioIdentity } from '../shared/protocol';

declare const sampleRate: number;
declare class AudioWorkletProcessor { readonly port: MessagePort }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class AssistantPauseProcessor extends AudioWorkletProcessor {
  private detector?: AudioPauseDetector;
  private identity?: AudioIdentity;
  private sequence = 0;
  constructor() {
    super();
    this.port.onmessage = ({ data }: MessageEvent<{ identity?: AudioIdentity; pauseMs: number }>) => {
      this.identity = data.identity;
      this.sequence = 0;
      this.detector = data.identity ? new AudioPauseDetector(sampleRate, data.pauseMs) : undefined;
    };
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    for (const output of outputs) for (const channel of output) channel.fill(0);
    if (this.detector && this.identity && inputs[0]?.[0]) {
      for (const sampleOffsetMs of this.detector.push(inputs[0][0]))
        this.port.postMessage({ ...this.identity, sequence: ++this.sequence, sampleOffsetMs });
    }
    return true;
  }
}
registerProcessor('relay-assistant-pauses', AssistantPauseProcessor);
export {};
