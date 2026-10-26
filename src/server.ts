import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import dotenv from 'dotenv';
import { TwitchIrcService } from './services/twitch/twitchIrcService.js';
import { YouTubePublicChatService } from './services/youtube/youtubePublicChatService.js';
import { YouTubeAuthService } from './services/youtube/youtubeAuthService.js';
import { YouTubeLiveChatService } from './services/youtube/youtubeLiveChatService.js';
import { KickChatService } from './services/kick/kickChatService.js';
import { TikTokLiveService } from './services/tiktok/tiktokLiveService.js';
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

// Instanciação modular dos serviços das 4 plataformas
const twitchService = new TwitchIrcService();
const youtubePublicService = new YouTubePublicChatService();
const youtubeAuthService = new YouTubeAuthService();
const youtubeOAuthService = new YouTubeLiveChatService(youtubeAuthService);
const kickService = new KickChatService();
const tiktokService = new TikTokLiveService();
const messageQueue = new MessageQueue({ flushIntervalMs: 50, maxHistorySize: 150 });

// Inicialização do servidor WebSocket unificado
const chatWsServer = new ChatWsServer(
  server, 
  twitchService, 
  youtubePublicService,
  youtubeOAuthService, 
  youtubeAuthService, 
  kickService,
  tiktokService,
  messageQueue
);

/* ==========================================================================
   Rotas de Conformidade Legal & Páginas Institucionais (Google OAuth)
   ========================================================================== */

app.get('/', (_req, res) => {
  res.sendFile(path.resolve(publicDir, 'index.html'));
});

app.get('/privacy', (_req, res) => {
  res.sendFile(path.resolve(publicDir, 'privacy.html'));
});

app.get('/terms', (_req, res) => {
  res.sendFile(path.resolve(publicDir, 'terms.html'));
});

/* ==========================================================================
   Rotas Opcionais de Autenticação OAuth 2.0 (Google / YouTube)
   ========================================================================== */

app.get('/auth/google', (_req, res) => {
  try {
    if (!youtubeAuthService.isConfigured()) {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html lang="pt-BR">
        <head>
          <meta charset="UTF-8">
          <title>Configuração Google OAuth</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #121214; color: #efeff1; padding: 30px; text-align: center; }
            .card { background: #1a1a1e; border: 1px solid #333; border-radius: 8px; max-width: 520px; margin: 40px auto; padding: 24px; text-align: left; }
            code { background: #26262d; color: #ff8080; padding: 2px 6px; border-radius: 4px; }
            h2 { color: #ff5252; margin-top: 0; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>ℹ️ Modo Direto sem Autenticação Disponível</h2>
            <p>Você pode conectar o YouTube diretamente pelo painel digitando o <code>@canal</code> ou link da live, sem precisar de credenciais Google!</p>
            <p>Se preferir usar OAuth corporativo, configure as variáveis <code>GOOGLE_CLIENT_ID</code> e <code>GOOGLE_CLIENT_SECRET</code> no seu <code>.env</code>.</p>
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
    await youtubeAuthService.handleCallback(code);

    youtubeOAuthService.detectAndJoinActiveLive().catch((err) => {
      console.warn('[Server] Falha ao tentar conectar live pós-auth:', err.message);
    });

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
    youtubeOAuthAvailable: youtubeAuthService.isConfigured(),
    messageQueueHistoryCount: messageQueue.getHistory().length
  });
});

// Controle Twitch
app.post('/api/twitch/connect', (req, res) => {
  const { channel } = req.body;
  if (!channel) return res.status(400).json({ error: 'Parâmetro channel é obrigatório' });
  twitchService.joinChannel(channel);
  res.json({ success: true, status: twitchService.getStatus() });
});

app.post('/api/twitch/disconnect', (_req, res) => {
  twitchService.leaveChannel();
  res.json({ success: true, status: twitchService.getStatus() });
});

// Controle YouTube Público (Direto sem autenticação)
app.post('/api/youtube/connect', async (req, res) => {
  const { channel } = req.body;
  if (!channel) return res.status(400).json({ error: 'Parâmetro channel (@handle, ID ou URL) é obrigatório' });
  const success = await youtubePublicService.joinChannel(channel);
  res.json({ success, status: youtubePublicService.getStatus() });
});

app.post('/api/youtube/disconnect', (_req, res) => {
  youtubePublicService.leaveChannel();
  youtubeOAuthService.leaveLive();
  res.json({ success: true, status: youtubePublicService.getStatus() });
});

// Controle YouTube OAuth
app.post('/api/youtube/detect', async (_req, res) => {
  const success = await youtubeOAuthService.detectAndJoinActiveLive();
  res.json({ success, status: youtubeOAuthService.getStatus() });
});

app.post('/api/youtube/logout', (_req, res) => {
  youtubeAuthService.logout();
  youtubePublicService.leaveChannel();
  res.json({ success: true });
});

// Controle Kick
app.post('/api/kick/connect', async (req, res) => {
  const { channel } = req.body;
  if (!channel) return res.status(400).json({ error: 'Parâmetro channel é obrigatório' });
  const success = await kickService.joinChannel(channel);
  res.json({ success, status: kickService.getStatus() });
});

app.post('/api/kick/disconnect', (_req, res) => {
  kickService.leaveChannel();
  res.json({ success: true, status: kickService.getStatus() });
});

// Controle TikTok Live
app.post('/api/tiktok/connect', async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Parâmetro username é obrigatório' });
  const success = await tiktokService.joinChannel(username);
  res.json({ success, status: tiktokService.getStatus() });
});

app.post('/api/tiktok/disconnect', (_req, res) => {
  tiktokService.leaveChannel();
  res.json({ success: true, status: tiktokService.getStatus() });
});

/* ==========================================================================
   Inicialização Opcional a partir de Variáveis de Ambiente
   ========================================================================== */

if (process.env.AUTO_CONNECT_TWITCH) {
  console.log(`[AutoConnect] Conectando automaticamente à Twitch: ${process.env.AUTO_CONNECT_TWITCH}`);
  twitchService.joinChannel(process.env.AUTO_CONNECT_TWITCH);
}

if (process.env.AUTO_CONNECT_YOUTUBE) {
  console.log(`[AutoConnect] Conectando automaticamente ao YouTube: ${process.env.AUTO_CONNECT_YOUTUBE}`);
  youtubePublicService.joinChannel(process.env.AUTO_CONNECT_YOUTUBE);
}

if (process.env.AUTO_CONNECT_KICK) {
  console.log(`[AutoConnect] Conectando automaticamente à Kick: ${process.env.AUTO_CONNECT_KICK}`);
  kickService.joinChannel(process.env.AUTO_CONNECT_KICK);
}

if (process.env.AUTO_CONNECT_TIKTOK) {
  console.log(`[AutoConnect] Conectando automaticamente ao TikTok Live: ${process.env.AUTO_CONNECT_TIKTOK}`);
  tiktokService.joinChannel(process.env.AUTO_CONNECT_TIKTOK);
}

// Iniciar servidor HTTP
server.listen(PORT, HOST, () => {
  console.log('====================================================');
  console.log(`🚀 PlatChat Backend iniciado com sucesso! (4 Plataformas)`);
  console.log(`📡 Servidor HTTP & WebSocket: http://localhost:${PORT}`);
  console.log(`🖥️  OBS Custom Browser Dock URL: http://localhost:${PORT}`);
  console.log(`🟣 Twitch  |  🔴 YouTube  |  🟢 Kick  |  🎵 TikTok Live`);
  console.log('====================================================');
});

// Encerramento gracioso
const shutdown = () => {
  console.log('\n[Server] Encerrando serviços...');
  twitchService.leaveChannel();
  youtubePublicService.leaveChannel();
  youtubeOAuthService.leaveLive();
  kickService.leaveChannel();
  tiktokService.leaveChannel();
  chatWsServer.close();
  server.close(() => {
    console.log('[Server] Finalizado com sucesso.');
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
