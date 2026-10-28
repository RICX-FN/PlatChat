(() => {
  // Estado da aplicação
  const state = {
    ws: null,
    isConnectedWs: false,
    autoScroll: true,
    unreadWhilePaused: 0,
    pendingPlatforms: new Set(),
    hasAutoCompacted: sessionStorage.getItem('platchat_auto_compacted') === 'true',
    selectedPlan: 'monthly',
    licenseToken: null,
    twitchStatus: { status: 'disconnected', channel: null },
    youtubeStatus: { status: 'disconnected', channel: null, hasActiveLive: false },
    kickStatus: { status: 'disconnected', channel: null },
    tiktokStatus: { status: 'disconnected', channel: null },
    maxDomMessages: 150
  };

  // Elementos do DOM
  const elements = {
    // Header & Status Pills
    twitchStatusPill: document.getElementById('twitch-status-pill'),
    youtubeStatusPill: document.getElementById('youtube-status-pill'),
    kickStatusPill: document.getElementById('kick-status-pill'),
    tiktokStatusPill: document.getElementById('tiktok-status-pill'),
    btnToggleConfig: document.getElementById('btn-toggle-config'),
    btnToggleCompact: document.getElementById('btn-toggle-compact'),
    configDrawer: document.getElementById('config-drawer'),

    // Formulário Twitch
    twitchInput: document.getElementById('twitch-channel-input'),
    btnTwitchConnect: document.getElementById('btn-twitch-connect'),

    // Formulário YouTube Direto (sem autenticação)
    youtubeInput: document.getElementById('youtube-channel-input'),
    btnYoutubeConnect: document.getElementById('btn-youtube-connect'),

    // Formulário Kick
    kickInput: document.getElementById('kick-channel-input'),
    btnKickConnect: document.getElementById('btn-kick-connect'),

    // Formulário TikTok Live
    tiktokInput: document.getElementById('tiktok-channel-input'),
    btnTiktokConnect: document.getElementById('btn-tiktok-connect'),

    // Ferramentas & Simulação
    btnTestTwitch: document.getElementById('btn-test-twitch'),
    btnTestYoutube: document.getElementById('btn-test-youtube'),
    btnTestKick: document.getElementById('btn-test-kick'),
    btnTestTiktok: document.getElementById('btn-test-tiktok'),
    btnClearChat: document.getElementById('btn-clear-chat'),
    btnClearFields: document.getElementById('btn-clear-fields'),

    // Chat
    chatContainer: document.getElementById('chat-container'),
    messagesList: document.getElementById('messages-list'),
    emptyState: document.getElementById('empty-state'),

    // Scroll Pill
    scrollBottomPill: document.getElementById('scroll-bottom-pill'),
    btnScrollBottom: document.getElementById('btn-scroll-bottom'),
    scrollPillText: document.getElementById('scroll-pill-text')
  };

  // Inicialização
  function init() {
    loadSavedSettings();
    setupEventListeners();
    connectWebSocket();
    loadSubscriptionPrice();
    handleCheckoutReturn();
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) handleCheckoutReturn();
    });
    const dockMode = new URLSearchParams(window.location.search).get('dock') === '1'
      || localStorage.getItem('platchat_dock_mode') === 'true';
    setCompactMode(dockMode, false);
    document.getElementById('copyright-year').textContent = new Date().getFullYear();
  }

  function setCompactMode(enabled, persist = true) {
    document.body.classList.toggle('dock-mode', enabled);
    elements.btnToggleCompact.setAttribute('aria-pressed', String(enabled));
    elements.btnToggleCompact.setAttribute('aria-label', enabled ? 'Mostrar página completa' : 'Ativar modo compacto');
    elements.btnToggleCompact.title = enabled ? 'Mostrar página completa' : 'Ativar modo compacto';
    elements.btnToggleCompact.textContent = enabled ? '⤡' : '⤢';
    if (persist) localStorage.setItem('platchat_dock_mode', String(enabled));
  }

  async function loadSubscriptionPrice() {
    try {
      const response = await fetch('/api/stripe/price');
      if (!response.ok) return;
      const price = await response.json();
      const formatPrice = (plan) => {
        const formatter = new Intl.NumberFormat('pt-BR', {
          style: 'currency',
          currency: plan.currency.toUpperCase()
        });
        const amount = formatter.format(plan.amount / (10 ** formatter.resolvedOptions().maximumFractionDigits));
        const intervals = { day: 'dia', week: 'semana', month: 'mês', year: 'ano' };
        const interval = intervals[plan.interval] || plan.interval;
        const pluralInterval = interval === 'mês' ? 'meses' : `${interval}s`;
        const cadence = plan.interval_count > 1 ? `a cada ${plan.interval_count} ${pluralInterval}` : `/${interval}`;
        return `${amount}${cadence}`;
      };
      const monthlyPrice = formatPrice(price);
      document.getElementById('subscription-price').textContent = monthlyPrice;
      document.getElementById('monthly-plan-price').textContent = monthlyPrice;
      if (price.annual) {
        document.getElementById('annual-plan-price').textContent = formatPrice(price.annual);
      } else {
        document.getElementById('annual-plan-price').textContent = 'Configure o preço no Stripe';
      }
    } catch (error) {
      console.error('[PlatChat] Não foi possível carregar o preço da assinatura:', error);
    }
  }

  async function startCheckout() {
    const buttons = [document.getElementById('btn-subscribe'), document.getElementById('btn-subscribe-banner')];
    buttons.forEach((button) => { button.disabled = true; });
    try {
      const response = await fetch(`/api/stripe/create-checkout-session?plan=${state.selectedPlan}`, { method: 'POST' });
      const result = await response.json();
      if (!response.ok || !result.url) {
        const planName = state.selectedPlan === 'annual' ? 'anual' : 'mensal';
        throw new Error(result.error || `Não foi possível abrir o checkout do plano ${planName}.`);
      }
      window.location.assign(result.url);
    } catch (error) {
      console.error('[PlatChat] Falha ao iniciar checkout:', error);
      alert(error.message || 'Não foi possível iniciar o checkout. Tente novamente.');
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  function updateSubscriptionUI(license) {
    const active = Boolean(license && ['trialing', 'active'].includes(license.license_status));
    const subscribeButton = document.getElementById('btn-subscribe');
    const subscribeBannerButton = document.getElementById('btn-subscribe-banner');
    const premiumStatus = document.getElementById('premium-status');
    const trialBanner = document.querySelector('.trial-banner');
    const premiumBanner = document.getElementById('premium-banner');
    const pricingNote = document.querySelector('.pricing-note');

    subscribeButton.classList.toggle('hidden', active);
    subscribeBannerButton.classList.toggle('hidden', active);
    premiumStatus.classList.toggle('hidden', !active);
    trialBanner.classList.toggle('hidden', active);
    premiumBanner.classList.toggle('hidden', !active);
    pricingNote.classList.toggle('hidden', active);

    if (!active) return;

    const expiration = new Date(license.expira_em);
    const dateText = Number.isNaN(expiration.getTime())
      ? 'Data de renovação não disponível'
      : `${license.trial?.active ? 'Teste grátis até' : 'Acesso até'} ${expiration.toLocaleDateString('pt-BR', { dateStyle: 'long' })}`;
    document.getElementById('premium-expiration').textContent = dateText;
    document.getElementById('premium-banner-expiration').textContent = dateText;
    const cancellationScheduled = license.cancel_at_period_end === true;
    const statusLabel = cancellationScheduled ? 'Cancelamento agendado' : 'Plano ativo · Premium';
    document.getElementById('premium-status-label').textContent = statusLabel;
    document.getElementById('premium-banner-label').textContent = statusLabel;
    if (cancellationScheduled) {
      const accessDate = Number.isNaN(expiration.getTime())
        ? ''
        : ` · acesso até ${expiration.toLocaleDateString('pt-BR', { dateStyle: 'long' })}`;
      const cancellationDate = license.cancel_at ? new Date(license.cancel_at) : expiration;
      const formattedCancellationDate = Number.isNaN(cancellationDate.getTime())
        ? ''
        : ` ${cancellationDate.toLocaleDateString('pt-BR', { dateStyle: 'long' })}`;
      const cancellationText = `Cancelamento agendado para${formattedCancellationDate}${accessDate}`;
      document.getElementById('premium-expiration').textContent = cancellationText;
      document.getElementById('premium-banner-expiration').textContent = cancellationText;
    }
  }

  async function openCustomerPortal() {
    const buttons = [
      document.getElementById('btn-customer-portal'),
      document.getElementById('btn-customer-portal-banner')
    ];
    buttons.forEach((button) => { button.disabled = true; });

    try {
      const response = await fetch('/api/stripe/customer-portal', {
        method: 'POST',
        headers: { Authorization: `Bearer ${state.licenseToken}` }
      });
      const result = await response.json();
      if (!response.ok || !result.url) {
        throw new Error(result.error || 'Não foi possível abrir o portal da assinatura.');
      }
      const portalUrl = new URL(result.url);
      if (portalUrl.protocol !== 'https:') throw new Error('O Stripe retornou um endereço de portal inválido.');
      window.location.assign(portalUrl.href);
    } catch (error) {
      console.error('[PlatChat] Falha ao abrir portal de assinatura:', error);
      alert(error.message || 'Não foi possível abrir o portal da assinatura. Tente novamente.');
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  async function handleCheckoutReturn() {
    const currentUrl = new URL(window.location.href);
    const sessionId = currentUrl.searchParams.get('session_id');
    if (sessionId) {
      currentUrl.searchParams.delete('session_id');
      window.history.replaceState({}, '', currentUrl);
    }

    const savedToken = localStorage.getItem('platchat_token')
      || localStorage.getItem('platchat_license_token');
    const token = savedToken;
    if (!sessionId && !token) {
      updateSubscriptionUI(null);
      return;
    }

    try {
      let response;
      for (let attempt = 0; attempt < (sessionId ? 5 : 1); attempt++) {
        const url = sessionId
          ? `/api/stripe/verify-license?session_id=${encodeURIComponent(sessionId)}`
          : '/api/stripe/verify-license';
        response = await fetch(url, {
          headers: token && !sessionId ? { Authorization: `Bearer ${token}` } : {}
        });
        if (response.ok || response.status !== 401 || attempt === 4) break;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }

      const result = await response.json();
      if (!response.ok || !result.valid || !result.token) {
        if (response.status === 401 || response.status === 403) {
          localStorage.removeItem('platchat_token');
          localStorage.removeItem('platchat_license_token');
          state.licenseToken = null;
          updateSubscriptionUI(null);
          return;
        }
        throw new Error(result.error || 'Não foi possível validar a licença.');
      }
      state.licenseToken = result.token;
      localStorage.setItem('platchat_token', result.token);
      localStorage.removeItem('platchat_license_token');
      updateSubscriptionUI(result.license);
    } catch (error) {
      console.error('[PlatChat] Falha ao verificar licença:', error);
      if (sessionId) alert('Pagamento recebido, mas a licença ainda está sendo preparada. Atualize esta página em instantes.');
    }
  }

  // Carrega preferências salvas no localStorage
  function loadSavedSettings() {
    const savedTwitch = getSavedChannel('platchat_twitch_channel');
    if (savedTwitch && elements.twitchInput) elements.twitchInput.value = savedTwitch;

    const savedYouTube = getSavedChannel('platchat_youtube_channel');
    if (savedYouTube && elements.youtubeInput) elements.youtubeInput.value = savedYouTube;

    const savedKick = getSavedChannel('platchat_kick_channel');
    if (savedKick && elements.kickInput) elements.kickInput.value = savedKick;

    const savedTikTok = getSavedChannel('platchat_tiktok_channel');
    if (savedTikTok && elements.tiktokInput) elements.tiktokInput.value = savedTikTok;
  }

  function getSavedChannel(storageKey) {
    const channel = sessionStorage.getItem(storageKey);
    if (channel) return channel;

    const legacyChannel = localStorage.getItem(storageKey);
    if (legacyChannel) {
      sessionStorage.setItem(storageKey, legacyChannel);
      localStorage.removeItem(storageKey);
      return legacyChannel;
    }

    return null;
  }

  // Gerenciamento da conexão WebSocket
  function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    state.ws = new WebSocket(wsUrl);

    state.ws.onopen = () => {
      state.isConnectedWs = true;
      console.log('[PlatChat Client] Conectado ao servidor WebSocket');
      restoreSavedConnections();
    };

    state.ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        handleServerEvent(payload);
      } catch (err) {
        console.error('[PlatChat Client] Erro ao decodificar mensagem do servidor:', err);
      }
    };

    state.ws.onclose = () => {
      state.isConnectedWs = false;
      console.warn('[PlatChat Client] WebSocket desconectado. Reconectando em 3s...');
      setTimeout(connectWebSocket, 3000);
    };

    state.ws.onerror = (err) => {
      console.error('[PlatChat Client] Erro no WebSocket:', err);
    };
  }

  function sendCommand(command) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(command));
    } else {
      console.warn('[PlatChat Client] WebSocket não está pronto para enviar comando.');
    }
  }

  function restoreSavedConnections() {
    const savedChannels = [
      ['twitch', 'platchat_twitch_channel'],
      ['youtube', 'platchat_youtube_channel'],
      ['kick', 'platchat_kick_channel'],
      ['tiktok', 'platchat_tiktok_channel']
    ];

    for (const [platform, storageKey] of savedChannels) {
      const channel = sessionStorage.getItem(storageKey);
      if (!channel) continue;
      state.pendingPlatforms.add(platform);
      sendCommand({ action: 'subscribe', platform, channel });
    }
  }

  // Processa eventos enviados pelo backend
  function handleServerEvent(event) {
    switch (event.type) {
      case 'status_update':
        updatePlatformStatuses(event.data);
        break;

      case 'message':
        renderMessage(event.data);
        break;

      case 'batch':
        if (Array.isArray(event.data)) {
          for (const msg of event.data) {
            renderMessage(msg);
          }
        }
        break;

      case 'history':
        if (Array.isArray(event.data) && event.data.length > 0) {
          elements.messagesList.innerHTML = '';
          for (const msg of event.data) {
            renderMessage(msg, false);
          }
          scrollToBottom(true);
        }
        break;

      default:
        break;
    }
  }

  // Atualiza indicadores visuais de status para todas as plataformas
  function updatePlatformStatuses(statuses) {
    if (!statuses) return;

    if (statuses.twitch) {
      state.twitchStatus = statuses.twitch;
      renderTwitchStatus(statuses.twitch);
    }

    if (statuses.youtube) {
      state.youtubeStatus = statuses.youtube;
      renderYouTubeStatus(statuses.youtube);
    }

    if (statuses.kick) {
      state.kickStatus = statuses.kick;
      renderKickStatus(statuses.kick);
    }

    if (statuses.tiktok) {
      state.tiktokStatus = statuses.tiktok;
      renderTikTokStatus(statuses.tiktok);
    }

    const hasConnectedPlatform = [statuses.twitch, statuses.youtube, statuses.kick, statuses.tiktok]
      .some((status) => status?.status === 'connected');
    for (const platform of state.pendingPlatforms) {
      const status = statuses[platform];
      if (status?.status === 'connected' || status?.status === 'error') {
        state.pendingPlatforms.delete(platform);
      }
    }

    if (hasConnectedPlatform && !state.hasAutoCompacted) {
      state.hasAutoCompacted = true;
      sessionStorage.setItem('platchat_auto_compacted', 'true');
      setCompactMode(true);
    }
  }

  // Status Twitch
  function renderTwitchStatus(statusObj) {
    const pill = elements.twitchStatusPill;
    const btn = elements.btnTwitchConnect;
    pill.className = `badge-status status-${statusObj.status}`;
    const textSpan = pill.querySelector('.status-text');

    if (statusObj.status === 'connected') {
      textSpan.textContent = statusObj.channel ? `Twitch: #${statusObj.channel}` : 'Twitch';
      btn.textContent = 'Desconectar';
      btn.classList.add('btn-disconnect');
    } else if (statusObj.status === 'connecting') {
      textSpan.textContent = 'Twitch (...)';
      btn.textContent = 'Conectando...';
      btn.classList.remove('btn-disconnect');
    } else if (statusObj.status === 'error') {
      textSpan.textContent = 'Twitch (Erro)';
      btn.textContent = 'Reconectar';
      btn.classList.remove('btn-disconnect');
    } else {
      textSpan.textContent = 'Twitch';
      btn.textContent = 'Conectar';
      btn.classList.remove('btn-disconnect');
    }

    pill.title = statusObj.error ? `Twitch: ${statusObj.error}` : `Twitch: ${statusObj.status}`;
  }

  // Status YouTube público
  function renderYouTubeStatus(statusObj) {
    const pill = elements.youtubeStatusPill;
    const btnDirect = elements.btnYoutubeConnect;
    const textSpan = pill.querySelector('.status-text');

    pill.className = `badge-status status-${statusObj.status}`;

    // Atualiza botão de conexão direta
    if (statusObj.status === 'connected') {
      textSpan.textContent = statusObj.channel ? `YT: ${statusObj.channel}` : 'YouTube: Live';
      btnDirect.textContent = 'Desconectar';
      btnDirect.classList.add('btn-disconnect');
    } else if (statusObj.status === 'connecting') {
      textSpan.textContent = 'YouTube (...)';
      btnDirect.textContent = 'Conectando...';
      btnDirect.classList.remove('btn-disconnect');
    } else if (statusObj.status === 'error') {
      textSpan.textContent = 'YouTube (Erro)';
      btnDirect.textContent = 'Reconectar';
      btnDirect.classList.remove('btn-disconnect');
    } else {
      textSpan.textContent = 'YouTube';
      btnDirect.textContent = 'Conectar';
      btnDirect.classList.remove('btn-disconnect');
    }

    pill.title = statusObj.error ? `YouTube: ${statusObj.error}` : `YouTube: ${statusObj.status}`;

  }

  // Status Kick
  function renderKickStatus(statusObj) {
    const pill = elements.kickStatusPill;
    const btn = elements.btnKickConnect;
    pill.className = `badge-status status-${statusObj.status}`;
    const textSpan = pill.querySelector('.status-text');

    if (statusObj.status === 'connected') {
      textSpan.textContent = statusObj.channel ? `Kick: ${statusObj.channel}` : 'Kick: Live';
      btn.textContent = 'Desconectar';
      btn.classList.add('btn-disconnect');
    } else if (statusObj.status === 'connecting') {
      textSpan.textContent = 'Kick (...)';
      btn.textContent = 'Conectando...';
      btn.classList.remove('btn-disconnect');
    } else if (statusObj.status === 'error') {
      textSpan.textContent = 'Kick (Erro)';
      btn.textContent = 'Reconectar';
      btn.classList.remove('btn-disconnect');
    } else {
      textSpan.textContent = 'Kick';
      btn.textContent = 'Conectar';
      btn.classList.remove('btn-disconnect');
    }

    pill.title = statusObj.error ? `Kick: ${statusObj.error}` : `Kick: ${statusObj.status}`;
  }

  // Status TikTok Live
  function renderTikTokStatus(statusObj) {
    const pill = elements.tiktokStatusPill;
    const btn = elements.btnTiktokConnect;
    pill.className = `badge-status status-${statusObj.status}`;
    const textSpan = pill.querySelector('.status-text');

    if (statusObj.status === 'connected') {
      textSpan.textContent = statusObj.channel ? `TikTok: @${statusObj.channel}` : 'TikTok: Live';
      btn.textContent = 'Desconectar';
      btn.classList.add('btn-disconnect');
    } else if (statusObj.status === 'connecting') {
      textSpan.textContent = 'TikTok (...)';
      btn.textContent = 'Conectando...';
      btn.classList.remove('btn-disconnect');
    } else if (statusObj.status === 'error') {
      textSpan.textContent = 'TikTok (Erro)';
      btn.textContent = 'Reconectar';
      btn.classList.remove('btn-disconnect');
    } else {
      textSpan.textContent = 'TikTok';
      btn.textContent = 'Conectar';
      btn.classList.remove('btn-disconnect');
    }

    pill.title = statusObj.error ? `TikTok: ${statusObj.error}` : `TikTok: ${statusObj.status}`;
  }

  // Renderiza uma mensagem no chat
  function renderMessage(msg, shouldHandleScroll = true) {
    if (elements.emptyState && elements.emptyState.parentElement) {
      elements.emptyState.remove();
    }

    const item = document.createElement('div');
    item.className = `chat-message platform-${msg.platform}`;
    item.id = `msg-${msg.id}`;

    const timeFormatted = formatTime(msg.timestamp);
    const userColorStyle = msg.color ? `color: ${escapeHtml(msg.color)};` : '';

    let avatarHtml = '';
    if (msg.avatar) {
      avatarHtml = `<img class="msg-avatar" src="${escapeHtml(msg.avatar)}" alt="" loading="lazy" onerror="this.style.display='none';">`;
    } else {
      const initial = (msg.username || '?').charAt(0).toUpperCase();
      avatarHtml = `<div class="avatar-fallback">${initial}</div>`;
    }

    let badgesHtml = '';
    if (Array.isArray(msg.badges)) {
      badgesHtml = msg.badges.map(b => `<span class="badge-tag">${escapeHtml(b)}</span>`).join('');
    }

    item.innerHTML = `
      ${avatarHtml}
      <div class="msg-body">
        <div class="msg-header">
          <span class="msg-time">${timeFormatted}</span>
          <span class="platform-pill">${escapeHtml(msg.platform)}</span>
          ${badgesHtml}
          <span class="msg-username" style="${userColorStyle}">${escapeHtml(msg.username)}:</span>
        </div>
        <div class="msg-text">${escapeHtml(msg.message)}</div>
      </div>
    `;

    elements.messagesList.appendChild(item);

    // Limita número de elementos no DOM para fluidez no OBS
    while (elements.messagesList.children.length > state.maxDomMessages) {
      elements.messagesList.removeChild(elements.messagesList.firstElementChild);
    }

    if (shouldHandleScroll) {
      if (state.autoScroll) {
        scrollToBottom();
      } else {
        state.unreadWhilePaused++;
        updateScrollPill();
      }
    }
  }

  // Rolagem e Auto-Scroll
  function isUserNearBottom() {
    const threshold = 70;
    const position = elements.chatContainer.scrollHeight - elements.chatContainer.scrollTop - elements.chatContainer.clientHeight;
    return position <= threshold;
  }

  function scrollToBottom(instant = false) {
    elements.chatContainer.scrollTo({
      top: elements.chatContainer.scrollHeight,
      behavior: instant ? 'auto' : 'smooth'
    });
    state.autoScroll = true;
    state.unreadWhilePaused = 0;
    elements.scrollBottomPill.classList.add('hidden');
  }

  function updateScrollPill() {
    elements.scrollPillText.textContent = `Novas mensagens (+${state.unreadWhilePaused})`;
    elements.scrollBottomPill.classList.remove('hidden');
  }

  // Event Listeners
  function setupEventListeners() {
    document.getElementById('btn-subscribe').addEventListener('click', startCheckout);
    document.getElementById('btn-subscribe-banner').addEventListener('click', startCheckout);
    document.getElementById('btn-customer-portal').addEventListener('click', openCustomerPortal);
    document.getElementById('btn-customer-portal-banner').addEventListener('click', openCustomerPortal);
    document.getElementById('plan-monthly').addEventListener('click', () => selectPlan('monthly'));
    document.getElementById('plan-annual').addEventListener('click', () => selectPlan('annual'));

    elements.btnToggleCompact.addEventListener('click', () => {
      setCompactMode(!document.body.classList.contains('dock-mode'));
    });

    // Toggle Painel de Configurações
    elements.btnToggleConfig.addEventListener('click', () => {
      elements.configDrawer.classList.toggle('open');
    });

    // --- Twitch ---
    elements.btnTwitchConnect.addEventListener('click', () => {
      const channel = elements.twitchInput.value.trim();
      if (!channel) return;

      if (state.twitchStatus.status === 'connected') {
        sendCommand({ action: 'unsubscribe', platform: 'twitch' });
        sessionStorage.removeItem('platchat_twitch_channel');
        state.pendingPlatforms.delete('twitch');
      } else {
        sessionStorage.setItem('platchat_twitch_channel', channel);
        state.pendingPlatforms.add('twitch');
        sendCommand({ action: 'subscribe', platform: 'twitch', channel });
      }
    });

    elements.twitchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') elements.btnTwitchConnect.click();
    });

    // --- YouTube Direto ---
    elements.btnYoutubeConnect.addEventListener('click', () => {
      const channel = elements.youtubeInput.value.trim();
      if (!channel) return;

      if (state.youtubeStatus.status === 'connected') {
        sendCommand({ action: 'unsubscribe', platform: 'youtube' });
        sessionStorage.removeItem('platchat_youtube_channel');
        state.pendingPlatforms.delete('youtube');
      } else {
        sessionStorage.setItem('platchat_youtube_channel', channel);
        state.pendingPlatforms.add('youtube');
        sendCommand({ action: 'subscribe', platform: 'youtube', channel });
      }
    });

    elements.youtubeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') elements.btnYoutubeConnect.click();
    });

    // --- Kick ---
    elements.btnKickConnect.addEventListener('click', () => {
      const channel = elements.kickInput.value.trim();
      if (!channel) return;

      if (state.kickStatus.status === 'connected') {
        sendCommand({ action: 'unsubscribe', platform: 'kick' });
        sessionStorage.removeItem('platchat_kick_channel');
        state.pendingPlatforms.delete('kick');
      } else {
        sessionStorage.setItem('platchat_kick_channel', channel);
        state.pendingPlatforms.add('kick');
        sendCommand({ action: 'subscribe', platform: 'kick', channel });
      }
    });

    elements.kickInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') elements.btnKickConnect.click();
    });

    // --- TikTok Live ---
    elements.btnTiktokConnect.addEventListener('click', () => {
      const channel = elements.tiktokInput.value.trim();
      if (!channel) return;

      if (state.tiktokStatus.status === 'connected') {
        sendCommand({ action: 'unsubscribe', platform: 'tiktok' });
        sessionStorage.removeItem('platchat_tiktok_channel');
        state.pendingPlatforms.delete('tiktok');
      } else {
        sessionStorage.setItem('platchat_tiktok_channel', channel);
        state.pendingPlatforms.add('tiktok');
        sendCommand({ action: 'subscribe', platform: 'tiktok', channel });
      }
    });

    elements.tiktokInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') elements.btnTiktokConnect.click();
    });

    // --- Botões de Simulação para Teste ---
    elements.btnTestTwitch.addEventListener('click', () => {
      sendCommand({ action: 'test_message', platform: 'twitch' });
    });

    elements.btnTestYoutube.addEventListener('click', () => {
      sendCommand({ action: 'test_message', platform: 'youtube' });
    });

    elements.btnTestKick.addEventListener('click', () => {
      sendCommand({ action: 'test_message', platform: 'kick' });
    });

    elements.btnTestTiktok.addEventListener('click', () => {
      sendCommand({ action: 'test_message', platform: 'tiktok' });
    });

    // Limpar Chat
    elements.btnClearChat.addEventListener('click', () => {
      elements.messagesList.innerHTML = '';
      state.unreadWhilePaused = 0;
      elements.scrollBottomPill.classList.add('hidden');
    });

    elements.btnClearFields.addEventListener('click', clearChannelFields);

    // Botão Flutuante de Scroll
    elements.btnScrollBottom.addEventListener('click', () => {
      scrollToBottom();
    });

    // Detecção de Rolagem Manual pelo Usuário
    elements.chatContainer.addEventListener('scroll', () => {
      if (isUserNearBottom()) {
        state.autoScroll = true;
        state.unreadWhilePaused = 0;
        elements.scrollBottomPill.classList.add('hidden');
      } else {
        state.autoScroll = false;
      }
    });
  }

  function selectPlan(plan) {
    state.selectedPlan = plan;
    for (const option of ['monthly', 'annual']) {
      const selected = option === plan;
      const button = document.getElementById(`plan-${option}`);
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
    const label = plan === 'annual' ? 'Assinar plano anual' : 'Assinar plano mensal';
    for (const button of [document.getElementById('btn-subscribe'), document.getElementById('btn-subscribe-banner')]) {
      button.firstChild.textContent = `${label} `;
    }
  }

  function clearChannelFields() {
    const channels = [
      ['twitch', elements.twitchInput, 'platchat_twitch_channel'],
      ['youtube', elements.youtubeInput, 'platchat_youtube_channel'],
      ['kick', elements.kickInput, 'platchat_kick_channel'],
      ['tiktok', elements.tiktokInput, 'platchat_tiktok_channel']
    ];

    for (const [platform, input, storageKey] of channels) {
      input.value = '';
      sessionStorage.removeItem(storageKey);
      state.pendingPlatforms.delete(platform);
      sendCommand({ action: 'unsubscribe', platform });
    }
  }

  // Utilitários
  function formatTime(timestamp) {
    const date = new Date(timestamp);
    const h = String(date.getHours()).padStart(2, '0');
    const m = String(date.getMinutes()).padStart(2, '0');
    const s = String(date.getSeconds()).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  init();
})();
