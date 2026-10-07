import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // timestamp em ms
  channelId?: string;
  channelTitle?: string;
  channelAvatar?: string;
}

export class YouTubeAuthService extends EventEmitter {
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;
  private tokenFilePath: string;
  private tokens: StoredTokens | null = null;

  constructor() {
    super();
    this.clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
    this.clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
    this.redirectUri = (process.env.GOOGLE_REDIRECT_URI || `http://localhost:${process.env.PORT || '3000'}/auth/google/callback`).trim();

    // Diretório persistente para salvar tokens
    const dataDir = path.resolve(__dirname, '../../../data');
    if (!fs.existsSync(dataDir)) {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
      } catch (err) {
        console.error('[YouTubeAuth] Não foi possível criar diretório data:', err);
      }
    }
    this.tokenFilePath = path.join(dataDir, 'youtube-tokens.json');

    this.loadTokensFromDisk();
  }

  public isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  public isAuthenticated(): boolean {
    return Boolean(this.tokens?.refreshToken);
  }

  public getChannelProfile(): { channelTitle?: string; channelAvatar?: string; channelId?: string } | null {
    if (!this.tokens) return null;
    return {
      channelTitle: this.tokens.channelTitle,
      channelAvatar: this.tokens.channelAvatar,
      channelId: this.tokens.channelId
    };
  }

  /**
   * Gera o URL de autorização OAuth 2.0 do Google.
   */
  public getAuthUrl(): string {
    if (!this.isConfigured()) {
      throw new Error(
        'GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET não estão configurados no arquivo .env. ' +
        'Crie credenciais OAuth 2.0 no Google Cloud Console com o redirect URI: ' + this.redirectUri
      );
    }

    const scope = 'https://www.googleapis.com/auth/youtube.readonly';
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope,
      access_type: 'offline', // Necessário para receber refresh_token
      prompt: 'consent'       // Força a emissão de novo refresh_token mesmo se já autorizado
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  /**
   * Troca o código de autorização pelo Access Token e Refresh Token
   */
  public async handleCallback(code: string): Promise<StoredTokens> {
    if (!this.isConfigured()) {
      throw new Error('Credenciais OAuth do Google não configuradas no servidor.');
    }

    const tokenUrl = 'https://oauth2.googleapis.com/token';
    const bodyParams = new URLSearchParams({
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
      grant_type: 'authorization_code'
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: bodyParams.toString()
    });

    const data = await response.json() as any;

    if (!response.ok || data.error) {
      const errorMsg = data.error_description || data.error || 'Erro desconhecido ao trocar código por token';
      console.error('[YouTubeAuth] Erro ao trocar token OAuth:', data);
      throw new Error(`Falha no OAuth do Google: ${errorMsg}`);
    }

    const accessToken = data.access_token;
    // O refresh token vem na primeira autorização ou quando prompt=consent
    const refreshToken = data.refresh_token || this.tokens?.refreshToken;

    if (!refreshToken) {
      throw new Error('Google não retornou um refresh_token válido. Certifique-se de autorizar novamente.');
    }

    const expiresIn = Number(data.expires_in) || 3600;
    const expiresAt = Date.now() + (expiresIn * 1000) - (60 * 1000); // 1 minuto de margem de segurança

    // Buscar perfil do canal do YouTube autenticado
    const profile = await this.fetchChannelProfile(accessToken);

    this.tokens = {
      accessToken,
      refreshToken,
      expiresAt,
      channelId: profile.channelId,
      channelTitle: profile.channelTitle,
      channelAvatar: profile.channelAvatar
    };

    this.saveTokensToDisk();
    this.emit('authenticated', this.tokens);

    console.log(`[YouTubeAuth] Autenticado com sucesso no canal: "${this.tokens.channelTitle}"`);
    return this.tokens;
  }

  /**
   * Retorna um Access Token válido. Se expirado, renova automaticamente via Refresh Token.
   */
  public async getValidAccessToken(): Promise<string> {
    if (!this.tokens || !this.tokens.refreshToken) {
      throw new Error('Usuário não autenticado no YouTube. Realize o login via Google OAuth.');
    }

    // Se o token ainda é válido, retorna imediatamente
    if (Date.now() < this.tokens.expiresAt && this.tokens.accessToken) {
      return this.tokens.accessToken;
    }

    console.log('[YouTubeAuth] Access token expirado. Renovando via refresh_token...');
    const tokenUrl = 'https://oauth2.googleapis.com/token';
    const bodyParams = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.tokens.refreshToken,
      grant_type: 'refresh_token'
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: bodyParams.toString()
    });

    const data = await response.json() as any;

    if (!response.ok || data.error) {
      console.error('[YouTubeAuth] Falha ao renovar token:', data);
      throw new Error(`Falha ao renovar token do YouTube: ${data.error_description || data.error}`);
    }

    this.tokens.accessToken = data.access_token;
    const expiresIn = Number(data.expires_in) || 3600;
    this.tokens.expiresAt = Date.now() + (expiresIn * 1000) - (60 * 1000);

    // Se o Google enviar um novo refresh_token, atualizamos
    if (data.refresh_token) {
      this.tokens.refreshToken = data.refresh_token;
    }

    this.saveTokensToDisk();
    console.log('[YouTubeAuth] Token renovado com sucesso.');
    return this.tokens.accessToken;
  }

  public logout(): void {
    this.tokens = null;
    try {
      if (fs.existsSync(this.tokenFilePath)) {
        fs.unlinkSync(this.tokenFilePath);
      }
    } catch (err) {
      console.warn('[YouTubeAuth] Falha ao remover arquivo de tokens:', err);
    }
    console.log('[YouTubeAuth] Sessão do YouTube encerrada.');
    this.emit('logout');
  }

  private async fetchChannelProfile(accessToken: string): Promise<{ channelId?: string; channelTitle?: string; channelAvatar?: string }> {
    try {
      const url = 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true';
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      });
      const data = await res.json() as any;

      const item = data.items?.[0];
      if (item) {
        return {
          channelId: item.id,
          channelTitle: item.snippet?.title || 'Meu Canal',
          channelAvatar: item.snippet?.thumbnails?.default?.url || item.snippet?.thumbnails?.medium?.url
        };
      }
    } catch (err: any) {
      console.warn(`[YouTubeAuth] Não foi possível obter detalhes do canal: ${err.message}`);
    }

    return { channelTitle: 'Canal do YouTube' };
  }

  private loadTokensFromDisk(): void {
    try {
      if (fs.existsSync(this.tokenFilePath)) {
        const raw = fs.readFileSync(this.tokenFilePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed.refreshToken) {
          this.tokens = parsed;
          console.log(`[YouTubeAuth] Sessão persistida carregada para o canal: "${this.tokens?.channelTitle || 'YouTube'}"`);
        }
      }
    } catch (err) {
      console.warn('[YouTubeAuth] Erro ao carregar tokens salvos do disco:', err);
      this.tokens = null;
    }
  }

  private saveTokensToDisk(): void {
    try {
      if (this.tokens) {
        fs.writeFileSync(this.tokenFilePath, JSON.stringify(this.tokens, null, 2), 'utf-8');
      }
    } catch (err) {
      console.error('[YouTubeAuth] Erro ao salvar tokens no disco:', err);
    }
  }
}
