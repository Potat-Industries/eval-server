import * as http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { EvalRequestHandler } from './types';
import Logger from '../util/logger.js';

export const EventCode = {
  RECEIVED_DATA: 4000,
  RECONNECT: 4001,
  UNKNOWN_ERROR: 4002,
  INVALID_ORIGIN: 4003,
  DISPATCH: 4004,
  HEARTBEAT: 4005,
  MALFORMED_DATA: 4006,
  UNAUTHORIZED: 4007,
} as const;

export type EventCodes = typeof EventCode[keyof typeof EventCode];

export interface EvalMessage {
  id?: number | string;
  code?: string;
  msg?: Record<string, any>;
  error?: string;
}

interface EvalWebSocket extends WebSocket {
  _pingInterval: NodeJS.Timeout;
}

export class EvalSocket {
  private ws: WebSocketServer;

  private awaiters: Map<string, { 
    resolve: (_: EvalMessage) => void; 
    timeout: NodeJS.Timeout;
  }> = new Map();
  
  private readonly authToken: string;
  private readonly handleEvalRequest: EvalRequestHandler;

  public constructor(
    server: http.Server,
    authToken: string,
    handleEvalRequest: EvalRequestHandler,
  ) {
    this.authToken = authToken;
    this.handleEvalRequest = handleEvalRequest;

    this.ws = new WebSocketServer({
      server: server,
      path: '/socket',
    });

    this.ws.on('connection', (client: EvalWebSocket, req: http.IncomingMessage) => {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const token = url.searchParams.get('auth');

      if (!token || !this.validateToken(token)) {
        Logger.error('Unauthorized socket connection.', token ?? 'No token provided');
        return client.close(EventCode.UNAUTHORIZED, 'Unauthorized');
      }

      Logger.debug('New socket connection established.');
      this.setupListeners(client);
    });
  }

  private setupListeners(client: EvalWebSocket): void {
    client.on('message', async (msg: MessageEvent) => {
      let data: EvalMessage;
      try {
        data = JSON.parse(msg.toString()); 
      } catch {
        return this.send(
          client,
          { error: 'Malformed JSON received.' },
          EventCode.MALFORMED_DATA,
        );
      }

      if (!data?.id || typeof data.id !== 'string') {
        return this.send(
          client,
          { error: 'Invalid or missing ID.' },
          EventCode.MALFORMED_DATA,
        );
      }

      const awaiter = this.awaiters.get(data.id);
      if (awaiter) {
        clearTimeout(awaiter.timeout);
        this.awaiters.delete(data.id);
        
        return awaiter.resolve(data);
      }

      if (!data?.code || typeof data.code !== 'string') {
        return this.send(
          client,
          { error: 'Invalid or missing ID.' },
          EventCode.MALFORMED_DATA,
        );
      }

      const response = await this.handleEvalRequest(data.code, data.msg);
      this.send(client, {
        ...response,
        id: data.id,
      }, EventCode.DISPATCH);
    });

    client.on('error', () => {
      client.close(
        EventCode.UNKNOWN_ERROR,
        'An unknown error occurred.',
      );
    });

    client._pingInterval = setInterval(() => {
      this.send(
        client,
        { timestamp: Date.now(), message: this.pickMessage() },
        EventCode.HEARTBEAT,
      );
    }, 30_000);
  }

  public runCommand(
    commandName: string,
    msg: Record<string, any>, 
    args: string[],
  ): Promise<EvalMessage> {
    if (args.length && args.some(arg => typeof arg !== 'string')) {
      throw new TypeError('Command arguments must be strings!');
    }

    msg.text = args.join(' ');

    const id = crypto.randomUUID();

    const data = {
      code: commandName,
      msg: msg,
      id,
    };

    return new Promise((resolve, reject) => {
      for (const client of this.ws.clients) {
        this.send(
          client as EvalWebSocket,
          data,
          EventCode.DISPATCH,
        );
      }

      const timeout = setTimeout(() => {
        this.awaiters.delete(id);
        reject(new Error('Command timed out.'));
      }, 10_000);

      this.awaiters.set(id, { resolve, timeout });
    });
  }

  private send(client: EvalWebSocket, data: any, op: EventCodes = EventCode.DISPATCH): void {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ opcode: op, data }));
    }
  }

  private validateToken(auth: string): boolean {
    const posessed = Buffer.alloc(5, this.authToken);
    const provided = Buffer.alloc(5, auth);

    return timingSafeEqual(posessed, provided);
  }

  /** Extremely critical */
  private pickMessage(): string {
    const messages = [
      'Skibidy toilet!!',
      'fortniteburger.net',
      'amongus.............',
      'LOL',
      'You are in a maze of twisty little passages, all alike',
      'I am a fish',
      'potatoes are actually vegetables did you know this, have you heard about this?',
      'hamburger',
    ];

    const randomMessage = messages[Math.floor(Math.random() * messages.length)];
    if (randomMessage) {
      return randomMessage;
    }

    return 'ping';
  }
}
