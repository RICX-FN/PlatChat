import { EventEmitter } from 'events';
import { UnifiedChatMessage } from '../../types/chat.js';

export interface MessageQueueOptions {
  /** Janela de buffering em ms para coalescer mensagens de múltiplas fontes e garantir ordem estrita */
  flushIntervalMs?: number;
  /** Número máximo de mensagens mantidas no histórico em memória */
  maxHistorySize?: number;
}

/**
 * Fila centralizadora que normaliza e garante a ordenação cronológica estrita (timestamp)
 * de todas as mensagens vindas de diferentes plataformas de streaming.
 */
export class MessageQueue extends EventEmitter {
  private buffer: UnifiedChatMessage[] = [];
  private history: UnifiedChatMessage[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly flushIntervalMs: number;
  private readonly maxHistorySize: number;

  constructor(options: MessageQueueOptions = {}) {
    super();
    this.flushIntervalMs = options.flushIntervalMs ?? 50;
    this.maxHistorySize = options.maxHistorySize ?? 100;
  }

  /**
   * Adiciona uma única mensagem à fila de processamento
   */
  public pushMessage(message: UnifiedChatMessage): void {
    this.buffer.push(message);
    this.scheduleFlush();
  }

  /**
   * Adiciona um lote de mensagens à fila de processamento
   */
  public pushBatch(messages: UnifiedChatMessage[]): void {
    if (!messages || messages.length === 0) return;
    this.buffer.push(...messages);
    this.scheduleFlush();
  }

  /**
   * Retorna o histórico recente em ordem cronológica estrita (mais antiga para mais recente)
   */
  public getHistory(): UnifiedChatMessage[] {
    return [...this.history];
  }

  /**
   * Limpa o histórico de mensagens
   */
  public clear(): void {
    this.buffer = [];
    this.history = [];
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;

    this.flushTimer = setTimeout(() => {
      this.flush();
    }, this.flushIntervalMs);
  }

  /**
   * Processa o buffer, ordena estritamente por timestamp e despacha aos ouvintes
   */
  private flush(): void {
    this.flushTimer = null;

    if (this.buffer.length === 0) return;

    const messagesToProcess = [...this.buffer];
    this.buffer = [];

    // Ordenação estrita por timestamp ascendente (mais antiga para mais recente)
    messagesToProcess.sort((a, b) => a.timestamp - b.timestamp);

    // Atualiza histórico mantendo limite
    for (const msg of messagesToProcess) {
      this.history.push(msg);
    }
    if (this.history.length > this.maxHistorySize) {
      this.history.splice(0, this.history.length - this.maxHistorySize);
    }

    // Emite o lote ordenado
    this.emit('batch', messagesToProcess);

    // Emite cada mensagem individualmente se ouvintes preferirem consumir 1 a 1
    for (const msg of messagesToProcess) {
      this.emit('message', msg);
    }
  }
}
