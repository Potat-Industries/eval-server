import * as http from 'node:http';
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from 'ws';
import { EvalRequestHandler } from './types';
import Logger from "../logger";

enum EventCodes {
  RECIEVED_DATA = 4000,
  RECONNECT = 4001,
  UNKNOWN_ERROR = 4002,
  INVALID_ORIGIN = 4003,
  DISPATCH = 4004,
  HEARTBEAT = 4005,
  MALFORMED_DATA = 4006,
  UNAUTHORIZED = 4007
}

interface EvalMessage {
  code: string;
  msg?: string;
  id: string;
}

interface EvalWebSocket extends WebSocket {
  _pingInterval: NodeJS.Timeout;
}

export class EvalSocket {
  private ws: WebSocketServer;

  private awaiters: Map<string, { 
    resolve: (value: unknown) => void; 
    timeout: NodeJS.Timeout;
  }> = new Map();

  public constructor(
    server: http.Server,
    private readonly authToken: string,
    private readonly handleEvalRequest: EvalRequestHandler,
  ) {
    this.ws = new WebSocketServer({
      server: server,
      path: '/socket'
    });

    this.ws.on('connection', (client: EvalWebSocket, req: http.IncomingMessage) => {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const token = url.searchParams.get('auth');

      if (!token || !this.validateToken(token)) {
        Logger.error('Unauthorized socket connection.', token);
        return client.close(EventCodes.UNAUTHORIZED, 'Unauthorized');
      }

      Logger.debug('New socket connection established.');
      this.setupListeners(client);
    })
  }

  private setupListeners(client: EvalWebSocket): void {
    client.on('message', async (msg: MessageEvent) => {
      let data: EvalMessage;
      try { data = JSON.parse(msg.toString()); }
      catch (e) {
        return this.send(
          client,
          { error: 'Malformed JSON received.' },
          EventCodes.MALFORMED_DATA
        );
      }

      const awaiter = this.awaiters.get(data.id);
      if (awaiter) {
        clearTimeout(awaiter.timeout);
        this.awaiters.delete(data.id);
        
        return awaiter.resolve(data);
      }

      const response = await this.handleEvalRequest(data.code, data.msg);
      this.send(client, {
        ...response,
        id: data.id,
      }, EventCodes.DISPATCH);
    });

    client.on('error', () => {
      client.close(
        EventCodes.UNKNOWN_ERROR,
        'An unknown error occurred.'
      );
    });

    client._pingInterval = setInterval(() => {
      this.send(
        client,
        { timestamp: Date.now(), message: this.pickMessage() },
        EventCodes.HEARTBEAT
      )
    }, 30_000);
  }

  public runCommand(
    commandName: string,
    msg: Record<string, any>, 
    args: string[],
  ): Promise<{
    id?: number | string;
    code?: string;
    msg?: Record<string, any>;
    error?: string;
  }> {
    if (args.length && args.some(arg => typeof arg !== 'string')) {
      throw new TypeError('Command arguments must be strings!');
    }

    msg.text = args.join(' ');

    const id = crypto.randomUUID();

    const data = {
      code: commandName,
      msg: msg,
      id
    };

    return new Promise((resolve, reject) => {
      for (const client of this.ws.clients) {
        this.send(
          client as EvalWebSocket,
          data,
          EventCodes.DISPATCH
        );
      }

      const timeout = setTimeout(() => {
        this.awaiters.delete(id);
        reject(new Error('Command timed out.'));
      }, 10_000);

      this.awaiters.set(id, { resolve, timeout });
    });
  }

  private send(client: EvalWebSocket, data: any, op: EventCodes = EventCodes.DISPATCH): void {
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
      'potatos are actually vegetables did you know this, have you heard about this?',
      'hamburger',
    ];

    return messages[Math.floor(Math.random() * messages.length)];
  }
}
