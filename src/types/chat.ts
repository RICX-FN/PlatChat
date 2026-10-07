export type Platform = 'twitch' | 'youtube' | 'system';

export interface UnifiedChatMessage {
  /** Identificador único da mensagem gerado ou fornecido pela plataforma */
  id: string;
  /** Plataforma de origem da mensagem */
  platform: Platform;
  /** Nome de exibição do autor da mensagem */
  username: string;
  /** URL do avatar do autor (se disponível) */
  avatar?: string;
  /** Texto puro da mensagem */
  message: string;
  /** Timestamp Unix em milissegundos da emissão da mensagem */
  timestamp: number;
  /** Cor do nome do usuário em formato hexadecimal (se disponível) */
  color?: string;
  /** Badges/insígnias do usuário (ex: moderador, subscriber, vip) */
  badges?: string[];
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface PlatformStatus {
  platform: Platform;
  status: ConnectionStatus;
  channel?: string;
  channelAvatar?: string;
  liveTitle?: string;
  isAuthenticated?: boolean;
  hasActiveLive?: boolean;
  error?: string;
}

export interface ClientCommand {
  action: 
    | 'subscribe' 
    | 'unsubscribe' 
    | 'get_history' 
    | 'get_status' 
    | 'test_message'
    | 'detect_youtube_live'
    | 'youtube_logout';
  platform?: Platform;
  channel?: string;
  message?: string;
}

export type ServerEventType = 
  | 'message' 
  | 'batch' 
  | 'history' 
  | 'status_update' 
  | 'system_notification';

export interface ServerEvent<T = unknown> {
  type: ServerEventType;
  data: T;
}
