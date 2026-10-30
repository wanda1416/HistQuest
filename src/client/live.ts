import type { RoomCommand, RoomSnapshot } from '../shared/room.ts';
import { api, roomSocketUrl } from './net.ts';

/**
 * 房间实时通道。
 *
 * 主通道是 WebSocket（服务端 Durable Object + Hibernation）；
 * 大陆网络下 WS 偶尔会被中间设备掐掉，所以这里内建**降级轮询**：
 * WS 连续失败两次就切到 1.5s 轮询（上行改走 POST /cmd），同时后台继续试 WS，
 * 连上后自动切回推送。
 *
 * 心跳：WS 上每 10s 发一个 {t:'ping'}。它同时是服务端判定"在线"的依据——
 * 结束投票的分母就是按在线人数算的，所以断线必须被尽快发现。
 */

export interface RoomLiveHandlers {
  onSnapshot: (snapshot: RoomSnapshot) => void;
  onError: (code: string, message: string) => void;
  onChannel: (channel: 'connecting' | 'ws' | 'polling' | 'off') => void;
}

const HEARTBEAT_MS = 10_000;
const POLL_MS = 1_500;
const RECONNECT_STEPS = [1000, 2000, 4000, 8000, 15000];

export class RoomLive {
  readonly code: string;
  private readonly handlers: RoomLiveHandlers;
  private ws: WebSocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private closed = false;
  /** 上一次快照的状态，用于判断"要不要切屏" */
  private lastStatus: string | null = null;

  constructor(code: string, handlers: RoomLiveHandlers) {
    this.code = code;
    this.handlers = handlers;
  }

  start(): void {
    this.closed = false;
    this.openSocket();
  }

  stop(): void {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.poller) clearInterval(this.poller);
    if (this.retry) clearTimeout(this.retry);
    this.heartbeat = null;
    this.poller = null;
    this.retry = null;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.handlers.onChannel('off');
  }

  /** 上行命令：WS 通就走 WS，否则走 REST（服务端两条路是同一个 dispatch） */
  send(cmd: RoomCommand): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(cmd));
      return;
    }
    void api
      .roomCmd(this.code, cmd)
      .then((snapshot) => this.emit(snapshot))
      .catch((err) => this.handlers.onError('OFFLINE', err?.message ?? '命令没有发出去'));
  }

  /* ---------------- WS ---------------- */

  private openSocket(): void {
    if (this.closed) return;
    this.handlers.onChannel(this.poller ? 'polling' : 'connecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(roomSocketUrl(this.code));
    } catch {
      this.degrade();
      return;
    }
    this.ws = socket;

    socket.onopen = () => {
      this.failures = 0;
      this.stopPolling();
      this.handlers.onChannel('ws');
      this.startHeartbeat();
      // 连上后立刻补一次快照：断线期间可能错过了别人的回合
      void this.pullOnce();
    };

    socket.onmessage = (event) => {
      let msg: { t?: string; room?: RoomSnapshot; code?: string; message?: string };
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;
      }
      if (msg.t === 'snapshot' && msg.room) this.emit(msg.room);
      if (msg.t === 'error') this.handlers.onError(String(msg.code ?? 'ERROR'), String(msg.message ?? '操作失败'));
      if (msg.t === 'closed') {
        this.handlers.onError('ROOM_CLOSED', '房间已经关闭');
        this.stop();
      }
    };

    socket.onclose = () => {
      this.ws = null;
      this.stopHeartbeat();
      if (this.closed) return;
      this.failures += 1;
      if (this.failures >= 2) this.degrade();
      else this.scheduleReconnect();
    };

    socket.onerror = () => {
      /* 交给 onclose 处理：浏览器在失败时总会触发 close */
    };
  }

  private scheduleReconnect(): void {
    if (this.closed || this.retry) return;
    const wait = RECONNECT_STEPS[Math.min(this.failures, RECONNECT_STEPS.length - 1)] ?? 15000;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.openSocket();
    }, wait);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ t: 'ping' }));
      }
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /* ---------------- 降级轮询 ---------------- */

  private degrade(): void {
    if (this.closed) return;
    this.handlers.onChannel('polling');
    if (!this.poller) {
      this.poller = setInterval(() => void this.pullOnce(), POLL_MS);
      void this.pullOnce();
    }
    // 轮询期间仍然隔一会儿重试 WS：连上就自动切回推送
    if (!this.retry) {
      this.retry = setTimeout(() => {
        this.retry = null;
        this.openSocket();
      }, 15000);
    }
  }

  private stopPolling(): void {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
  }

  private async pullOnce(): Promise<void> {
    try {
      const snapshot = await api.roomSnapshot(this.code);
      this.emit(snapshot);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e?.code === 'NOT_FOUND' || e?.code === 'ROOM_CLOSED') this.handlers.onError('ROOM_CLOSED', '房间不存在或已经关闭');
    }
  }

  private emit(snapshot: RoomSnapshot): void {
    this.lastStatus = snapshot.status;
    this.handlers.onSnapshot(snapshot);
  }

  get status(): string | null {
    return this.lastStatus;
  }
}
