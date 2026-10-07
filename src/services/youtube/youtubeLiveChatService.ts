import { EventEmitter } from 'events';
import { UnifiedChatMessage, PlatformStatus, ConnectionStatus } from '../../types/chat.js';
import { YouTubeAuthService } from './youtubeAuthService.js';

interface YouTubeMessageItem {
  id: string;
  snippet: {
    publishedAt: string;
    displayMessage: string;
  };
  authorDetails: {
    displayName: string;
    profileImageUrl?: string;
    isChatOwner?: boolean;
    isChatModerator?: boolean;
    isChatSponsor?: boolean;
  };
}

interface YouTubeLiveChatResponse {
  nextPageToken?: string;
  pollingIntervalMillis?: number;
  offlineAt?: string;
  items?: YouTubeMessageItem[];
  error?: {
    code: number;
    message: string;
    errors?: Array<{ reason: string; message: string }>;
  };
}

export class YouTubeLiveChatService extends EventEmitter {
  private activeLiveChatId: string | null = null;
  private currentLiveTitle: string | null = null;
  private nextPageToken: string | null = null;
  private status: ConnectionStatus = 'disconnected';
  private pollingTimeout: NodeJS.Timeout | null = null;
  private isPolling = false;
  private seenMessageIds: Set<string> = new Set();
  private isFirstPoll = true;
  private lastErrorMessage: string | null = null;

  constructor(private authService: YouTubeAuthService) {
    super();

    // Quando o usuário fizer login pelo OAuth, detecta live ativa automaticamente
    this.authService.on('authenticated', () => {
      console.log('[YouTubeLiveChat] Nova autenticação detectada. Buscando live ativa...');
      this.detectAndJoinActiveLive();
    });

    // Quando o usuário deslogar
    this.authService.on('logout', () => {
      this.leaveLive();
    });

    // Se já havia sessão salva no disco ao iniciar o servidor
    if (this.authService.isAuthenticated()) {
      this.detectAndJoinActiveLive();
    }
  }

  public getStatus(): PlatformStatus {
    const profile = this.authService.getChannelProfile();
    const isAuthenticated = this.authService.isAuthenticated();

    return {
      platform: 'youtube',
      status: this.status,
      channel: profile?.channelTitle,
      channelAvatar: profile?.channelAvatar,
      liveTitle: this.currentLiveTitle || undefined,
      isAuthenticated,
      hasActiveLive: Boolean(this.activeLiveChatId),
      error: this.lastErrorMessage || undefined
    };
  }

  private updateStatus(newStatus: ConnectionStatus, error?: string): void {
    this.status = newStatus;
    this.lastErrorMessage = error || null;

    const payload = this.getStatus();
    this.emit('status', payload);
  }

  /**
   * Consulta a API do YouTube (/liveBroadcasts) para detectar automaticamente
   * a transmissão ao vivo ativa do canal autenticado e extrair o liveChatId.
   */
  public async detectAndJoinActiveLive(): Promise<boolean> {
    if (!this.authService.isAuthenticated()) {
      this.updateStatus('disconnected', 'Canal do YouTube não autenticado. Faça login com o Google.');
      return false;
    }

    this.stopPolling();
    this.seenMessageIds.clear();
    this.isFirstPoll = true;
    this.nextPageToken = null;
    this.activeLiveChatId = null;
    this.currentLiveTitle = null;

    this.updateStatus('connecting');

    try {
      const accessToken = await this.authService.getValidAccessToken();

      // 1. Tenta buscar transmissões com status 'active'
      let activeBroadcast = await this.fetchActiveBroadcast(accessToken);

      // 2. Se não encontrar em active, busca todas as recentes do canal (pode estar em teste/ready)
      if (!activeBroadcast) {
        activeBroadcast = await this.fetchRecentBroadcast(accessToken);
      }

      if (!activeBroadcast || !activeBroadcast.snippet?.liveChatId) {
        const profile = this.authService.getChannelProfile();
        const msg = `Autenticado como "${profile?.channelTitle || 'Canal'}", mas nenhuma live ativa com chat foi encontrada no momento.`;
        console.log(`[YouTubeLiveChat] ${msg}`);
        this.updateStatus('connected', msg);
        return false;
      }

      this.activeLiveChatId = activeBroadcast.snippet.liveChatId;
      this.currentLiveTitle = activeBroadcast.snippet.title || 'Transmissão ao Vivo';
      this.isPolling = true;

      console.log(`[YouTubeLiveChat] Live encontrada: "${this.currentLiveTitle}" (Chat ID: ${this.activeLiveChatId})`);
      this.updateStatus('connected');

      // Inicia polling de mensagens com respeito à cota
      this.pollMessages();
      return true;
    } catch (err: any) {
      console.error(`[YouTubeLiveChat] Erro ao detectar live ativa: ${err.message}`);
      this.updateStatus('error', err.message);
      return false;
    }
  }

  public leaveLive(): void {
    this.stopPolling();
    this.activeLiveChatId = null;
    this.currentLiveTitle = null;
    this.updateStatus('disconnected');
  }

  private stopPolling(): void {
    this.isPolling = false;
    if (this.pollingTimeout) {
      clearTimeout(this.pollingTimeout);
      this.pollingTimeout = null;
    }
  }

  private async fetchActiveBroadcast(accessToken: string): Promise<any | null> {
    const url = 'https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet,status&broadcastStatus=active&broadcastType=all&mine=true';
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = await res.json() as any;

    if (data.error) {
      throw new Error(`Erro na API do YouTube (${data.error.code}): ${data.error.message}`);
    }

    return data.items?.[0] || null;
  }

  private async fetchRecentBroadcast(accessToken: string): Promise<any | null> {
    const url = 'https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet,status&broadcastType=all&mine=true&maxResults=5';
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = await res.json() as any;

    if (data.error || !data.items || data.items.length === 0) {
      return null;
    }

    // Procura a transmissão mais recente que contenha liveChatId ativo
    for (const item of data.items) {
      const status = item.status?.lifeCycleStatus;
      if (item.snippet?.liveChatId && (status === 'live' || status === 'liveStarting' || status === 'testing' || status === 'ready')) {
        return item;
      }
    }

    return null;
  }

  /**
   * Executa polling contínuo respeitando pollingIntervalMillis e renovando token se necessário.
   */
  private async pollMessages(): Promise<void> {
    if (!this.isPolling || !this.activeLiveChatId) return;

    let nextDelayMs = 6000;

    try {
      const accessToken = await this.authService.getValidAccessToken();

      let url = `https://www.googleapis.com/youtube/v3/liveChatMessages?liveChatId=${encodeURIComponent(this.activeLiveChatId)}&part=id,snippet,authorDetails`;
      if (this.nextPageToken) {
        url += `&pageToken=${encodeURIComponent(this.nextPageToken)}`;
      }

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const data = (await res.json()) as YouTubeLiveChatResponse;

      if (data.error) {
        const errorReason = data.error.errors?.[0]?.reason || '';

        // Token expirou ou inválido
        if (data.error.code === 401) {
          console.warn('[YouTubeLiveChat] Token expirado durante polling. Tentando renovação...');
          await this.authService.getValidAccessToken();
          nextDelayMs = 2000;
          this.scheduleNextPoll(nextDelayMs);
          return;
        }

        // Cota excedida
        if (data.error.code === 403 && (errorReason === 'quotaExceeded' || errorReason === 'rateLimitExceeded')) {
          const errMsg = 'Cota diária da API do YouTube excedida (403). O monitoramento do YouTube foi pausado.';
          console.error(`[YouTubeLiveChat] ${errMsg}`);
          this.updateStatus('error', errMsg);
          this.stopPolling();
          return;
        }

        // Chat encerrado ou não encontrado
        if (data.error.code === 404 || data.error.code === 400) {
          const errMsg = `Chat do YouTube finalizado ou indisponível: ${data.error.message}`;
          console.warn(`[YouTubeLiveChat] ${errMsg}`);
          this.updateStatus('connected', errMsg);
          this.stopPolling();
          return;
        }

        throw new Error(data.error.message);
      }

      // Atualiza token de paginação para próximas mensagens
      if (data.nextPageToken) {
        this.nextPageToken = data.nextPageToken;
      }

      // Respeita estritamente o intervalo de polling da resposta da API
      if (data.pollingIntervalMillis && data.pollingIntervalMillis > 0) {
        nextDelayMs = Math.max(data.pollingIntervalMillis, 4000);
      }

      if (data.items && data.items.length > 0) {
        const unifiedBatch: UnifiedChatMessage[] = [];

        for (const item of data.items) {
          if (this.seenMessageIds.has(item.id)) continue;
          this.seenMessageIds.add(item.id);

          if (this.seenMessageIds.size > 2000) {
            const firstItems = Array.from(this.seenMessageIds).slice(0, 500);
            for (const id of firstItems) this.seenMessageIds.delete(id);
          }

          const publishedTime = new Date(item.snippet.publishedAt).getTime();

          // Ignorar mensagens anteriores a 2 minutos na primeira leitura
          if (this.isFirstPoll && Date.now() - publishedTime > 120000) {
            continue;
          }

          const badges: string[] = [];
          if (item.authorDetails.isChatOwner) badges.push('broadcaster');
          if (item.authorDetails.isChatModerator) badges.push('moderator');
          if (item.authorDetails.isChatSponsor) badges.push('sponsor');

          unifiedBatch.push({
            id: item.id,
            platform: 'youtube',
            username: item.authorDetails.displayName,
            avatar: item.authorDetails.profileImageUrl,
            message: item.snippet.displayMessage,
            timestamp: publishedTime,
            badges: badges.length > 0 ? badges : undefined
          });
        }

        if (unifiedBatch.length > 0) {
          unifiedBatch.sort((a, b) => a.timestamp - b.timestamp);
          this.emit('batch', unifiedBatch);
        }
      }

      this.isFirstPoll = false;
    } catch (err: any) {
      console.warn(`[YouTubeLiveChat] Erro no polling de mensagens: ${err.message}`);
      nextDelayMs = 8000;
    }

    this.scheduleNextPoll(nextDelayMs);
  }

  private scheduleNextPoll(delayMs: number): void {
    if (!this.isPolling) return;
    if (this.pollingTimeout) clearTimeout(this.pollingTimeout);

    this.pollingTimeout = setTimeout(() => {
      this.pollMessages();
    }, delayMs);
  }
}
