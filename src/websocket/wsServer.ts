import { Server as HttpServer } from 'http';
import WebSocket, { WebSocketServer, RawData } from 'ws';
import { 
  UnifiedChatMessage, 
  ClientCommand, 
  ServerEvent, 
  PlatformStatus,
  AllPlatformStatuses 
} from '../types/chat.js';
import { TwitchIrcService } from '../services/twitch/twitchIrcService.js';
import { YouTubePublicChatService } from '../services/youtube/youtubePublicChatService.js';
import { YouTubeLiveChatService } from '../services/youtube/youtubeLiveChatService.js';
import { YouTubeAuthService } from '../services/youtube/youtubeAuthService.js';
import { KickChatService } from '../services/kick/kickChatService.js';
import { TikTokLiveService } from '../services/tiktok/tiktokLiveService.js';
import { MessageQueue } from '../services/queue/messageQueue.js';

interface ExtWebSocket extends WebSocket {
  isAlive: boolean;
}

export class ChatWsServer {
  private wss: WebSocketServer;
  private clients: Set<ExtWebSocket> = new Set();
  private pingInterval: NodeJS.Timeout | null = null;

  constructor(
    httpServer: HttpServer,
    private twitchService: TwitchIrcService,
    private youtubePublicService: YouTubePublicChatService,
    private youtubeOAuthService: YouTubeLiveChatService,
    private youtubeAuthService: YouTubeAuthService,
    private kickService: KickChatService,
    private tiktokService: TikTokLiveService,
    private messageQueue: MessageQueue
  ) {
    this.wss = new WebSocketServer({ server: httpServer, path: '/ws' });

    this.setupWebSocketServer();
    this.setupServiceListeners();
    this.setupHeartbeat();
  }

  private setupWebSocketServer(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      const extWs = ws as ExtWebSocket;
      extWs.isAlive = true;
      this.clients.add(extWs);

      console.log(`[WsServer] Novo cliente conectado (total: ${this.clients.size})`);

      extWs.on('pong', () => {
        extWs.isAlive = true;
      });

      // Envia status consolidado de todas as plataformas e histórico recente
      this.sendToClient(extWs, {
        type: 'status_update',
        data: this.getAllStatuses()
      });

      const history = this.messageQueue.getHistory();
      if (history.length > 0) {
        this.sendToClient(extWs, {
          type: 'history',
          data: history
        });
      }

      extWs.on('message', (raw: RawData) => {
        this.handleClientMessage(extWs, raw.toString());
      });

      extWs.on('close', () => {
        this.clients.delete(extWs);
        console.log(`[WsServer] Cliente desconectado (restantes: ${this.clients.size})`);
      });

      extWs.on('error', (err) => {
        console.error(`[WsServer] Erro no socket cliente: ${err.message}`);
        this.clients.delete(extWs);
      });
    });
  }

  private handleClientMessage(ws: ExtWebSocket, rawData: string): void {
    try {
      const command = JSON.parse(rawData) as ClientCommand;

      switch (command.action) {
        case 'subscribe': {
          if (command.platform === 'twitch' && command.channel) {
            console.log(`[WsServer] Comando: Conectar Twitch (#${command.channel})`);
            this.twitchService.joinChannel(command.channel);
          } else if (command.platform === 'youtube') {
            if (command.channel) {
              console.log(`[WsServer] Comando: Conectar YouTube público (${command.channel})`);
              this.youtubePublicService.joinChannel(command.channel);
            } else {
              console.log('[WsServer] Comando: Detectar live do YouTube via OAuth');
              this.youtubeOAuthService.detectAndJoinActiveLive();
            }
          } else if (command.platform === 'kick' && command.channel) {
            console.log(`[WsServer] Comando: Conectar Kick (${command.channel})`);
            this.kickService.joinChannel(command.channel);
          } else if (command.platform === 'tiktok' && command.channel) {
            console.log(`[WsServer] Comando: Conectar TikTok Live (@${command.channel})`);
            this.tiktokService.joinChannel(command.channel);
          }
          break;
        }

        case 'unsubscribe': {
          if (command.platform === 'twitch') {
            console.log('[WsServer] Comando: Desconectar Twitch');
            this.twitchService.leaveChannel();
          } else if (command.platform === 'youtube') {
            console.log('[WsServer] Comando: Desconectar YouTube');
            this.youtubePublicService.leaveChannel();
            this.youtubeOAuthService.leaveLive();
          } else if (command.platform === 'kick') {
            console.log('[WsServer] Comando: Desconectar Kick');
            this.kickService.leaveChannel();
          } else if (command.platform === 'tiktok') {
            console.log('[WsServer] Comando: Desconectar TikTok Live');
            this.tiktokService.leaveChannel();
          }
          break;
        }

        case 'detect_youtube_live': {
          console.log('[WsServer] Comando: Forçar detecção de live ativa no YouTube (OAuth)');
          this.youtubeOAuthService.detectAndJoinActiveLive();
          break;
        }

        case 'youtube_logout': {
          console.log('[WsServer] Comando: Logout Google / YouTube OAuth');
          this.youtubeAuthService.logout();
          this.youtubePublicService.leaveChannel();
          break;
        }

        case 'get_history': {
          this.sendToClient(ws, {
            type: 'history',
            data: this.messageQueue.getHistory()
          });
          break;
        }

        case 'get_status': {
          this.sendToClient(ws, {
            type: 'status_update',
            data: this.getAllStatuses()
          });
          break;
        }

        case 'test_message': {
          const platform = command.platform || 'twitch';
          let sampleMessage: UnifiedChatMessage;

          const baseId = `test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
          const timestamp = Date.now();

          switch (platform) {
            case 'youtube':
              sampleMessage = {
                id: baseId,
                platform: 'youtube',
                username: 'YouTubeFan_2026',
                avatar: 'https://picsum.photos/seed/yt/64',
                message: command.message || 'Mensagem de teste do YouTube Live! 🔴',
                timestamp,
                color: '#FF3333',
                badges: ['member']
              };
              break;

            case 'kick':
              sampleMessage = {
                id: baseId,
                platform: 'kick',
                username: 'KickViewer_77',
                avatar: undefined,
                message: command.message || 'Salve! Mensagem de teste da Kick! 🟢',
                timestamp,
                color: '#53FC18',
                badges: ['moderator', 'lvl 10']
              };
              break;

            case 'tiktok':
              sampleMessage = {
                id: baseId,
                platform: 'tiktok',
                username: 'TikToker_Live',
                avatar: 'https://picsum.photos/seed/tt/64',
                message: command.message || 'Bora bater a meta de curtidas! Mensagem do TikTok Live! 🎵',
                timestamp,
                color: '#00F2FE',
                badges: ['subscriber']
              };
              break;

            case 'twitch':
            default:
              sampleMessage = {
                id: baseId,
                platform: 'twitch',
                username: 'TwitchViewer_99',
                message: command.message || 'Mensagem de teste vinda da Twitch! 🟣',
                timestamp,
                color: '#9146FF',
                badges: ['vip']
              };
              break;
          }

          this.messageQueue.pushMessage(sampleMessage);
          break;
        }

        default:
          console.warn(`[WsServer] Ação desconhecida: ${(command as any).action}`);
      }
    } catch (err: any) {
      console.error(`[WsServer] Erro ao processar comando do cliente: ${err.message}`);
    }
  }

  private setupServiceListeners(): void {
    // 1. Twitch
    this.twitchService.on('message', (msg: UnifiedChatMessage) => {
      this.messageQueue.pushMessage(msg);
    });
    this.twitchService.on('status', () => this.broadcastStatus());

    // 2. YouTube Público (Sem autenticação)
    this.youtubePublicService.on('message', (msg: UnifiedChatMessage) => {
      this.messageQueue.pushMessage(msg);
    });
    this.youtubePublicService.on('batch', (batch: UnifiedChatMessage[]) => {
      this.messageQueue.pushBatch(batch);
    });
    this.youtubePublicService.on('status', () => this.broadcastStatus());

    // 3. YouTube OAuth (Opcional / legado)
    this.youtubeOAuthService.on('batch', (batch: UnifiedChatMessage[]) => {
      this.messageQueue.pushBatch(batch);
    });
    this.youtubeOAuthService.on('status', () => this.broadcastStatus());
    this.youtubeAuthService.on('authenticated', () => this.broadcastStatus());
    this.youtubeAuthService.on('logout', () => this.broadcastStatus());

    // 4. Kick
    this.kickService.on('message', (msg: UnifiedChatMessage) => {
      this.messageQueue.pushMessage(msg);
    });
    this.kickService.on('batch', (batch: UnifiedChatMessage[]) => {
      this.messageQueue.pushBatch(batch);
    });
    this.kickService.on('status', () => this.broadcastStatus());

    // 5. TikTok Live
    this.tiktokService.on('message', (msg: UnifiedChatMessage) => {
      this.messageQueue.pushMessage(msg);
    });
    this.tiktokService.on('status', () => this.broadcastStatus());

    // Fila centralizadora -> Clientes conectados (em lote ordenado cronologicamente)
    this.messageQueue.on('batch', (batch: UnifiedChatMessage[]) => {
      this.broadcast({
        type: 'batch',
        data: batch
      });
    });
  }

  public getAllStatuses(): AllPlatformStatuses {
    // Para o YouTube, se o serviço público estiver ativo ou conectando, expõe ele;
    // caso contrário, se houver sessão OAuth ativa, expõe o status OAuth
    let ytStatus = this.youtubePublicService.getStatus();
    if (ytStatus.status === 'disconnected') {
      const oauthStatus = this.youtubeOAuthService.getStatus();
      if (oauthStatus.isAuthenticated || oauthStatus.status !== 'disconnected') {
        ytStatus = oauthStatus;
      }
    }

    return {
      twitch: this.twitchService.getStatus(),
      youtube: ytStatus,
      kick: this.kickService.getStatus(),
      tiktok: this.tiktokService.getStatus()
    };
  }

  private broadcastStatus(): void {
    this.broadcast({
      type: 'status_update',
      data: this.getAllStatuses()
    });
  }

  private broadcast<T>(event: ServerEvent<T>): void {
    const payload = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  private sendToClient<T>(client: ExtWebSocket, event: ServerEvent<T>): void {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(event));
    }
  }

  private setupHeartbeat(): void {
    this.pingInterval = setInterval(() => {
      for (const client of this.clients) {
        if (!client.isAlive) {
          client.terminate();
          this.clients.delete(client);
          continue;
        }
        client.isAlive = false;
        client.ping();
      }
    }, 30000);
  }

  public close(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }
    this.wss.close();
  }
}
