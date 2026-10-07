# PlatChat - Chat Unificado para OBS Studio (Multistream Chat)

MVP de Chat Unificado de alta performance desenvolvido para OBS Studio. O sistema consolida em tempo real as mensagens da **Twitch** e do **YouTube Live**, ordena-as cronologicamente e as transmite via **WebSocket** para um painel web embutível como Custom Browser Dock no OBS.

---

## 🛠️ Stack Tecnológica

- **Backend**: Node.js com TypeScript (ESM), Express e `ws` (WebSockets).
- **Frontend**: HTML5 semântico, CSS3 moderno (tema escuro otimizado para o OBS Studio) e Vanilla JavaScript modular (zero dependência de build no cliente).
- **Autenticação**:
  - **Twitch**: Conexão IRC anônima (`justinfan`) sem necessidade de chaves de API ou login.
  - **YouTube**: Fluxo profissional **OAuth 2.0 com Google Login** (idêntico ao OBS e Streamlabs), com renovação automática de tokens via Refresh Token e detecção automática da live ativa.
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
│   ├── index.html                        # Interface com botão Google Login e status
│   ├── css/
│   │   └── style.css                     # Estilização OBS dark mode e badges
│   └── js/
│       └── app.js                        # Lógica WebSocket, popup OAuth e auto-scroll
└── src/                                  # Código-fonte do Backend (TypeScript)
    ├── types/
    │   └── chat.ts                       # Tipos unificados e status de transmissão
    ├── services/
    │   ├── twitch/
    │   │   ├── twitchParser.ts           # Parser de tags IRC v3 da Twitch
    │   │   └── twitchIrcService.ts       # Conexão WebSocket IRC anônima
    │   ├── youtube/
    │   │   ├── youtubeAuthService.ts     # Fluxo Google OAuth 2.0 e Refresh Token
    │   │   └── youtubeLiveChatService.ts # Detecção de live ativa e polling com cota
    │   └── queue/
    │       └── messageQueue.ts           # Fila e ordenação cronológica estrita
    ├── websocket/
    │   └── wsServer.ts                   # Servidor WebSocket e despacho de eventos
    └── server.ts                         # Ponto de entrada Express, OAuth e WebSocket
```

---

## ⚙️ Configuração do Google OAuth 2.0 (YouTube)

Para permitir que o streamer faça login com o canal do YouTube:

1. Acesse o [Google Cloud Console](https://console.cloud.google.com/).
2. Crie ou selecione um projeto e acesse a **Biblioteca de APIs**.
3. Procure por **YouTube Data API v3** e clique em **Ativar**.
4. No menu lateral esquerdo, vá em **Tela de permissão OAuth** (OAuth consent screen):
   - Tipo de usuário: **Externo** (External).
   - Preencha o nome do app (ex: `PlatChat`) e seu e-mail.
   - Em **Escopos**, adicione: `https://www.googleapis.com/auth/youtube.readonly`.
   - Em **Usuários de teste**, adicione o e-mail da sua conta do Google/YouTube.
5. Vá em **Credenciais** -> **Criar Credenciais** -> **ID do cliente OAuth**:
   - Tipo de aplicativo: **Aplicativo da Web (Web application)**.
   - Nome: `PlatChat OBS Client`.
   - **URIs de redirecionamento autorizados**:
     ```
     http://localhost:3000/auth/google/callback
     ```
6. Copie o **Client ID** e o **Client Secret** gerados e cole no seu arquivo `.env`:
   ```env
   GOOGLE_CLIENT_ID=seu_client_id.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=seu_client_secret
   GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
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
   - Digite seu canal da Twitch e clique em **Conectar**.
   - Clique em **Conectar YouTube (Google Login)** para autorizar seu canal. O chat da sua live será detectado automaticamente!
