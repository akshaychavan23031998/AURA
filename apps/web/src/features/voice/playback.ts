export interface AudioElementLike {
  src: string;
  play(): Promise<void>;
  pause(): void;
  currentTime: number;
  onended: ((event: Event) => void) | null;
}
export interface PlaybackPlatform {
  createAudio(): AudioElementLike;
  createUrl(blob: Blob): string;
  revokeUrl(url: string): void;
}

export class VoicePlayback {
  private chunks: BlobPart[] = [];
  private activeTurnId: string | undefined;
  private audio: AudioElementLike | undefined;
  private url: string | undefined;
  public constructor(
    private readonly platform: PlaybackPlatform = browserPlaybackPlatform,
  ) {}
  public begin(turnId: string): void {
    this.stop();
    this.activeTurnId = turnId;
  }
  public append(chunk: ArrayBuffer): void {
    if (this.activeTurnId !== undefined) this.chunks.push(chunk);
  }
  public async complete(turnId: string): Promise<void> {
    if (turnId !== this.activeTurnId || this.chunks.length === 0) return;
    const url = this.platform.createUrl(
      new Blob(this.chunks, { type: "audio/wav" }),
    );
    const audio = this.platform.createAudio();
    this.url = url;
    this.audio = audio;
    audio.src = url;
    audio.onended = () => this.release();
    await audio.play();
  }
  public stop(turnId?: string): void {
    if (turnId !== undefined && turnId !== this.activeTurnId) return;
    this.audio?.pause();
    if (this.audio !== undefined) this.audio.currentTime = 0;
    this.release();
    this.chunks = [];
    this.activeTurnId = undefined;
  }
  private release(): void {
    if (this.url !== undefined) this.platform.revokeUrl(this.url);
    this.url = undefined;
    this.audio = undefined;
  }
}

const browserPlaybackPlatform: PlaybackPlatform = {
  createAudio: () => new Audio(),
  createUrl: (blob) => URL.createObjectURL(blob),
  revokeUrl: (url) => URL.revokeObjectURL(url),
};
