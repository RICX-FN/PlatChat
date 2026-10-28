import { EventEmitter } from 'events';
import { WebcastPushConnection } from 'tiktok-live-connector/legacy';
import { UnifiedChatMessage, PlatformStatus, ConnectionStatus } from '../../types/chat.js';

export class TikTokLiveService extends EventEmitter {
  private currentUsername: string | null = null;
  private status: ConnectionStatus = 'disconnected';
  private connection: any = null;
  private lastErrorMessage: string | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private isIntentionalDisconnect = false;
  private reconnectAttempts = 0;
  private connectionGeneration = 0;
  private readonly maxReconnectAttempts = 5;

  constructor() {
    super();
  }

  public getStatus(): PlatformStatus {
    return {
      platform: 'tiktok',
      status: this.status,
      channel: this.currentUsername || undefined,
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
   * Conecta à live do TikTok pelo nome de usuário / @handle
   */
  public async joinChannel(inputUsername: string): Promise<boolean> {
    const username = this.normalizeUsername(inputUsername);
    if (!username) {
      this.updateStatus('error', 'Nome de usuário do TikTok inválido.');
      return false;
    }

    this.leaveChannel();
    this.isIntentionalDisconnect = false;
    const generation = this.connectionGeneration;
    this.currentUsername = username;
    this.reconnectAttempts = 0;
    this.updateStatus('connecting');

    try {
      console.log(`[TikTokLive] Conectando ao canal de @${username}...`);

      const tiktokConnection = new (WebcastPushConnection as any)(username, {
        processInitialData: true,
        enableExtendedGiftInfo: false
      });

      this.connection = tiktokConnection;

      tiktokConnection.on('connected', (state: any) => {
        if (generation !== this.connectionGeneration) return;
        console.log(`[TikTokLive] Conectado à live de @${username} (Room ID: ${state?.roomId || 'ok'})`);
        this.reconnectAttempts = 0;
        this.updateStatus('connected');
      });

      tiktokConnection.on('disconnected', () => {
        if (generation !== this.connectionGeneration) return;
        console.log(`[TikTokLive] Conexão com @${username} encerrada.`);
        if (!this.isIntentionalDisconnect) {
          this.updateStatus('disconnected', 'Conexão encerrada pelo TikTok');
          this.scheduleReconnect();
        }
      });

      tiktokConnection.on('streamEnd', () => {
        if (generation !== this.connectionGeneration) return;
        console.log(`[TikTokLive] A transmissão ao vivo de @${username} terminou.`);
        this.updateStatus('disconnected', 'Transmissão ao vivo encerrada');
      });

      tiktokConnection.on('error', (err: any) => {
        if (generation !== this.connectionGeneration) return;
        const errorMsg = err?.message || String(err);
        console.warn(`[TikTokLive] Erro na transmissão de @${username}: ${errorMsg}`);
        if (!this.isIntentionalDisconnect && this.status !== 'connected') {
          this.updateStatus('error', errorMsg);
        }
      });

      // Evento de comentários normais do chat
      tiktokConnection.on('chat', (data: any) => {
        if (generation !== this.connectionGeneration) return;
        const unified = this.mapChatToUnified(data);
        if (unified) {
          this.emit('message', unified);
        }
      });

      // Evento de presentes (Gifts) enviados durante a live
      tiktokConnection.on('gift', (data: any) => {
        if (generation !== this.connectionGeneration) return;
        // Notifica apenas término de combo ou presentes unitários
        if (data.giftType === 1 || data.repeatEnd === true || data.repeatEnd === 1) {
          const unified = this.mapGiftToUnified(data);
          if (unified) {
            this.emit('message', unified);
          }
        }
      });

      await tiktokConnection.connect();
      if (generation !== this.connectionGeneration) {
        tiktokConnection.removeAllListeners();
        await tiktokConnection.disconnect();
        return false;
      }
      return true;
    } catch (err: any) {
      if (generation !== this.connectionGeneration) return false;
      const errorMsg = err?.message || String(err);
      console.warn(`[TikTokLive] Falha ao conectar em @${username}: ${errorMsg}`);
      this.updateStatus('error', errorMsg);
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

    if (this.connection) {
      try {
        this.connection.removeAllListeners();
        this.connection.disconnect().catch(() => {});
      } catch (err: any) {
        console.warn(`[TikTokLive] Erro ao desconectar: ${err.message}`);
      }
      this.connection = null;
    }

    this.currentUsername = null;
    this.updateStatus('disconnected');
  }

  private normalizeUsername(input: string): string {
    return input
      .trim()
      .replace(/^https?:\/\/(?:www\.)?tiktok\.com\/@?/i, '')
      .replace(/^@/, '')
      .split('/')[0]
      .split('?')[0]
      .toLowerCase();
  }

  private mapChatToUnified(data: any): UnifiedChatMessage | null {
    if (!data || !data.comment) return null;

    const user = data.user || {};
    const username = user.nickname || user.uniqueId || 'TikTok Viewer';
    const avatar = user.profilePictureUrl || undefined;

    const badges: string[] = [];
    if (user.isModerator) badges.push('moderator');
    if (user.isSubscriber) badges.push('subscriber');

    const timestamp = Number(data.createTime) || Date.now();

    return {
      id: data.msgId || `tiktok-${timestamp}-${Math.random().toString(36).substring(2, 7)}`,
      platform: 'tiktok',
      username,
      avatar,
      message: data.comment,
      timestamp,
      color: '#00f2fe',
      badges: badges.length > 0 ? badges : undefined
    };
  }

  private mapGiftToUnified(data: any): UnifiedChatMessage | null {
    if (!data) return null;

    const user = data.user || {};
    const username = user.nickname || user.uniqueId || 'TikTok Viewer';
    const avatar = user.profilePictureUrl || undefined;
    const giftName = data.giftName || 'Presente';
    const repeatCount = data.repeatCount || 1;
    const diamonds = data.diamondCount ? ` (${data.diamondCount * repeatCount} 💎)` : '';

    const message = `🎁 Enviou [${giftName} x${repeatCount}]${diamonds}!`;
    const timestamp = Number(data.createTime) || Date.now();

    return {
      id: `tiktok-gift-${data.msgId || timestamp}-${Math.random().toString(36).substring(2, 7)}`,
      platform: 'tiktok',
      username,
      avatar,
      message,
      timestamp,
      color: '#fe2c55',
      badges: ['gift']
    };
  }

  private scheduleReconnect(): void {
    if (this.isIntentionalDisconnect || !this.currentUsername) return;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.warn(`[TikTokLive] Limite de tentativas de reconexão atingido para @${this.currentUsername}`);
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(3000 * Math.pow(1.5, this.reconnectAttempts), 30000);
    console.log(`[TikTokLive] Tentativa de reconexão #${this.reconnectAttempts} em ${Math.round(delay / 1000)}s...`);

    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = setTimeout(() => {
      if (this.currentUsername && !this.isIntentionalDisconnect) {
        this.joinChannel(this.currentUsername);
      }
    }, delay);
  }
}
