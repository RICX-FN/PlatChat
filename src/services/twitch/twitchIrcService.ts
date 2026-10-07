import WebSocket, { RawData } from 'ws';
import { EventEmitter } from 'events';
import { UnifiedChatMessage, PlatformStatus, ConnectionStatus } from '../../types/chat.js';
import { parseTwitchIrc, convertPrivmsgToUnified } from './twitchParser.js';

export class TwitchIrcService extends EventEmitter {
  private ws: WebSocket | null = null;
  private currentChannel: string | null = null;
  private status: ConnectionStatus = 'disconnected';
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectDelay = 30000;
  private isIntentionalClose = false;

  private static readonly TWITCH_WS_URL = 'wss://irc-ws.chat.twitch.tv:443';

  constructor() {
    super();
  }

  public getStatus(): PlatformStatus {
    return {
      platform: 'twitch',
      status: this.status,
      channel: this.currentChannel || undefined
    };
  }

  private updateStatus(newStatus: ConnectionStatus, error?: string): void {
    this.status = newStatus;
    const statusPayload: PlatformStatus = {
      platform: 'twitch',
      status: newStatus,
      channel: this.currentChannel || undefined,
      error
    };
    this.emit('status', statusPayload);
  }

  /**
   * Conecta a um canal específico da Twitch.
   */
  public joinChannel(rawChannel: string): void {
    const channel = rawChannel.trim().toLowerCase().replace(/^#/, '');
    if (!channel) return;

    this.isIntentionalClose = false;

    // Se já estiver conectado ao mesmo canal, não faz nada
    if (this.currentChannel === channel && this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    this.currentChannel = channel;
    this.reconnectAttempts = 0;

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.closeSocket();
    }

    this.connect();
  }

  /**
   * Desconecta do canal atual.
   */
  public leaveChannel(): void {
    this.isIntentionalClose = true;
    this.currentChannel = null;
    this.reconnectAttempts = 0;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.closeSocket();
    this.updateStatus('disconnected');
  }

  private connect(): void {
    if (!this.currentChannel) return;

    this.updateStatus('connecting');

    try {
      this.ws = new WebSocket(TwitchIrcService.TWITCH_WS_URL);

      this.ws.on('open', () => {
        this.reconnectAttempts = 0;
        this.handleOpen();
      });

      this.ws.on('message', (data: RawData) => {
        this.handleMessage(data.toString());
      });

      this.ws.on('error', (err) => {
        console.error(`[TwitchIrc] Erro na conexão: ${err.message}`);
        this.updateStatus('error', err.message);
      });

      this.ws.on('close', (code, reason) => {
        console.warn(`[TwitchIrc] Conexão encerrada (${code}): ${reason.toString()}`);
        this.ws = null;
        if (!this.isIntentionalClose && this.currentChannel) {
          this.scheduleReconnect();
        } else {
          this.updateStatus('disconnected');
        }
      });
    } catch (err: any) {
      console.error(`[TwitchIrc] Falha ao iniciar WebSocket: ${err.message}`);
      this.updateStatus('error', err.message);
      this.scheduleReconnect();
    }
  }

  private handleOpen(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Conexão anônima no protocolo Twitch IRC
    const anonNick = `justinfan${Math.floor(10000 + Math.random() * 90000)}`;
    
    // Solicitar tags e comandos estendidos
    this.ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands\r\n');
    this.ws.send('PASS SCHMOOPIE\r\n');
    this.ws.send(`NICK ${anonNick}\r\n`);
    this.ws.send(`JOIN #${this.currentChannel}\r\n`);

    this.updateStatus('connected');
    console.log(`[TwitchIrc] Conectado e escutando #${this.currentChannel} anonimamente como ${anonNick}`);
  }

  private handleMessage(data: string): void {
    const lines = data.split('\r\n');

    for (const line of lines) {
      if (!line || line.trim().length === 0) continue;

      // Responder a PING da Twitch para manter conexão viva
      if (line.startsWith('PING')) {
        this.ws?.send('PONG :tmi.twitch.tv\r\n');
        continue;
      }

      const parsed = parseTwitchIrc(line);

      if (parsed.command === 'PRIVMSG') {
        const unifiedMsg = convertPrivmsgToUnified(parsed);
        if (unifiedMsg) {
          this.emit('message', unifiedMsg);
        }
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.isIntentionalClose || !this.currentChannel) return;

    this.updateStatus('connecting', 'Tentando reconectar...');
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);

    console.log(`[TwitchIrc] Tentando reconectar em ${delay / 1000}s (tentativa ${this.reconnectAttempts})...`);

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private closeSocket(): void {
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close();
        }
      } catch {
        // Ignora erros ao fechar
      }
      this.ws = null;
    }
  }
}
