# PlatChat - Chat Unificado para OBS Studio (Multistream Chat)

Chat Unificado de alta performance desenvolvido para OBS Studio. O sistema consolida em tempo real as mensagens da **Twitch**, **YouTube Live**, **Kick** e **TikTok Live**, ordena-as cronologicamente e as transmite via **WebSocket** para um painel web embutível como Custom Browser Dock no OBS.

---

## 🛠️ Stack Tecnológica

- **Backend**: Node.js com TypeScript (ESM), Express e `ws` (WebSockets).
- **Frontend**: HTML5 semântico, CSS3 moderno (tema escuro otimizado para o OBS Studio) e Vanilla JavaScript modular (zero dependência de build no cliente).
- **Plataformas Suportadas**:
  - **Twitch**: Conexão IRC anônima (`justinfan`) sem necessidade de chaves de API ou login.
  - **YouTube**: Leitura de chat em tempo real sem necessidade de conta ou login (basta informar o `@handle`, ID do canal ou link da live).
  - **Kick**: Conexão WebSocket oficial via Pusher com negociação dinâmica de credenciais e leitura instantânea de histórico inicial.
  - **TikTok Live**: Leitura de chat e presentes via Webcast Push em tempo real informando apenas o `@usuário`.
- **Arquitetura**: Desacoplada e orientada a eventos (`EventEmitter`), com uma instância de cada serviço e uma fila cronológica independente por conexão WebSocket.
- **Sessões de chat**: Cada conexão WebSocket recebe status, conexões e histórico próprios. Conectar, desconectar ou simular mensagens em uma sessão não afeta outras. As preferências de canal ficam no `sessionStorage` daquela aba, são restauradas após atualizar e não são compartilhadas com outras abas; o estado do chat é descartado quando a sessão WebSocket termina.

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

Configure `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`,
`JWT_SECRET` (com pelo menos 32 caracteres aleatórios) e `CLIENT_URL` no ambiente.
O preço mensal está em `STRIPE_PRICE_ID`; quando disponível, configure também
`STRIPE_ANNUAL_PRICE_ID` com o ID do preço recorrente anual no Stripe.
O endpoint do webhook do Stripe é `/api/stripe/webhook`; configure-o para os eventos
`checkout.session.completed`, `customer.subscription.updated` e
`customer.subscription.deleted`. O checkout inclui sete dias de teste grátis;
depois, começa a cobrança recorrente do plano escolhido. Preços configurados são
exibidos no painel antes do checkout. O PlatChat não mantém uma base de dados:
tokens de licença assinados e o estado da assinatura são armazenados nos
metadados do Stripe.

### 1. Iniciar em desenvolvimento
```bash
npm run dev
```

### 2. Compilar e executar em produção
```bash
npm run build
npm start
```

### Acessar de outro computador na rede local

O servidor usa `HOST=0.0.0.0` por padrão, permitindo conexões pela rede local, e
mostra no terminal os endereços privados disponíveis ao iniciar. No outro
computador, conectado à mesma rede Wi-Fi/roteador, abra o endereço exibido,
por exemplo `http://192.168.1.8:3000`. O WebSocket acompanha automaticamente
esse endereço.

Se não conectar, permita conexões TCP de entrada na porta `3000` no firewall do
computador que executa PlatChat, apenas no perfil de rede privada. Não configure
encaminhamento de porta no roteador nem exponha essa porta à internet. Para
manter o acesso local apenas, defina `HOST=127.0.0.1` no `.env`.

---

## 🎥 Como Embutir no OBS Studio (Custom Browser Dock)

1. Com o servidor rodando, abra o **OBS Studio**.
2. No menu superior, clique em:
   **Docks (Painéis) -> Custom Browser Docks (Painéis com Navegador Personalizados)...**
3. Em **Nome do Painel (Dock Name)**, informe: `Chat Unificado` ou `PlatChat`.
4. Em **URL**, insira:
   ```
   http://localhost:3000/?dock=1
   ```
5. Clique em **Aplicar**. O painel abrirá dentro do OBS Studio.
6. Clique no botão de engrenagem no topo para abrir as configurações:
   - **Twitch**: Digite o canal (ex: `gaules`) e clique em **Conectar**.
   - **YouTube**: Digite o `@canal`, ID ou link da live (ex: `@LofiGirl`) e clique em **Conectar** (sem login!).
   - **Kick**: Digite o canal (ex: `xqc`) e clique em **Conectar**.
   - **TikTok Live**: Digite o nome de usuário (ex: `@streamer`) e clique em **Conectar**.
   Após conectar um canal, o PlatChat recolhe automaticamente a apresentação e maximiza o chat. O botão ⤢/⤡ alterna entre o modo compacto e a página completa; `?dock=1` abre sempre diretamente no modo compacto. O histórico visual é limitado às últimas 150 mensagens para manter o painel leve.
   As conexões e o histórico pertencem à sessão da aba do navegador/OBS que os criou; atualizar o painel reconecta os canais salvos naquela aba, sem compartilhar canais ou mensagens com outras abas ou visitantes. Fechar a aba encerra a sessão e suas conexões.
