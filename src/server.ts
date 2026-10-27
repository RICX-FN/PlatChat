import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import dotenv from 'dotenv';
import Stripe from 'stripe';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { TwitchIrcService } from './services/twitch/twitchIrcService.js';
import { YouTubePublicChatService } from './services/youtube/youtubePublicChatService.js';
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

// Instanciação modular dos serviços das 4 plataformas
const twitchService = new TwitchIrcService();
const youtubePublicService = new YouTubePublicChatService();
const kickService = new KickChatService();
const tiktokService = new TikTokLiveService();
const messageQueue = new MessageQueue({ flushIntervalMs: 50, maxHistorySize: 150 });

// Inicialização do servidor WebSocket unificado
const chatWsServer = new ChatWsServer(
  server, 
  twitchService, 
  youtubePublicService,
  kickService,
  tiktokService,
  messageQueue
);

app.get('/', (_req, res) => {
  res.sendFile(path.resolve(publicDir, 'index.html'));
});

app.get('/privacy', (_req, res) => {
  res.sendFile(path.resolve(publicDir, 'privacy.html'));
});

app.get('/terms', (_req, res) => {
  res.sendFile(path.resolve(publicDir, 'terms.html'));
});

const getStripe = (): Stripe => {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY is not configured');
  return new Stripe(secretKey);
};

const getJwtSecret = (): string => {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be configured with at least 32 characters');
  }
  return secret;
};

const createLicenseToken = (subscription: Stripe.Subscription, status = subscription.status): string => {
  const now = Math.floor(Date.now() / 1000);
  const currentPeriodEnd = subscription.items.data.reduce(
    (latest, item) => Math.max(latest, item.current_period_end),
    0
  );
  const expiration = status === 'canceled'
    ? now + 60
    : currentPeriodEnd || subscription.trial_end || now + 60;
  const trialStart = subscription.trial_start;
  const trialEnd = subscription.trial_end;
  const payload = {
    license_status: status,
    subscription_id: subscription.id,
    customer_id: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id,
    trial: {
      active: status === 'trialing',
      starts_at: trialStart ? new Date(trialStart * 1000).toISOString() : null,
      ends_at: trialEnd ? new Date(trialEnd * 1000).toISOString() : null,
      period_days: 7
    },
    expira_em: new Date(expiration * 1000).toISOString(),
    exp: expiration
  };
  return jwt.sign(payload, getJwtSecret(), { algorithm: 'HS256', noTimestamp: true });
};

const persistSubscriptionLicense = async (
  subscription: Stripe.Subscription,
  checkoutSessionId?: string
): Promise<string> => {
  const token = createLicenseToken(subscription);
  const sessionId = checkoutSessionId || subscription.metadata.checkout_session_id;
  await getStripe().subscriptions.update(subscription.id, {
    metadata: {
      ...subscription.metadata,
      ...(sessionId ? { checkout_session_id: sessionId } : {}),
      license_token: token
    }
  });
  if (sessionId) {
    await getStripe().checkout.sessions.update(sessionId, {
      metadata: { license_token: token }
    });
  }
  return token;
};

app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret || !process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Stripe webhook is not configured' });
  }

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(req.body, req.headers['stripe-signature'] || '', webhookSecret);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid webhook signature';
    console.error(`[Stripe] Webhook signature verification failed: ${message}`);
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
      if (!subscriptionId) throw new Error(`Checkout session ${session.id} has no subscription`);
      const subscription = await getStripe().subscriptions.retrieve(subscriptionId);
      await persistSubscriptionLicense(subscription, session.id);
    } else if (event.type === 'customer.subscription.updated') {
      await persistSubscriptionLicense(event.data.object as Stripe.Subscription);
    } else if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object as Stripe.Subscription;
      const sessionId = subscription.metadata.checkout_session_id;
      if (sessionId) {
        await getStripe().checkout.sessions.update(sessionId, {
          metadata: { license_token: createLicenseToken(subscription, 'canceled') }
        });
      }
    }
    return res.json({ received: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not process Stripe event';
    console.error(`[Stripe] Webhook processing failed (${event.type}): ${message}`);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

app.use(express.json());

app.get('/api/stripe/price', async (_req, res) => {
  try {
    const priceId = process.env.STRIPE_PRICE_ID;
    if (!priceId) throw new Error('STRIPE_PRICE_ID is not configured');
    const price = await getStripe().prices.retrieve(priceId);
    if (price.recurring?.interval !== 'month' || price.recurring.interval_count !== 1) {
      throw new Error('Configured Stripe price must be billed monthly');
    }
    if (price.unit_amount === null) throw new Error('Configured Stripe price has no fixed amount');
    return res.json({
      amount: price.unit_amount,
      currency: price.currency,
      interval: price.recurring?.interval,
      interval_count: price.recurring?.interval_count
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Stripe price is unavailable';
    console.error(`[Stripe] Could not load subscription price: ${message}`);
    return res.status(503).json({ error: 'Subscription pricing is temporarily unavailable' });
  }
});

app.post('/api/stripe/create-checkout-session', async (_req, res) => {
  const missingConfig = ['STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID', 'CLIENT_URL']
    .filter((name) => !process.env[name]);
  if (missingConfig.length) {
    console.error(`[Stripe] Checkout configuration missing: ${missingConfig.join(', ')}`);
    return res.status(503).json({
      error: `Checkout indisponível: configure ${missingConfig.join(', ')} no ambiente do servidor.`
    });
  }

  try {
    const priceId = process.env.STRIPE_PRICE_ID;
    const clientUrl = process.env.CLIENT_URL;
    if (!priceId || !clientUrl) throw new Error('Stripe checkout configuration is incomplete');
    const session = await getStripe().checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: { trial_period_days: 7 },
      success_url: `${clientUrl.replace(/\/$/, '')}/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${clientUrl.replace(/\/$/, '')}/?checkout=cancelled`
    });
    return res.json({ url: session.url });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Checkout could not be created';
    console.error(`[Stripe] Checkout creation failed: ${message}`);
    return res.status(503).json({ error: 'Checkout is temporarily unavailable' });
  }
});

app.get('/api/stripe/verify-license', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    let token = req.header('authorization')?.replace(/^Bearer\s+/i, '');
    const sessionId = req.query.session_id;
    if (!token && typeof sessionId === 'string') {
      const session = await getStripe().checkout.sessions.retrieve(sessionId);
      token = session.metadata?.license_token;
    }
    if (!token) return res.status(401).json({ valid: false, error: 'License token is required' });

    const claims = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] }) as JwtPayload;
    if (!['trialing', 'active'].includes(String(claims.license_status))) {
      return res.status(403).json({ valid: false, error: 'License is not active' });
    }
    return res.json({ valid: true, license: claims, token });
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
      return res.status(401).json({ valid: false, error: 'License token is invalid or expired' });
    }
    const message = error instanceof Error ? error.message : 'Could not verify license';
    console.error(`[Stripe] License verification failed: ${message}`);
    return res.status(503).json({ valid: false, error: 'License verification is temporarily unavailable' });
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
  res.json({ success: true, status: youtubePublicService.getStatus() });
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
