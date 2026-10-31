import { api, ApiError } from './net.ts';

/**
 * 语音输入：🎤 按住说话 → 松手 → 文字填进输入框。
 *
 * 两档实现（自动选择，运行时不再切换）：
 *   1. Web Speech API（Chromium 系）：原生流式，边说边出中间结果；
 *      但识别在 Google 服务器上，大陆网络常不可用——失败即永久落到档 2
 *   2. MediaRecorder 录音 → POST /api/ai/transcribe（OpenAI 兼容
 *      /audio/transcriptions，服务端透传）：大陆可达，一句话延迟 1–3s
 *
 * 语音只是**输入法**：识别出的文字必须落回输入框（玩家可改可删），
 * 由玩家点「提问」走现有 ask 全流程——ASR 出错要能改，破甲审查记最终文本。
 */

export type VoiceState = 'idle' | 'listening' | 'transcribing' | 'error';

export interface VoiceHandlers {
  /** 状态变化（用于按钮样式：idle / 录音中（含中间文字）/ 识别中 / 出错） */
  onState: (state: VoiceState, interim?: string) => void;
  /** 最终文字（可能为空串 = 没听清） */
  onText: (text: string) => void;
  /** 错误提示（已是人话，直接进 notice） */
  onError: (message: string) => void;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}

export class VoiceInput {
  private readonly handlers: VoiceHandlers;
  private mode: 'auto' | 'webspeech' | 'recorder' = 'auto';
  private state: VoiceState = 'idle';
  private rec: SpeechRecognitionLike | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;
  /** 松手后是否有最终结果在途（Web Speech 的 onend 在 onresult 之后到） */
  private pendingWebSpeech = false;

  constructor(handlers: VoiceHandlers) {
    this.handlers = handlers;
  }

  get available(): boolean {
    return Boolean(this.pickWebSpeech()) || typeof MediaRecorder !== 'undefined';
  }

  /** 🎤 按下：开始听 */
  start(): void {
    if (this.state === 'listening' || this.state === 'transcribing') return;
    this.chunks = [];
    this.pendingWebSpeech = false;

    const useWebSpeech = this.mode !== 'recorder' && this.pickWebSpeech() !== null;
    if (useWebSpeech) {
      this.startWebSpeech();
      return;
    }
    void this.startRecorder();
  }

  /** 🎤 松开：结束并出文字 */
  stop(): void {
    if (this.state === 'transcribing') return;
    if (this.rec) {
      // Web Speech：最终结果可能随 stop 到达，onend 里决定是否已足够
      this.rec.stop();
      return;
    }
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.stop();
      return;
    }
    this.setIdle();
  }

  /** 界面销毁时调用：释放麦克风 */
  dispose(): void {
    this.rec?.abort();
    this.rec = null;
    if (this.recorder && this.recorder.state !== 'inactive') {
      // MediaRecorder 没有 abort()，stop() 即可（onstop 里的空 blob 会走 idle）
      this.recorder.stop();
    }
    this.recorder = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.setIdle();
  }

  /* ---------------- Web Speech（Chromium） ---------------- */

  private pickWebSpeech(): (new () => SpeechRecognitionLike) | null {
    const w = window as unknown as Record<string, unknown>;
    const ctor = (w.SpeechRecognition ?? w.webkitSpeechRecognition) as
      | (new () => SpeechRecognitionLike)
      | undefined;
    return ctor ?? null;
  }

  private startWebSpeech(): void {
    const Ctor = this.pickWebSpeech();
    if (!Ctor) {
      void this.startRecorder();
      return;
    }
    const rec = new Ctor();
    rec.lang = 'zh-CN';
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]!;
        const text = r[0]?.transcript ?? '';
        if (r.isFinal) {
          const trimmed = text.trim();
          if (trimmed) {
            this.pendingWebSpeech = true;
            this.deliver(trimmed);
            return;
          }
        } else {
          interim += text;
        }
      }
      if (interim) this.setState('listening', interim);
    };

    rec.onerror = (e) => {
      // not-allowed=没给麦克风权限；network=Google 服务不可达（大陆常见）；
      // no-speech=没说话。network 时永久切到录音档
      if (e.error === 'network') this.mode = 'recorder';
      if (e.error !== 'no-speech' && e.error !== 'aborted') {
        this.rec = null;
        if (this.mode === 'recorder') {
          void this.startRecorder();
        } else {
          this.setError(e.error === 'not-allowed' ? '麦克风权限被拒绝' : '识别服务不可用');
        }
        return;
      }
      this.rec = null;
      this.setIdle();
    };

    rec.onend = () => {
      const had = this.rec;
      this.rec = null;
      if (this.pendingWebSpeech) return; // 已出字，deliver 里收尾了
      if (!had) return;
      // 停止但没有任何最终结果：按没听清处理
      this.deliver('');
    };

    this.rec = rec;
    try {
      rec.start();
      this.setState('listening');
    } catch {
      this.rec = null;
      void this.startRecorder();
    }
  }

  /* ---------------- MediaRecorder → /api/ai/transcribe ---------------- */

  private async startRecorder(): Promise<void> {
    if (typeof MediaRecorder === 'undefined') {
      this.setError('这个浏览器不支持语音输入');
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      this.setError('拿不到麦克风（检查浏览器权限）');
      return;
    }

    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/mp4')
          ? 'audio/mp4'
          : '';
    let recorder: MediaRecorder;
    try {
      recorder = mime ? new MediaRecorder(this.stream, { mimeType: mime }) : new MediaRecorder(this.stream);
    } catch {
      this.releaseMic();
      this.setError('这个浏览器不支持录音');
      return;
    }

    this.recorder = recorder;
    this.chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    recorder.onstop = () => {
      this.releaseMic();
      const blob = new Blob(this.chunks, { type: recorder.mimeType || 'audio/webm' });
      this.recorder = null;
      if (blob.size === 0) {
        this.setIdle();
        return;
      }
      void this.transcribe(blob);
    };
    // timeslice 不需要：一句话的量级，一次性拿完整 blob
    recorder.start();
    this.setState('listening');
  }

  private async transcribe(blob: Blob): Promise<void> {
    this.setState('transcribing');
    const form = new FormData();
    const ext = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('ogg') ? 'ogg' : 'webm';
    form.append('audio', blob, `speech.${ext}`);
    try {
      const res = await api.transcribe(form);
      this.deliver(res.text);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : '识别失败，再试一次';
      // 限流不动状态机：错误提示后回 idle，玩家可以再按
      this.setError(message);
    }
  }

  /* ---------------- 公共小件 ---------------- */

  /** 交付文字：web speech 与录音两条路都汇到这里 */
  private deliver(text: string): void {
    this.setIdle();
    if (!text) {
      this.handlers.onError('没听清，再试一次');
      return;
    }
    this.handlers.onText(text);
  }

  private releaseMic(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  private setState(state: VoiceState, interim?: string): void {
    this.state = state;
    this.handlers.onState(state, interim);
  }

  private setIdle(): void {
    this.setState('idle');
  }

  private setError(message: string): void {
    this.setIdle();
    this.handlers.onError(message);
  }
}

/**
 * 与视图层的小型绑定：把 🎤 按钮的按下/松开接到一个 VoiceInput 上。
 * 单人与对战各持一个实例（互不干扰），按钮 action 由视图层传入。
 */
export function attachVoice(
  root: HTMLElement,
  action: string,
  opts: { targetRole: string; voice: VoiceInput },
): { dispose(): void } {
  const press = (event: Event): void => {
    const el = (event.target as HTMLElement).closest<HTMLElement>(`[data-action="${action}"]`);
    if (!el) return;
    event.preventDefault();
    event.stopPropagation();
    opts.voice.start();
  };
  const release = (event: Event): void => {
    const el = (event.target as HTMLElement).closest(`[data-action="${action}"]`);
    if (!el) return;
    opts.voice.stop();
  };

  root.addEventListener('pointerdown', press);
  root.addEventListener('pointerup', release);
  root.addEventListener('pointerleave', release);
  root.addEventListener('pointercancel', release);

  return {
    dispose() {
      root.removeEventListener('pointerdown', press);
      root.removeEventListener('pointerup', release);
      root.removeEventListener('pointerleave', release);
      root.removeEventListener('pointercancel', release);
      opts.voice.dispose();
    },
  };
}
