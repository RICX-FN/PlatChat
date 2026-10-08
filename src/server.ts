import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import dotenv from 'dotenv';
import { TwitchIrcService } from './services/twitch/twitchIrcService.js';
import { YouTubeAuthService } from './services/youtube/youtubeAuthService.js';
import { YouTubeLiveChatService } from './services/youtube/youtubeLiveChatService.js';
import { MessageQueue } from './services/queue/messageQueue.js';
import { ChatWsServer } from './websocket/wsServer.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

// Configuração de arquivos estáticos para o painel web (OBS Dock)
const publicDir = path.resolve(__dirname, '../public');
app.use(express.static(publicDir));
app.use(express.json());

// Instanciação modular dos serviços
const twitchService = new TwitchIrcService();
const youtubeAuthService = new YouTubeAuthService();
const youtubeLiveChatService = new YouTubeLiveChatService(youtubeAuthService);
const messageQueue = new MessageQueue({ flushIntervalMs: 50, maxHistorySize: 150 });

// Inicialização do servidor WebSocket
const chatWsServer = new ChatWsServer(
  server, 
  twitchService, 
  youtubeLiveChatService, 
  youtubeAuthService, 
  messageQueue
);

/* ==========================================================================
   Rotas de Conformidade Legal & Páginas Institucionais (Google OAuth)
   ========================================================================== */

/**
 * Rota principal que serve a página do PlatChat
 */
app.get('/', (_req, res) => {
  res.sendFile(path.resolve(publicDir, 'index.html'));
});

/**
 * Página de Política de Privacidade do PlatChat (obrigatória para verificação do Google OAuth)
 */
app.get('/privacy', (_req, res) => {
  res.sendFile(path.resolve(publicDir, 'privacy.html'));
});

/**
 * Página de Termos de Serviço do PlatChat (obrigatória para verificação do Google OAuth)
 */
app.get('/terms', (_req, res) => {
  res.sendFile(path.resolve(publicDir, 'terms.html'));
});

/* ==========================================================================
   Rotas de Autenticação OAuth 2.0 (Google / YouTube)
   ========================================================================== */

/**
 * Redireciona o streamer para a tela de consentimento do Google
 */
app.get('/auth/google', (_req, res) => {
  try {
    if (!youtubeAuthService.isConfigured()) {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html lang="pt-BR">
        <head>
          <meta charset="UTF-8">
          <title>Configuração Necessária</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #121214; color: #efeff1; padding: 30px; text-align: center; }
            .card { background: #1a1a1e; border: 1px solid #333; border-radius: 8px; max-width: 520px; margin: 40px auto; padding: 24px; text-align: left; }
            code { background: #26262d; color: #ff8080; padding: 2px 6px; border-radius: 4px; }
            h2 { color: #ff5252; margin-top: 0; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>⚠️ Credenciais do Google Não Encontradas</h2>
            <p>Para ativar o Login com Google no YouTube, você precisa definir no seu arquivo <code>.env</code>:</p>
            <pre style="background: #26262d; padding: 12px; border-radius: 6px; font-size: 13px; overflow-x: auto;">GOOGLE_CLIENT_ID=seu_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=seu_client_secret
GOOGLE_REDIRECT_URI=http://localhost:${PORT}/auth/google/callback</pre>
            <p style="font-size: 12px; color: #adadb8;">Crie essas credenciais no Google Cloud Console com o escopo <code>https://www.googleapis.com/auth/youtube.readonly</code>.</p>
          </div>
        </body>
        </html>
      `);
    }

    const authUrl = youtubeAuthService.getAuthUrl();
    res.redirect(authUrl);
  } catch (err: any) {
    res.status(500).send(`Erro ao iniciar autenticação: ${err.message}`);
  }
});

/**
 * Callback onde o Google retorna com ?code=...
 */
app.get('/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.status(400).send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head><meta charset="UTF-8"><title>Erro de Autenticação</title></head>
      <body style="font-family: sans-serif; background: #121214; color: #ff5252; text-align: center; padding: 50px;">
        <h3>Falha na autorização do Google: ${error}</h3>
        <button onclick="window.close()" style="margin-top: 20px; padding: 8px 16px; cursor: pointer;">Fechar Janela</button>
      </body>
      </html>
    `);
  }

  if (!code || typeof code !== 'string') {
    return res.status(400).send('Código de autorização não fornecido.');
  }

  try {
    // Troca código por Access Token e Refresh Token
    await youtubeAuthService.handleCallback(code);

    // Imediatamente busca e inicia a transmissão ao vivo ativa do streamer
    youtubeLiveChatService.detectAndJoinActiveLive().catch((err) => {
      console.warn('[Server] Falha ao tentar conectar live pós-auth:', err.message);
    });

    // Retorna página que notifica o OBS Dock e se auto-fecha
    res.send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <title>Autenticado com Sucesso</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #121214; color: #efeff1; text-align: center; padding: 40px; }
          .box { background: #1a1a1e; border: 1px solid #00e676; border-radius: 8px; padding: 25px; max-width: 400px; margin: 30px auto; }
          h2 { color: #00e676; margin: 0 0 10px; }
        </style>
      </head>
      <body>
        <div class="box">
          <h2>🎉 Conectado ao YouTube!</h2>
          <p>Sua conta do canal foi autenticada.</p>
          <p style="font-size: 12px; color: #aaa;">Esta janela fechará automaticamente...</p>
        </div>
        <script>
          try {
            if (window.opener) {
              window.opener.postMessage({ type: 'YOUTUBE_AUTH_SUCCESS' }, '*');
              setTimeout(() => window.close(), 1200);
            } else {
              setTimeout(() => { window.location.href = '/'; }, 1500);
            }
          } catch(e) {
            setTimeout(() => window.close(), 1500);
          }
        </script>
      </body>
      </html>
    `);
  } catch (err: any) {
    console.error('[OAuth Callback] Erro:', err.message);
    res.status(500).send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head><meta charset="UTF-8"><title>Erro no Login</title></head>
      <body style="font-family: sans-serif; background: #121214; color: #ff5252; text-align: center; padding: 40px;">
        <h3>Erro ao autenticar com o YouTube:</h3>
        <p>${err.message}</p>
        <button onclick="window.close()" style="padding: 8px 16px; cursor: pointer;">Fechar</button>
      </body>
      </html>
    `);
  }
});

/* ==========================================================================
   Endpoints REST de Diagnóstico e Controle
   ========================================================================== */

app.get('/api/status', (_req, res) => {
  res.json({
    uptime: process.uptime(),
    timestamp: Date.now(),
    platforms: chatWsServer.getAllStatuses(),
    youtubeConfigured: youtubeAuthService.isConfigured(),
    messageQueueHistoryCount: messageQueue.getHistory().length
  });
});

app.post('/api/youtube/detect', async (_req, res) => {
  const success = await youtubeLiveChatService.detectAndJoinActiveLive();
  res.json({ success, status: youtubeLiveChatService.getStatus() });
});

app.post('/api/youtube/logout', (_req, res) => {
  youtubeAuthService.logout();
  res.json({ success: true });
});

// Inicialização opcional a partir de variáveis de ambiente
if (process.env.AUTO_CONNECT_TWITCH) {
  console.log(`[AutoConnect] Conectando automaticamente à Twitch: ${process.env.AUTO_CONNECT_TWITCH}`);
  twitchService.joinChannel(process.env.AUTO_CONNECT_TWITCH);
}

// Iniciar servidor HTTP
server.listen(PORT, HOST, () => {
  console.log('====================================================');
  console.log(`🚀 PlatChat Backend iniciado com sucesso!`);
  console.log(`📡 Servidor HTTP & WebSocket: http://localhost:${PORT}`);
  console.log(`🖥️  OBS Custom Browser Dock URL: http://localhost:${PORT}`);
  console.log(`🔐 Google OAuth Callback URI: ${process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`}`);
  console.log('====================================================');
});

// Encerramento gracioso
const shutdown = () => {
  console.log('\n[Server] Encerrando serviços...');
  twitchService.leaveChannel();
  youtubeLiveChatService.leaveLive();
  chatWsServer.close();
  server.close(() => {
    console.log('[Server] Finalizado com sucesso.');
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
