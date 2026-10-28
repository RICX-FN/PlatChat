import { EventEmitter } from 'events';
import { LiveChat } from 'youtube-chat';
import { UnifiedChatMessage, PlatformStatus, ConnectionStatus } from '../../types/chat.js';

export class YouTubePublicChatService extends EventEmitter {
  private currentIdentifier: string | null = null;
  private currentLiveId: string | null = null;
  private status: ConnectionStatus = 'disconnected';
  private liveChat: any = null;
  private lastErrorMessage: string | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private isIntentionalDisconnect = false;
  private reconnectAttempts = 0;
  private connectionGeneration = 0;
  private readonly maxReconnectAttempts = 6;
  private lastHttpStatus: number | null = null;
  private retryAfterMs = 0;

  constructor() {
    super();
  }

  public getStatus(): PlatformStatus {
    return {
      platform: 'youtube',
      status: this.status,
      channel: this.currentIdentifier || undefined,
      liveTitle: this.currentLiveId ? `Live ID: ${this.currentLiveId}` : undefined,
      hasActiveLive: this.status === 'connected',
      error: this.lastErrorMessage || undefined
    };
  }

  private updateStatus(newStatus: ConnectionStatus, error?: string): void {
    this.status = newStatus;
    this.lastErrorMessage = error || null;
    this.emit('status', this.getStatus());
  }

  /**
   * Conecta ao chat público do YouTube sem login ou chaves de API.
   * Suporta:
   * - Handle: @LofiGirl ou LofiGirl
   * - Channel ID: UC...
   * - URL de Vídeo/Live: https://www.youtube.com/watch?v=... ou https://youtu.be/... ou https://www.youtube.com/live/...
   * - Live ID direto: 11 caracteres (ex: 0sfDth4lMLc)
   */
  public async joinChannel(input: string): Promise<boolean> {
    const parsed = this.parseInput(input);
    if (!parsed) {
      this.updateStatus('error', 'Identificador do YouTube inválido. Forneça @canal, ID do canal ou URL da live.');
      return false;
    }

    return this.connectToChannel(input, parsed, true);
  }

  private async connectToChannel(
    input: string,
    parsed: { liveId: string } | { channelId: string } | { handle: string },
    resetRetryState: boolean
  ): Promise<boolean> {
    this.leaveChannel();
    this.isIntentionalDisconnect = false;
    const generation = this.connectionGeneration;
    this.currentIdentifier = input.trim();
    if (resetRetryState) {
      this.reconnectAttempts = 0;
    }
    this.lastHttpStatus = null;
    this.retryAfterMs = 0;
    this.updateStatus('connecting');

    try {
      console.log(`[YouTubeChat] Conectando ao chat público do YouTube:`, parsed);

      const liveChatInstance = new LiveChat(parsed as any, 1200);
      this.liveChat = liveChatInstance;

      liveChatInstance.on('start', (liveId: string) => {
        if (generation !== this.connectionGeneration) return;
        console.log(`[YouTubeChat] Chat ao vivo iniciado com sucesso! Live ID: ${liveId}`);
        this.currentLiveId = liveId;
        this.reconnectAttempts = 0;
        this.updateStatus('connected');
      });

      liveChatInstance.on('chat', (chatItem: any) => {
        if (generation !== this.connectionGeneration) return;
        const unified = this.mapToUnified(chatItem);
        if (unified) {
          this.emit('message', unified);
        }
      });

      liveChatInstance.on('error', (err: any) => {
        if (generation !== this.connectionGeneration) return;
        const msg = err?.message || String(err);
        const code = typeof err?.code === 'string' ? ` (${err.code})` : '';
        const status = typeof err?.response?.status === 'number' ? err.response.status : null;
        this.lastHttpStatus = status;
        this.retryAfterMs = this.getRetryAfterMs(err?.response?.headers?.['retry-after']);
        const responseStatus = status ? ` [HTTP ${status}]` : '';
        console.warn(`[YouTubeChat] Erro no leitor de chat do YouTube${responseStatus}${code}: ${msg}`);
        if (!this.isIntentionalDisconnect && this.status !== 'connected') {
          this.updateStatus('error', msg);
          this.scheduleReconnect();
        }
      });

      liveChatInstance.on('end', (reason?: string) => {
        if (generation !== this.connectionGeneration) return;
        console.log(`[YouTubeChat] Chat finalizado: ${reason || 'Fim da transmissão'}`);
        if (!this.isIntentionalDisconnect) {
          this.updateStatus('disconnected', reason || 'Transmissão finalizada');
          this.scheduleReconnect();
        }
      });

      const ok = await liveChatInstance.start();
      if (generation !== this.connectionGeneration) {
        liveChatInstance.removeAllListeners();
        liveChatInstance.stop();
        return false;
      }
      if (!ok) {
        if (this.status !== 'error') {
          throw new Error('Não foi possível iniciar o chat. Verifique se o canal está ao vivo.');
        }
        return false;
      }

      return true;
    } catch (err: any) {
      if (generation !== this.connectionGeneration) return false;
      const msg = err?.message || String(err);
      console.warn(`[YouTubeChat] Falha ao iniciar monitoramento: ${msg}`);
      this.updateStatus('error', msg);
      this.scheduleReconnect();
      return false;
    }
  }

  public leaveChannel(): void {
    this.connectionGeneration++;
    this.isIntentionalDisconnect = true;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.liveChat) {
      try {
        this.liveChat.removeAllListeners();
        this.liveChat.stop();
      } catch (err: any) {
        console.warn(`[YouTubeChat] Erro ao parar leitor: ${err.message}`);
      }
      this.liveChat = null;
    }

    this.currentIdentifier = null;
    this.currentLiveId = null;
    this.updateStatus('disconnected');
  }

  private parseInput(input: string): { liveId: string } | { channelId: string } | { handle: string } | null {
    const raw = input.trim();
    if (!raw) return null;

    // 1. URL de vídeo / live
    const videoMatch = raw.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|live\/|embed\/))([a-zA-Z0-9_-]{11})/);
    if (videoMatch) {
      return { liveId: videoMatch[1] };
    }

    // 2. ID direto de 11 caracteres
    if (/^[a-zA-Z0-9_-]{11}$/.test(raw) && !raw.startsWith('@') && !raw.startsWith('UC')) {
      return { liveId: raw };
    }

    // 3. URL de canal com UC...
    const channelMatch = raw.match(/youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{22})/);
    if (channelMatch) {
      return { channelId: channelMatch[1] };
    }

    // 4. ID de canal direto UC...
    if (/^UC[a-zA-Z0-9_-]{22}$/.test(raw)) {
      return { channelId: raw };
    }

    // 5. URL de handle @...
    const handleMatch = raw.match(/youtube\.com\/@([a-zA-Z0-9_.-]+)/);
    if (handleMatch) {
      return { handle: `@${handleMatch[1]}` };
    }

    // 6. Handle direto (@nome ou nome)
    if (raw.startsWith('@')) {
      return { handle: raw };
    }

    return { handle: `@${raw}` };
  }

  private mapToUnified(item: any): UnifiedChatMessage | null {
    if (!item || !item.message) return null;

    let textContent = '';
    if (Array.isArray(item.message)) {
      textContent = item.message.map((m: any) => {
        if (typeof m === 'string') return m;
        if (m && 'text' in m) return m.text;
        if (m && 'emojiText' in m) return m.emojiText;
        return '';
      }).join('');
    } else if (typeof item.message === 'string') {
      textContent = item.message;
    }

    if (item.superchat) {
      const superAmount = item.superchat.amount ? `[SuperChat ${item.superchat.amount}] ` : '[SuperChat] ';
      textContent = superAmount + textContent;
    }

    const badges: string[] = [];
    if (item.isOwner) badges.push('broadcaster');
    if (item.isModerator) badges.push('moderator');
    if (item.isMembership) badges.push('member');
    if (item.isVerified) badges.push('verified');
    if (item.superchat) badges.push('superchat');

    const timestamp = item.timestamp ? new Date(item.timestamp).getTime() : Date.now();

    return {
      id: item.id || `yt-${timestamp}-${Math.random().toString(36).substring(2, 7)}`,
      platform: 'youtube',
      username: item.author?.name || 'YouTube Viewer',
      avatar: item.author?.thumbnail?.url || undefined,
      message: textContent,
      timestamp,
      color: item.superchat?.color || '#ff3333',
      badges: badges.length > 0 ? badges : undefined
    };
  }

  private scheduleReconnect(): void {
    if (this.isIntentionalDisconnect || !this.currentIdentifier) return;

    const isRateLimited = this.lastHttpStatus === 429;
    if (!isRateLimited && this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.warn(`[YouTubeChat] Limite de tentativas de reconexão atingido para ${this.currentIdentifier}`);
      return;
    }

    this.reconnectAttempts++;
    const delay = isRateLimited
      ? Math.max(this.retryAfterMs, Math.min(60_000 * 2 ** (this.reconnectAttempts - 1), 30 * 60_000))
      : Math.min(3000 * Math.pow(1.5, this.reconnectAttempts), 30000);
    console.log(`[YouTubeChat] Tentativa de reconexão #${this.reconnectAttempts} em ${Math.round(delay / 1000)}s...`);

    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = setTimeout(() => {
      if (this.currentIdentifier && !this.isIntentionalDisconnect) {
        const identifier = this.currentIdentifier;
        const parsed = this.parseInput(identifier);
        if (parsed) void this.connectToChannel(identifier, parsed, false);
      }
    }, delay);
  }

  private getRetryAfterMs(value: unknown): number {
    if (typeof value !== 'string' && typeof value !== 'number') return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    if (typeof value === 'string') {
      const timestamp = Date.parse(value);
      if (Number.isFinite(timestamp)) return Math.max(0, timestamp - Date.now());
    }
    return 0;
  }
}
