import { UnifiedChatMessage } from '../../types/chat.js';

export interface ParsedIrcMessage {
  raw: string;
  tags: Record<string, string>;
  prefix?: string;
  command: string;
  params: string[];
}

/**
 * Faz o parsing de mensagens no formato IRC v3 utilizado pela Twitch.
 */
export function parseTwitchIrc(rawLine: string): ParsedIrcMessage {
  let position = 0;
  let nextSpace = 0;
  const tags: Record<string, string> = {};
  let prefix: string | undefined;

  // 1. Parsing de tags (inicia com '@')
  if (rawLine.charCodeAt(0) === 64) { // '@'
    nextSpace = rawLine.indexOf(' ');
    if (nextSpace === -1) {
      return { raw: rawLine, tags, command: '', params: [] };
    }

    const rawTags = rawLine.slice(1, nextSpace).split(';');
    for (const rawTag of rawTags) {
      const eqIdx = rawTag.indexOf('=');
      if (eqIdx !== -1) {
        const key = rawTag.slice(0, eqIdx);
        const value = rawTag.slice(eqIdx + 1);
        tags[key] = unescapeTagValue(value);
      } else {
        tags[rawTag] = '';
      }
    }

    position = nextSpace + 1;
    while (rawLine.charCodeAt(position) === 32) {
      position++;
    }
  }

  // 2. Parsing do prefixo (inicia com ':')
  if (rawLine.charCodeAt(position) === 58) { // ':'
    nextSpace = rawLine.indexOf(' ', position);
    if (nextSpace === -1) {
      return { raw: rawLine, tags, command: '', params: [] };
    }

    prefix = rawLine.slice(position + 1, nextSpace);
    position = nextSpace + 1;
    while (rawLine.charCodeAt(position) === 32) {
      position++;
    }
  }

  // 3. Parsing do comando
  nextSpace = rawLine.indexOf(' ', position);
  let command = '';
  const params: string[] = [];

  if (nextSpace === -1) {
    if (rawLine.length > position) {
      command = rawLine.slice(position);
    }
    return { raw: rawLine, tags, prefix, command, params };
  }

  command = rawLine.slice(position, nextSpace);
  position = nextSpace + 1;
  while (rawLine.charCodeAt(position) === 32) {
    position++;
  }

  // 4. Parsing dos parâmetros e texto final (trailing)
  while (position < rawLine.length) {
    if (rawLine.charCodeAt(position) === 58) { // ':' indica início da mensagem/trailing
      params.push(rawLine.slice(position + 1));
      break;
    }

    nextSpace = rawLine.indexOf(' ', position);
    if (nextSpace === -1) {
      params.push(rawLine.slice(position));
      break;
    }

    params.push(rawLine.slice(position, nextSpace));
    position = nextSpace + 1;
    while (rawLine.charCodeAt(position) === 32) {
      position++;
    }
  }

  return { raw: rawLine, tags, prefix, command, params };
}

/**
 * Decodifica valores com escape de tags do IRC Twitch
 */
function unescapeTagValue(value: string): string {
  if (!value) return '';
  return value
    .replace(/\\:/g, ';')
    .replace(/\\s/g, ' ')
    .replace(/\\\\/g, '\\')
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n');
}

/**
 * Converte um comando PRIVMSG da Twitch para o modelo padronizado UnifiedChatMessage.
 */
export function convertPrivmsgToUnified(parsed: ParsedIrcMessage): UnifiedChatMessage | null {
  if (parsed.command !== 'PRIVMSG' || parsed.params.length < 2) {
    return null;
  }

  const { tags, prefix, params } = parsed;
  const messageText = params[1] || '';

  // Determinar username
  let username = tags['display-name'];
  if (!username && prefix) {
    const exclamationIdx = prefix.indexOf('!');
    username = exclamationIdx !== -1 ? prefix.slice(0, exclamationIdx) : prefix;
  }
  if (!username) {
    username = 'Anônimo';
  }

  // Determinar timestamp
  let timestamp = Date.now();
  if (tags['tmi-sent-ts']) {
    const parsedTs = parseInt(tags['tmi-sent-ts'], 10);
    if (!isNaN(parsedTs)) {
      timestamp = parsedTs;
    }
  }

  // ID único
  const id = tags['id'] || `twitch-${timestamp}-${Math.random().toString(36).substring(2, 9)}`;

  // Badges
  const badges: string[] = [];
  if (tags['badges']) {
    const rawBadges = tags['badges'].split(',');
    for (const b of rawBadges) {
      const [name] = b.split('/');
      if (name) badges.push(name);
    }
  }

  return {
    id,
    platform: 'twitch',
    username,
    message: messageText,
    timestamp,
    color: tags['color'] || undefined,
    badges: badges.length > 0 ? badges : undefined
  };
}
