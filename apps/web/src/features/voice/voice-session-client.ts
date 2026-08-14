import { MicrophoneCapture, MicrophoneError } from "./microphone";
import { VoicePlayback } from "./playback";
import {
  parseVoiceEvent,
  transitionForEvent,
  VOICE_PROTOCOL,
  type VoiceServerEvent,
  type VoiceUiTransition,
} from "./protocol";

export interface VoiceSessionCallbacks {
  onTransition(transition: VoiceUiTransition): void;
  onEvent?(event: VoiceServerEvent): void;
  onSessionExpired?(): void;
}
export interface VoiceSessionDependencies {
  createSocket(url: string, protocols: string[]): WebSocket;
  microphone: MicrophoneCapture;
  playback: VoicePlayback;
}

export class VoiceSessionClient {
  private socket?: WebSocket;
  private active = false;
  private audioTurnId?: string;
  public constructor(
    private readonly url: string,
    private readonly accessToken: string,
    private readonly callbacks: VoiceSessionCallbacks,
    private readonly dependencies: VoiceSessionDependencies = browserDependencies,
  ) {
    if (
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(accessToken) ||
      accessToken.length > 4_096
    )
      throw new Error("A valid access token is required");
  }
  public async connect(locale?: string): Promise<void> {
    if (this.active) return;
    this.active = true;
    this.callbacks.onTransition({ status: "connecting" });
    try {
      await this.dependencies.microphone.start((frame) =>
        this.sendFrame(frame),
      );
      if (!this.active) return;
      const socket = this.dependencies.createSocket(this.url, [
        VOICE_PROTOCOL,
        `aura.jwt.${this.accessToken}`,
      ]);
      this.socket = socket;
      socket.binaryType = "arraybuffer";
      socket.onopen = () =>
        socket.send(
          JSON.stringify({
            protocol: VOICE_PROTOCOL,
            type: "session.start",
            ...(locale === undefined ? {} : { locale }),
          }),
        );
      socket.onmessage = (message) => {
        void this.receive(message.data);
      };
      socket.onerror = () =>
        this.fail("Unable to connect to the authenticated voice session.");
      socket.onclose = (event) => {
        void this.handleClose(event);
      };
    } catch (error) {
      await this.dependencies.microphone.stop();
      this.active = false;
      this.callbacks.onTransition({
        status: "error",
        error: microphoneMessage(error),
      });
    }
  }
  public async disconnect(): Promise<void> {
    if (!this.active && this.socket === undefined) return;
    this.active = false;
    this.dependencies.playback.stop();
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "session.close" }));
      this.socket.close(1000, "Client closed session");
    } else this.socket?.close();
    this.socket = undefined;
    await this.dependencies.microphone.stop();
    this.callbacks.onTransition({ status: "disconnected" });
  }
  private sendFrame(frame: ArrayBuffer): void {
    if (this.active && this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(frame);
  }
  private async receive(data: unknown): Promise<void> {
    if (!this.active) return;
    if (data instanceof ArrayBuffer) {
      this.dependencies.playback.append(data);
      return;
    }
    if (typeof data !== "string") return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(data);
    } catch {
      this.fail("Gateway sent an invalid voice event.");
      return;
    }
    const event = parseVoiceEvent(decoded);
    if (event === undefined) {
      this.fail("Gateway sent an invalid voice event.");
      return;
    }
    this.callbacks.onEvent?.(event);
    if (event.type === "audio.started" && event.turnId !== undefined) {
      this.audioTurnId = event.turnId;
      this.dependencies.playback.begin(event.turnId);
    }
    if (
      (event.type === "turn.interrupting" ||
        event.type === "turn.interrupted" ||
        event.type === "turn.superseded") &&
      event.turnId !== undefined
    ) {
      this.dependencies.playback.stop(event.turnId);
      if (this.audioTurnId === event.turnId) this.audioTurnId = undefined;
    }
    if (event.type === "audio.completed" && event.turnId !== undefined)
      await this.dependencies.playback.complete(event.turnId);
    this.callbacks.onTransition(transitionForEvent(event));
  }
  private fail(message: string): void {
    if (!this.active) return;
    this.callbacks.onTransition({ status: "error", error: message });
    this.socket?.close();
  }
  private async handleClose(event: CloseEvent): Promise<void> {
    if (!this.active) return;
    this.active = false;
    this.socket = undefined;
    this.dependencies.playback.stop();
    await this.dependencies.microphone.stop();
    if (event.code === 1008) this.callbacks.onSessionExpired?.();
    this.callbacks.onTransition(
      event.code === 1000
        ? { status: "disconnected" }
        : {
            status: "error",
            error:
              event.code === 1008
                ? "Your session expired. Sign in again."
                : "Voice connection closed. Reconnect manually when ready.",
          },
    );
  }
}

function microphoneMessage(error: unknown): string {
  if (error instanceof MicrophoneError) {
    if (error.code === "permission-denied")
      return "Microphone permission was denied. Allow access and try again.";
    if (error.code === "not-found") return "No microphone was found.";
    if (error.code === "unsupported")
      return "This browser does not support secure microphone capture.";
  }
  return "Microphone capture could not start.";
}

const browserDependencies: VoiceSessionDependencies = {
  createSocket: (url, protocols) => new WebSocket(url, protocols),
  microphone: new MicrophoneCapture(),
  playback: new VoicePlayback(),
};
