import { EventEmitter } from 'events';
import https from 'https';
import WebSocket from 'ws';
import { UnifiedChatMessage, PlatformStatus, ConnectionStatus } from '../../types/chat.js';

interface KickSenderIdentity {
  color?: string;
  badges?: Array<{
    type?: string;
    text?: string;
  }>;
  badges_v2?: Array<{
    name?: string;
    badge_type?: string;
    image_url?: string;
    metadata?: {
      level?: number;
    };
  }>;
}

interface KickSender {
  id?: number;
  username: string;
  slug?: string;
  identity?: KickSenderIdentity;
}

interface KickChatMessagePayload {
  id: string;
  chatroom_id?: number;
  content: string;
  type?: string;
  created_at?: string;
  sender: KickSender;
}

function httpsRequest(
  urlStr: string,
  method: 'GET' | 'POST' = 'GET',
  headers: Record<string, string> = {},
  postData?: string
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const reqHeaders: Record<string, string | number> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      ...headers
    };

    if (postData) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(postData);
    }

    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: reqHeaders
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode || 0, data });
      });
    });

    req.on('error', reject);
    req.setTimeout(8000, () => {
      req.destroy(new Error('Timeout de requisição HTTP na Kick'));
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

export class KickChatService extends EventEmitter {
  private currentSlug: string | null = null;
  private chatroomId: number | null = null;
  private channelTitle: string | null = null;
  private channelAvatar: string | null = null;
  private liveTitle: string | null = null;
  private status: ConnectionStatus = 'disconnected';
  private ws: WebSocket | null = null;
  private lastErrorMessage: string | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private isIntentionalDisconnect = false;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;

  constructor() {
    super();
  }

  public getStatus(): PlatformStatus {
    return {
      platform: 'kick',
      status: this.status,
      channel: this.currentSlug || undefined,
      channelAvatar: this.channelAvatar || undefined,
      liveTitle: this.liveTitle || undefined,
      hasActiveLive: Boolean(this.liveTitle),
      error: this.lastErrorMessage || undefined
    };
  }

  private updateStatus(newStatus: ConnectionStatus, error?: string): void {
    this.status = newStatus;
    this.lastErrorMessage = error || null;
    this.emit('status', this.getStatus());
  }

  /**
   * Conecta a um canal da Kick
   * @param inputSlug Nome do canal, @handle ou URL completa
   */
  public async joinChannel(inputSlug: string): Promise<boolean> {
    const slug = this.normalizeSlug(inputSlug);
    if (!slug) {
      this.updateStatus('error', 'Nome do canal da Kick inválido.');
      return false;
    }

    this.leaveChannel();
    this.isIntentionalDisconnect = false;
    this.currentSlug = slug;
    this.reconnectAttempts = 0;
    this.updateStatus('connecting');

    try {
      console.log(`[KickChat] Resolvendo metadados do canal "${slug}"...`);
      const channelData = await this.fetchChannelData(slug);
      if (!channelData || !channelData.chatroom?.id) {
        throw new Error(`Canal "${slug}" não encontrado na Kick.`);
      }

      const chatroomId = channelData.chatroom.id;
      this.chatroomId = chatroomId;
      this.channelTitle = channelData.user?.username || slug;
      this.channelAvatar = channelData.user?.profile_pic || null;
      this.liveTitle = channelData.livestream?.session_title || null;

      console.log(`[KickChat] Canal resolvido: ${this.channelTitle} (Chatroom ID: ${chatroomId})`);

      // Pré-carrega histórico recente de mensagens da Kick
      this.fetchChatHistory(chatroomId).catch((err) => {
        console.warn(`[KickChat] Não foi possível carregar histórico inicial: ${err.message}`);
      });

      // Obtém credenciais de conexão do Pusher dinamicamente
      const credentials = await this.fetchRealtimeCredentials(chatroomId);
      await this.connectPusher(credentials.appKey, credentials.cluster, chatroomId);
      return true;
    } catch (err: any) {
      console.error(`[KickChat] Falha ao conectar ao canal ${slug}: ${err.message}`);
      this.updateStatus('error', err.message);
      this.scheduleReconnect();
      return false;
    }
  }

  public leaveChannel(): void {
    this.isIntentionalDisconnect = true;
    this.clearTimers();

    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch (err: any) {
        console.warn(`[KickChat] Erro ao fechar WebSocket: ${err.message}`);
      }
      this.ws = null;
    }

    this.chatroomId = null;
    this.currentSlug = null;
    this.channelTitle = null;
    this.channelAvatar = null;
    this.liveTitle = null;
    this.updateStatus('disconnected');
  }

  private normalizeSlug(input: string): string {
    return input
      .trim()
      .replace(/^https?:\/\/(?:www\.)?kick\.com\//i, '')
      .replace(/^@/, '')
      .split('/')[0]
      .split('?')[0]
      .toLowerCase();
  }

  private async fetchChannelData(slug: string): Promise<any> {
    const res = await httpsRequest(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, 'GET');

    if (res.status !== 200) {
      throw new Error(`Resposta HTTP ${res.status} ao consultar dados do canal Kick`);
    }

    return JSON.parse(res.data);
  }

  /**
   * Consulta a Kick via HTTP/1.1 para descobrir as credenciais ativas do Pusher
   * Fallback inteligente para o cluster 'us2' e chave pública padrão caso a API esteja restrita.
   */
  private async fetchRealtimeCredentials(chatroomId: number): Promise<{ appKey: string; cluster: string }> {
    const defaultCredentials = {
      appKey: '34bf7a0ff419a2a775b9',
      cluster: 'us2'
    };

    try {
      const payload = JSON.stringify({
        client: { id: `platchat-${Date.now()}`, type: 'web' },
        capabilities: { accepted_providers: [{ provider: 'pusher' }] }
      });

      const res = await httpsRequest(
        `https://web.kick.com/api/v1/realtime/channels/${chatroomId}/chat/connection`,
        'POST',
        {},
        payload
      );

      if (res.status === 200) {
        const data = JSON.parse(res.data);
        const pusherConn = data?.data?.connections?.find((c: any) => c.provider === 'pusher');
        if (pusherConn?.credentials?.app_key && pusherConn?.credentials?.cluster) {
          return {
            appKey: pusherConn.credentials.app_key,
            cluster: pusherConn.credentials.cluster
          };
        }
      }
    } catch {
      // Ignora e usa credenciais de fallback
    }

    return defaultCredentials;
  }

  private async fetchChatHistory(chatroomId: number): Promise<void> {
    try {
      const res = await httpsRequest(`https://web.kick.com/api/v1/chat/${chatroomId}/history`, 'GET');

      if (res.status !== 200) return;

      const data = JSON.parse(res.data);
      const messages = data?.data?.messages;
      if (Array.isArray(messages) && messages.length > 0) {
        const unifiedBatch: UnifiedChatMessage[] = [];
        for (const rawMsg of messages) {
          const parsed = this.mapToUnified(rawMsg);
          if (parsed) unifiedBatch.push(parsed);
        }

        if (unifiedBatch.length > 0) {
          unifiedBatch.sort((a, b) => a.timestamp - b.timestamp);
          this.emit('batch', unifiedBatch);
        }
      }
    } catch (err: any) {
      console.warn(`[KickChat] Erro ao buscar histórico: ${err.message}`);
    }
  }

  private connectPusher(appKey: string, cluster: string, chatroomId: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = `wss://ws-${cluster}.pusher.com/app/${appKey}?protocol=7&client=js&version=8.4.0&flash=false`;
      console.log(`[KickChat] Conectando WebSocket Pusher (${cluster})...`);

      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      const connectionTimeout = setTimeout(() => {
        if (this.status !== 'connected') {
          ws.terminate();
          reject(new Error('Tempo esgotado na conexão com Pusher'));
        }
      }, 10000);

      ws.on('open', () => {
        console.log(`[KickChat] WebSocket aberto. Inscrevendo no chatroom ${chatroomId}...`);
        ws.send(JSON.stringify({
          event: 'pusher:subscribe',
          data: { auth: '', channel: `chatrooms.${chatroomId}.v2` }
        }));
      });

      ws.on('message', (raw) => {
        try {
          const parsed = JSON.parse(raw.toString());

          // Evento de conexão do Pusher
          if (parsed.event === 'pusher:connection_established') {
            clearTimeout(connectionTimeout);
            this.reconnectAttempts = 0;
            this.updateStatus('connected');
            this.startPingInterval();
            resolve();
            return;
          }

          // Resposta a pings
          if (parsed.event === 'pusher:ping') {
            ws.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
            return;
          }

          // Mensagens do chat
          if (parsed.event === 'App\\Events\\ChatMessageEvent' && parsed.data) {
            const chatPayload: KickChatMessagePayload = typeof parsed.data === 'string'
              ? JSON.parse(parsed.data)
              : parsed.data;

            const unified = this.mapToUnified(chatPayload);
            if (unified) {
              this.emit('message', unified);
            }
          }
        } catch (err: any) {
          console.warn(`[KickChat] Erro ao interpretar mensagem: ${err.message}`);
        }
      });

      ws.on('error', (err) => {
        console.error(`[KickChat] Erro no WebSocket: ${err.message}`);
        clearTimeout(connectionTimeout);
        this.updateStatus('error', err.message);
        reject(err);
      });

      ws.on('close', (code, reason) => {
        clearTimeout(connectionTimeout);
        this.clearPingInterval();

        if (!this.isIntentionalDisconnect) {
          console.warn(`[KickChat] Conexão fechada (${code}: ${reason.toString()}). Agendando reconexão...`);
          this.updateStatus('disconnected', `Conexão fechada: ${reason.toString() || code}`);
          this.scheduleReconnect();
        }
      });
    });
  }

  private mapToUnified(msg: KickChatMessagePayload): UnifiedChatMessage | null {
    if (!msg || !msg.sender || !msg.content) return null;

    const badges: string[] = [];

    // Badges v1
    if (Array.isArray(msg.sender.identity?.badges)) {
      for (const b of msg.sender.identity.badges) {
        if (b.type) badges.push(b.type);
      }
    }

    // Badges v2 (níveis, etc.)
    if (Array.isArray(msg.sender.identity?.badges_v2)) {
      for (const b of msg.sender.identity.badges_v2) {
        if (b.name && !badges.includes(b.name)) {
          if (b.name === 'level' && b.metadata?.level) {
            badges.push(`lvl ${b.metadata.level}`);
          } else {
            badges.push(b.name);
          }
        }
      }
    }

    // Limpeza de emotes do Kick formatados como [emote:id:name]
    const cleanContent = msg.content.replace(/\[emote:\d+:([^\]]+)\]/g, '$1');

    const timestamp = msg.created_at ? new Date(msg.created_at).getTime() : Date.now();

    return {
      id: msg.id || `kick-${timestamp}-${Math.random().toString(36).substring(2, 7)}`,
      platform: 'kick',
      username: msg.sender.username,
      avatar: undefined,
      message: cleanContent,
      timestamp,
      color: msg.sender.identity?.color || '#53fc18',
      badges: badges.length > 0 ? badges : undefined
    };
  }

  private startPingInterval(): void {
    this.clearPingInterval();
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
      }
    }, 60000);
  }

  private clearPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.isIntentionalDisconnect || !this.currentSlug) return;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.warn(`[KickChat] Limite de tentativas de reconexão atingido para ${this.currentSlug}`);
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(2000 * Math.pow(1.5, this.reconnectAttempts), 30000);
    console.log(`[KickChat] Tentativa de reconexão #${this.reconnectAttempts} em ${Math.round(delay / 1000)}s...`);

    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = setTimeout(() => {
      if (this.currentSlug && !this.isIntentionalDisconnect) {
        this.joinChannel(this.currentSlug);
      }
    }, delay);
  }

  private clearTimers(): void {
    this.clearPingInterval();
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }
}
