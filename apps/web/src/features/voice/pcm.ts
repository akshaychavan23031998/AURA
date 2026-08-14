const OUTPUT_RATE = 16_000;
const FRAME_SAMPLES = 320;

export function floatToPcm16(samples: Float32Array): ArrayBuffer {
  const output = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    output[index] =
      sample < 0 ? Math.round(sample * 32_768) : Math.round(sample * 32_767);
  }
  return output.buffer;
}

export function resampleMono(
  input: Float32Array,
  inputRate: number,
  outputLength: number,
): Float32Array {
  if (
    !Number.isFinite(inputRate) ||
    inputRate < OUTPUT_RATE ||
    outputLength <= 0
  )
    throw new Error("Unsupported microphone sample rate");
  const output = new Float32Array(outputLength);
  const ratio = inputRate / OUTPUT_RATE;
  for (let index = 0; index < output.length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const fraction = position - left;
    output[index] =
      (input[left] ?? 0) * (1 - fraction) + (input[right] ?? 0) * fraction;
  }
  return output;
}

export class PcmFrameEncoder {
  private pending = new Float32Array(0);
  private readonly inputSamplesPerFrame: number;
  public constructor(private readonly inputRate: number) {
    if (inputRate < OUTPUT_RATE)
      throw new Error("Microphone sample rate must be at least 16 kHz");
    this.inputSamplesPerFrame = Math.round(
      (inputRate / OUTPUT_RATE) * FRAME_SAMPLES,
    );
  }
  public push(samples: Float32Array): ArrayBuffer[] {
    const joined = new Float32Array(this.pending.length + samples.length);
    joined.set(this.pending);
    joined.set(samples, this.pending.length);
    const frames: ArrayBuffer[] = [];
    let offset = 0;
    while (joined.length - offset >= this.inputSamplesPerFrame) {
      const inputFrame = joined.slice(
        offset,
        offset + this.inputSamplesPerFrame,
      );
      frames.push(
        floatToPcm16(resampleMono(inputFrame, this.inputRate, FRAME_SAMPLES)),
      );
      offset += this.inputSamplesPerFrame;
    }
    this.pending = joined.slice(offset);
    return frames;
  }
  public reset(): void {
    this.pending = new Float32Array(0);
  }
}
