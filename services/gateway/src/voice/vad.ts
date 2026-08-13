export interface VadConfig {
  readonly frameBytes: number;
  readonly threshold: number;
  readonly minSpeechMs: number;
  readonly endSilenceMs: number;
  readonly frameMs: number;
}
export type VadDecision =
  "silence" | "speech.started" | "speech" | "speech.ended";
export class EnergyVad {
  private speechMs = 0;
  private silenceMs = 0;
  private active = false;
  public constructor(private readonly config: VadConfig) {}
  public accept(frame: Buffer): VadDecision {
    if (frame.length !== this.config.frameBytes) return "silence";
    let energy = 0;
    for (let index = 0; index < frame.length; index += 2)
      energy += Math.abs(frame.readInt16LE(index));
    const speech = energy / (frame.length / 2) >= this.config.threshold;
    if (speech) {
      this.speechMs += this.config.frameMs;
      this.silenceMs = 0;
      if (!this.active && this.speechMs >= this.config.minSpeechMs) {
        this.active = true;
        return "speech.started";
      }
      return this.active ? "speech" : "silence";
    }
    if (this.active) {
      this.silenceMs += this.config.frameMs;
      if (this.silenceMs >= this.config.endSilenceMs) {
        this.reset();
        return "speech.ended";
      }
    }
    return "silence";
  }
  public reset(): void {
    this.speechMs = 0;
    this.silenceMs = 0;
    this.active = false;
  }
}
