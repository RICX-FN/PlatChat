# PlatChat - Chat Unificado para OBS Studio (Multistream Chat)

Chat Unificado de alta performance desenvolvido para OBS Studio. O sistema consolida em tempo real as mensagens da **Twitch**, **YouTube Live**, **Kick** e **TikTok Live**, ordena-as cronologicamente e as transmite via **WebSocket** para um painel web embutível como Custom Browser Dock no OBS.

---

## 🛠️ Stack Tecnológica

- **Backend**: Node.js com TypeScript (ESM), Express e `ws` (WebSockets).
- **Frontend**: HTML5 semântico, CSS3 moderno (tema escuro otimizado para o OBS Studio) e Vanilla JavaScript modular (zero dependência de build no cliente).
- **Plataformas Suportadas**:
  - **Twitch**: Conexão IRC anônima (`justinfan`) sem necessidade de chaves de API ou login.
  - **YouTube**: Leitura de chat em tempo real **sem necessidade de autenticação** (basta informar o `@handle`, ID do canal ou link da live), com suporte opcional a Google OAuth 2.0.
  - **Kick**: Conexão WebSocket oficial via Pusher com negociação dinâmica de credenciais e leitura instantânea de histórico inicial.
  - **TikTok Live**: Leitura de chat e presentes via Webcast Push em tempo real informando apenas o `@usuário`.
- **Arquitetura**: Desacoplada e orientada a eventos (`EventEmitter`), com serviços isolados por plataforma e fila centralizadora com ordenação cronológica estrita.

---

## 📁 Estrutura de Diretórios

```
PlatChat/
├── .env.example                          # Exemplo de variáveis de ambiente
├── .gitignore                            # Arquivos ignorados pelo Git
├── package.json                          # Dependências e scripts de execução
├── tsconfig.json                         # Configuração TypeScript NodeNext
├── README.md                             # Documentação e guia de integração
├── public/                               # Frontend do Custom Browser Dock do OBS
│   ├── index.html                        # Interface de chat e painel de configuração
│   ├── css/
│   │   └── style.css                     # Estilização OBS dark mode, badges e cores das 4 plataformas
│   └── js/
│       └── app.js                        # Lógica WebSocket, formulários e auto-scroll
└── src/                                  # Código-fonte do Backend (TypeScript)
    ├── types/
    │   └── chat.ts                       # Tipos unificados e status de transmissão
    ├── services/
    │   ├── twitch/
    │   │   ├── twitchParser.ts           # Parser de tags IRC v3 da Twitch
    │   │   └── twitchIrcService.ts       # Conexão WebSocket IRC anônima
    │   ├── youtube/
    │   │   ├── youtubePublicChatService.ts # Leitura de chat do YouTube SEM autenticação
    │   │   ├── youtubeAuthService.ts     # Google OAuth 2.0 opcional
    │   │   └── youtubeLiveChatService.ts # Polling oficial com cota
    │   ├── kick/
    │   │   └── kickChatService.ts        # Conexão WebSocket Pusher da Kick
    │   ├── tiktok/
    │   │   └── tiktokLiveService.ts      # Conexão Webcast Push do TikTok Live
    │   └── queue/
    │       └── messageQueue.ts           # Fila e ordenação cronológica estrita
    ├── websocket/
    │   └── wsServer.ts                   # Servidor WebSocket e despacho de eventos unificados
    └── server.ts                         # Ponto de entrada Express, REST e WebSocket
```

---

## 🚀 Como Executar

### 1. Iniciar em desenvolvimento
```bash
npm run dev
```

### 2. Compilar e executar em produção
```bash
npm run build
npm start
```

---

## 🎥 Como Embutir no OBS Studio (Custom Browser Dock)

1. Com o servidor rodando, abra o **OBS Studio**.
2. No menu superior, clique em:
   **Docks (Painéis) -> Custom Browser Docks (Painéis com Navegador Personalizados)...**
3. Em **Nome do Painel (Dock Name)**, informe: `Chat Unificado` ou `PlatChat`.
4. Em **URL**, insira:
   ```
   http://localhost:3000
   ```
5. Clique em **Aplicar**. O painel abrirá dentro do OBS Studio.
6. Clique no botão de engrenagem no topo para abrir as configurações:
   - **Twitch**: Digite o canal (ex: `gaules`) e clique em **Conectar**.
   - **YouTube**: Digite o `@canal`, ID ou link da live (ex: `@LofiGirl`) e clique em **Conectar** (sem login!).
   - **Kick**: Digite o canal (ex: `xqc`) e clique em **Conectar**.
   - **TikTok Live**: Digite o nome de usuário (ex: `@streamer`) e clique em **Conectar**.
