(() => {
  // Estado da aplicação
  const state = {
    ws: null,
    isConnectedWs: false,
    autoScroll: true,
    unreadWhilePaused: 0,
    twitchStatus: { status: 'disconnected', channel: null },
    youtubeStatus: { status: 'disconnected', isAuthenticated: false, hasActiveLive: false },
    maxDomMessages: 200
  };

  // Elementos do DOM
  const elements = {
    // Header & Status
    twitchStatusPill: document.getElementById('twitch-status-pill'),
    youtubeStatusPill: document.getElementById('youtube-status-pill'),
    btnToggleConfig: document.getElementById('btn-toggle-config'),
    configDrawer: document.getElementById('config-drawer'),

    // Formulário Twitch
    twitchInput: document.getElementById('twitch-channel-input'),
    btnTwitchConnect: document.getElementById('btn-twitch-connect'),

    // Formulário YouTube OAuth
    ytUnauthBox: document.getElementById('yt-unauth-box'),
    ytAuthBox: document.getElementById('yt-auth-box'),
    btnGoogleLogin: document.getElementById('btn-google-login'),
    ytChannelAvatar: document.getElementById('yt-channel-avatar'),
    ytChannelTitle: document.getElementById('yt-channel-title'),
    ytLiveStatusPill: document.getElementById('yt-live-status-pill'),
    btnYoutubeDetect: document.getElementById('btn-youtube-detect'),
    btnYoutubeLogout: document.getElementById('btn-youtube-logout'),

    // Ferramentas
    btnTestTwitch: document.getElementById('btn-test-twitch'),
    btnTestYoutube: document.getElementById('btn-test-youtube'),
    btnClearChat: document.getElementById('btn-clear-chat'),

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
  }

  // Carrega preferências do localStorage
  function loadSavedSettings() {
    const savedTwitch = localStorage.getItem('platchat_twitch_channel');
    if (savedTwitch) elements.twitchInput.value = savedTwitch;
  }

  // Gerenciamento da conexão WebSocket
  function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    state.ws = new WebSocket(wsUrl);

    state.ws.onopen = () => {
      state.isConnectedWs = true;
      console.log('[PlatChat Client] Conectado ao servidor WebSocket');
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

  // Atualiza indicadores visuais de status
  function updatePlatformStatuses(statuses) {
    if (statuses.twitch) {
      state.twitchStatus = statuses.twitch;
      renderTwitchStatus(statuses.twitch);
    }

    if (statuses.youtube) {
      state.youtubeStatus = statuses.youtube;
      renderYouTubeStatus(statuses.youtube);
    }
  }

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

  function renderYouTubeStatus(statusObj) {
    const pill = elements.youtubeStatusPill;
    const textSpan = pill.querySelector('.status-text');

    if (statusObj.isAuthenticated) {
      // Usuário logado via Google
      elements.ytUnauthBox.classList.add('hidden');
      elements.ytAuthBox.classList.remove('hidden');

      elements.ytChannelTitle.textContent = statusObj.channel || 'Canal Autenticado';

      if (statusObj.channelAvatar) {
        elements.ytChannelAvatar.src = statusObj.channelAvatar;
        elements.ytChannelAvatar.style.display = 'block';
      } else {
        elements.ytChannelAvatar.style.display = 'none';
      }

      if (statusObj.hasActiveLive) {
        pill.className = 'badge-status status-connected';
        textSpan.textContent = 'YouTube: Live';
        pill.title = `YouTube: Conectado à live "${statusObj.liveTitle || 'Ao Vivo'}"`;

        elements.ytLiveStatusPill.className = 'yt-live-tag tag-live';
        elements.ytLiveStatusPill.textContent = `● Live: ${statusObj.liveTitle || 'Ao Vivo'}`;
      } else {
        pill.className = 'badge-status status-connecting';
        textSpan.textContent = 'YouTube: Autenticado';
        pill.title = statusObj.error || 'YouTube autenticado, aguardando início de transmissão ao vivo.';

        elements.ytLiveStatusPill.className = 'yt-live-tag tag-offline';
        elements.ytLiveStatusPill.textContent = '○ Nenhuma live ativa';
      }
    } else {
      // Usuário NÃO logado
      elements.ytUnauthBox.classList.remove('hidden');
      elements.ytAuthBox.classList.add('hidden');

      pill.className = 'badge-status status-disconnected';
      textSpan.textContent = 'YouTube';
      pill.title = 'YouTube: Desconectado. Faça login com o Google.';
    }
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
          <span class="platform-pill">${msg.platform}</span>
          ${badgesHtml}
          <span class="msg-username" style="${userColorStyle}">${escapeHtml(msg.username)}:</span>
        </div>
        <div class="msg-text">${escapeHtml(msg.message)}</div>
      </div>
    `;

    elements.messagesList.appendChild(item);

    // Limita número de elementos no DOM para performance contínua no OBS
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

  // Funções de Rolagem e Auto-Scroll
  function isUserNearBottom() {
    const threshold = 60;
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
    // Escuta evento postMessage emitido pelo popup de OAuth do Google após o login
    window.addEventListener('message', (event) => {
      if (event.data?.type === 'YOUTUBE_AUTH_SUCCESS') {
        console.log('[PlatChat] Login no Google concluído com sucesso!');
        sendCommand({ action: 'get_status' });
        sendCommand({ action: 'detect_youtube_live' });
      }
    });

    // Toggle Painel de Configurações
    elements.btnToggleConfig.addEventListener('click', () => {
      elements.configDrawer.classList.toggle('open');
    });

    // Conectar / Desconectar Twitch
    elements.btnTwitchConnect.addEventListener('click', () => {
      const channel = elements.twitchInput.value.trim();
      if (!channel) return;

      if (state.twitchStatus.status === 'connected') {
        sendCommand({ action: 'unsubscribe', platform: 'twitch' });
      } else {
        localStorage.setItem('platchat_twitch_channel', channel);
        sendCommand({ action: 'subscribe', platform: 'twitch', channel });
      }
    });

    elements.twitchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') elements.btnTwitchConnect.click();
    });

    // Botão de Login Google para o YouTube
    elements.btnGoogleLogin.addEventListener('click', () => {
      const width = 560;
      const height = 680;
      const left = window.screenX + (window.outerWidth - width) / 2;
      const top = window.screenY + (window.outerHeight - height) / 2;

      window.open(
        '/auth/google',
        'google_oauth_popup',
        `width=${width},height=${height},left=${left},top=${top},status=no,menubar=no,toolbar=no`
      );
    });

    // Botão Buscar Live Ativa no YouTube
    elements.btnYoutubeDetect.addEventListener('click', () => {
      sendCommand({ action: 'detect_youtube_live' });
    });

    // Botão Logout YouTube
    elements.btnYoutubeLogout.addEventListener('click', () => {
      sendCommand({ action: 'youtube_logout' });
    });

    // Botões de Simulação para Teste
    elements.btnTestTwitch.addEventListener('click', () => {
      sendCommand({ action: 'test_message', platform: 'twitch' });
    });

    elements.btnTestYoutube.addEventListener('click', () => {
      sendCommand({ action: 'test_message', platform: 'youtube' });
    });

    // Botão Limpar Chat
    elements.btnClearChat.addEventListener('click', () => {
      elements.messagesList.innerHTML = '';
      state.unreadWhilePaused = 0;
      elements.scrollBottomPill.classList.add('hidden');
    });

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
