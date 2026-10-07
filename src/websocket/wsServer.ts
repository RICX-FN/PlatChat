import { Server as HttpServer } from 'http';
import WebSocket, { WebSocketServer, RawData } from 'ws';
import { 
  UnifiedChatMessage, 
  ClientCommand, 
  ServerEvent, 
  PlatformStatus 
} from '../types/chat.js';
import { TwitchIrcService } from '../services/twitch/twitchIrcService.js';
import { YouTubeLiveChatService } from '../services/youtube/youtubeLiveChatService.js';
import { YouTubeAuthService } from '../services/youtube/youtubeAuthService.js';
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
    private youtubeService: YouTubeLiveChatService,
    private youtubeAuthService: YouTubeAuthService,
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

      // Envia status atual e histórico recente para o novo cliente
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
            console.log(`[WsServer] Comando: Conectar Twitch ao canal #${command.channel}`);
            this.twitchService.joinChannel(command.channel);
          } else if (command.platform === 'youtube') {
            console.log('[WsServer] Comando: Detectar e conectar live do YouTube');
            this.youtubeService.detectAndJoinActiveLive();
          }
          break;
        }

        case 'unsubscribe': {
          if (command.platform === 'twitch') {
            console.log('[WsServer] Comando: Desconectar Twitch');
            this.twitchService.leaveChannel();
          } else if (command.platform === 'youtube') {
            console.log('[WsServer] Comando: Desconectar escuta do YouTube');
            this.youtubeService.leaveLive();
          }
          break;
        }

        case 'detect_youtube_live': {
          console.log('[WsServer] Comando: Forçar verificação de live ativa no YouTube');
          this.youtubeService.detectAndJoinActiveLive();
          break;
        }

        case 'youtube_logout': {
          console.log('[WsServer] Comando: Desconectar conta do Google / YouTube');
          this.youtubeAuthService.logout();
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
          const platform = command.platform === 'youtube' ? 'youtube' : 'twitch';
          const sampleMessage: UnifiedChatMessage = {
            id: `test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
            platform,
            username: platform === 'twitch' ? 'TwitchViewer_99' : 'YouTubeFan_2026',
            avatar: platform === 'youtube' ? 'https://picsum.photos/seed/yt/64' : undefined,
            message: command.message || `Mensagem de teste vinda de [${platform.toUpperCase()}]! 🚀`,
            timestamp: Date.now(),
            color: platform === 'twitch' ? '#9146FF' : '#FF0000',
            badges: ['vip']
          };

          this.messageQueue.pushMessage(sampleMessage);
          break;
        }

        default:
          console.warn(`[WsServer] Ação desconhecida: ${(command as any).action}`);
      }
    } catch (err: any) {
      console.error(`[WsServer] Erro ao processar mensagem do cliente: ${err.message}`);
    }
  }

  private setupServiceListeners(): void {
    // Twitch -> Fila
    this.twitchService.on('message', (msg: UnifiedChatMessage) => {
      this.messageQueue.pushMessage(msg);
    });

    this.twitchService.on('status', () => {
      this.broadcast({
        type: 'status_update',
        data: this.getAllStatuses()
      });
    });

    // YouTube -> Fila
    this.youtubeService.on('batch', (batch: UnifiedChatMessage[]) => {
      this.messageQueue.pushBatch(batch);
    });

    this.youtubeService.on('status', () => {
      this.broadcast({
        type: 'status_update',
        data: this.getAllStatuses()
      });
    });

    // YouTube Auth -> Notificar clientes sobre mudanças de login
    this.youtubeAuthService.on('authenticated', () => {
      this.broadcast({
        type: 'status_update',
        data: this.getAllStatuses()
      });
    });

    this.youtubeAuthService.on('logout', () => {
      this.broadcast({
        type: 'status_update',
        data: this.getAllStatuses()
      });
    });

    // Fila -> Clientes conectados (em lotes ordenados cronologicamente)
    this.messageQueue.on('batch', (batch: UnifiedChatMessage[]) => {
      this.broadcast({
        type: 'batch',
        data: batch
      });
    });
  }

  public getAllStatuses(): { twitch: PlatformStatus; youtube: PlatformStatus } {
    return {
      twitch: this.twitchService.getStatus(),
      youtube: this.youtubeService.getStatus()
    };
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
