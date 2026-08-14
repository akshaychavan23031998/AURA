import { PcmFrameEncoder } from "./pcm";

export class MicrophoneError extends Error {
  public constructor(
    public readonly code:
      "permission-denied" | "not-found" | "unsupported" | "capture-failed",
  ) {
    super(code);
  }
}

export class MicrophoneCapture {
  private stream?: MediaStream;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private worklet?: AudioWorkletNode;
  public async start(onFrame: (frame: ArrayBuffer) => void): Promise<void> {
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof AudioWorkletNode === "undefined"
    )
      throw new MicrophoneError("unsupported");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      this.context = new AudioContext();
      await this.context.audioWorklet.addModule(
        "/audio/pcm-capture-processor.js",
      );
      const encoder = new PcmFrameEncoder(this.context.sampleRate);
      this.source = this.context.createMediaStreamSource(this.stream);
      this.worklet = new AudioWorkletNode(this.context, "aura-pcm-capture");
      this.worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
        for (const frame of encoder.push(event.data)) onFrame(frame);
      };
      this.source.connect(this.worklet);
      this.worklet.connect(this.context.destination);
    } catch (error) {
      await this.stop();
      if (error instanceof DOMException && error.name === "NotAllowedError")
        throw new MicrophoneError("permission-denied");
      if (error instanceof DOMException && error.name === "NotFoundError")
        throw new MicrophoneError("not-found");
      if (error instanceof MicrophoneError) throw error;
      throw new MicrophoneError("capture-failed");
    }
  }
  public async stop(): Promise<void> {
    this.worklet?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.context !== undefined && this.context.state !== "closed")
      await this.context.close();
    this.worklet = undefined;
    this.source = undefined;
    this.stream = undefined;
    this.context = undefined;
  }
}
