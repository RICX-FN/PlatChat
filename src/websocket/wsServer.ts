import { Server as HttpServer } from 'http';
import WebSocket, { WebSocketServer, RawData } from 'ws';
import {
  UnifiedChatMessage,
  ClientCommand,
  ServerEvent,
  AllPlatformStatuses
} from '../types/chat.js';
import { TwitchIrcService } from '../services/twitch/twitchIrcService.js';
import { YouTubePublicChatService } from '../services/youtube/youtubePublicChatService.js';
import { KickChatService } from '../services/kick/kickChatService.js';
import { TikTokLiveService } from '../services/tiktok/tiktokLiveService.js';
import { MessageQueue } from '../services/queue/messageQueue.js';

interface ExtWebSocket extends WebSocket {
  isAlive: boolean;
}

interface ChatSession {
  twitchService: TwitchIrcService;
  youtubePublicService: YouTubePublicChatService;
  kickService: KickChatService;
  tiktokService: TikTokLiveService;
  messageQueue: MessageQueue;
}

export class ChatWsServer {
  private wss: WebSocketServer;
  private sessions = new Map<ExtWebSocket, ChatSession>();
  private pingInterval: NodeJS.Timeout | null = null;

  constructor(httpServer: HttpServer) {
    this.wss = new WebSocketServer({ server: httpServer, path: '/ws' });
    this.setupWebSocketServer();
    this.setupHeartbeat();
  }

  private createSession(client: ExtWebSocket): ChatSession {
    const session: ChatSession = {
      twitchService: new TwitchIrcService(),
      youtubePublicService: new YouTubePublicChatService(),
      kickService: new KickChatService(),
      tiktokService: new TikTokLiveService(),
      messageQueue: new MessageQueue({ flushIntervalMs: 50, maxHistorySize: 150 })
    };

    session.twitchService.on('message', (message: UnifiedChatMessage) => {
      session.messageQueue.pushMessage(message);
    });
    session.twitchService.on('status', () => this.broadcastStatus(client, session));

    session.youtubePublicService.on('message', (message: UnifiedChatMessage) => {
      session.messageQueue.pushMessage(message);
    });
    session.youtubePublicService.on('batch', (messages: UnifiedChatMessage[]) => {
      session.messageQueue.pushBatch(messages);
    });
    session.youtubePublicService.on('status', () => this.broadcastStatus(client, session));

    session.kickService.on('message', (message: UnifiedChatMessage) => {
      session.messageQueue.pushMessage(message);
    });
    session.kickService.on('batch', (messages: UnifiedChatMessage[]) => {
      session.messageQueue.pushBatch(messages);
    });
    session.kickService.on('status', () => this.broadcastStatus(client, session));

    session.tiktokService.on('message', (message: UnifiedChatMessage) => {
      session.messageQueue.pushMessage(message);
    });
    session.tiktokService.on('status', () => this.broadcastStatus(client, session));
    session.messageQueue.on('batch', (messages: UnifiedChatMessage[]) => {
      this.sendToClient(client, { type: 'batch', data: messages });
    });

    return session;
  }

  private setupWebSocketServer(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      const client = ws as ExtWebSocket;
      client.isAlive = true;
      const session = this.createSession(client);
      this.sessions.set(client, session);

      console.log(`[WsServer] Sessão isolada conectada (total: ${this.sessions.size})`);

      client.on('pong', () => {
        client.isAlive = true;
      });

      this.sendToClient(client, {
        type: 'status_update',
        data: this.getAllStatuses(session)
      });

      client.on('message', (raw: RawData) => {
        this.handleClientMessage(client, session, raw.toString());
      });

      client.on('close', () => {
        this.closeSession(client, session);
      });

      client.on('error', (error) => {
        console.error(`[WsServer] Erro no socket cliente: ${error.message}`);
        this.closeSession(client, session);
      });
    });
  }

  private handleClientMessage(client: ExtWebSocket, session: ChatSession, rawData: string): void {
    try {
      const command = JSON.parse(rawData) as ClientCommand;

      switch (command.action) {
        case 'subscribe': {
          if (!command.channel) break;
          switch (command.platform) {
            case 'twitch':
              console.log(`[WsServer] Sessão conectando Twitch (#${command.channel})`);
              session.twitchService.joinChannel(command.channel);
              break;
            case 'youtube':
              console.log(`[WsServer] Sessão conectando YouTube (${command.channel})`);
              void session.youtubePublicService.joinChannel(command.channel);
              break;
            case 'kick':
              console.log(`[WsServer] Sessão conectando Kick (${command.channel})`);
              void session.kickService.joinChannel(command.channel);
              break;
            case 'tiktok':
              console.log(`[WsServer] Sessão conectando TikTok (@${command.channel})`);
              void session.tiktokService.joinChannel(command.channel);
              break;
          }
          break;
        }

        case 'unsubscribe':
          switch (command.platform) {
            case 'twitch':
              session.twitchService.leaveChannel();
              break;
            case 'youtube':
              session.youtubePublicService.leaveChannel();
              break;
            case 'kick':
              session.kickService.leaveChannel();
              break;
            case 'tiktok':
              session.tiktokService.leaveChannel();
              break;
          }
          break;

        case 'get_history':
          this.sendToClient(client, {
            type: 'history',
            data: session.messageQueue.getHistory()
          });
          break;

        case 'get_status':
          this.sendToClient(client, {
            type: 'status_update',
            data: this.getAllStatuses(session)
          });
          break;

        case 'test_message': {
          const message = this.createTestMessage(command);
          if (message) session.messageQueue.pushMessage(message);
          break;
        }

        default:
          console.warn(`[WsServer] Ação desconhecida: ${String(command.action)}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[WsServer] Erro ao processar comando do cliente: ${message}`);
    }
  }

  private createTestMessage(command: ClientCommand): UnifiedChatMessage | null {
    const timestamp = Date.now();
    const baseId = `test-${timestamp}-${Math.random().toString(36).substring(2, 7)}`;

    switch (command.platform) {
      case 'youtube':
        return {
          id: baseId,
          platform: 'youtube',
          username: 'YouTubeFan_2026',
          avatar: 'https://picsum.photos/seed/yt/64',
          message: command.message || 'Mensagem de teste do YouTube Live! 🔴',
          timestamp,
          color: '#FF3333',
          badges: ['member']
        };
      case 'kick':
        return {
          id: baseId,
          platform: 'kick',
          username: 'KickViewer_77',
          message: command.message || 'Salve! Mensagem de teste da Kick! 🟢',
          timestamp,
          color: '#53FC18',
          badges: ['moderator', 'lvl 10']
        };
      case 'tiktok':
        return {
          id: baseId,
          platform: 'tiktok',
          username: 'TikToker_Live',
          avatar: 'https://picsum.photos/seed/tt/64',
          message: command.message || 'Bora bater a meta de curtidas! Mensagem do TikTok Live! 🎵',
          timestamp,
          color: '#00F2FE',
          badges: ['subscriber']
        };
      case 'twitch':
      case undefined:
        return {
          id: baseId,
          platform: 'twitch',
          username: 'TwitchViewer_99',
          message: command.message || 'Mensagem de teste vinda da Twitch! 🟣',
          timestamp,
          color: '#9146FF',
          badges: ['vip']
        };
      default:
        return null;
    }
  }

  private getAllStatuses(session: ChatSession): AllPlatformStatuses {
    return {
      twitch: session.twitchService.getStatus(),
      youtube: session.youtubePublicService.getStatus(),
      kick: session.kickService.getStatus(),
      tiktok: session.tiktokService.getStatus()
    };
  }

  private broadcastStatus(client: ExtWebSocket, session: ChatSession): void {
    this.sendToClient(client, {
      type: 'status_update',
      data: this.getAllStatuses(session)
    });
  }

  private sendToClient<T>(client: ExtWebSocket, event: ServerEvent<T>): void {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(event));
    }
  }

  private closeSession(client: ExtWebSocket, session: ChatSession): void {
    if (!this.sessions.delete(client)) return;

    session.twitchService.removeAllListeners();
    session.youtubePublicService.removeAllListeners();
    session.kickService.removeAllListeners();
    session.tiktokService.removeAllListeners();
    session.messageQueue.removeAllListeners();

    session.twitchService.leaveChannel();
    session.youtubePublicService.leaveChannel();
    session.kickService.leaveChannel();
    session.tiktokService.leaveChannel();
    session.messageQueue.clear();

    console.log(`[WsServer] Sessão isolada encerrada (restantes: ${this.sessions.size})`);
  }

  private setupHeartbeat(): void {
    this.pingInterval = setInterval(() => {
      for (const client of this.sessions.keys()) {
        if (!client.isAlive) {
          client.terminate();
          continue;
        }
        client.isAlive = false;
        client.ping();
      }
    }, 30000);
  }

  public getConnectedClientCount(): number {
    return this.sessions.size;
  }

  public close(): void {
    if (this.pingInterval) clearInterval(this.pingInterval);
    for (const [client, session] of this.sessions) {
      this.closeSession(client, session);
      client.close();
    }
    this.wss.close();
  }
}
