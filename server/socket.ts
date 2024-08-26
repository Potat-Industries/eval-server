import WS from 'ws';
import { Config, Evaluator } from '../index';
import { IncomingMessage } from 'node:http';
import { timingSafeEqual } from "crypto";

enum EventCodes {
  MALFORMED_DATA = 4000,
  UNAUTHORIZED = 4001,
  UNKNOWN_ERROR = 4002,
  DISPATCH = 4004
}

interface EvalMessage {
  code: string;
  msg?: string;
}

export class EvalSocket {
  private static instance: EvalSocket;

  private wss: WS.Server;
  private evaluator: Evaluator

  private readonly PORT: number;
  private readonly AUTHORIZATION: string;

  private constructor(config: Config) {
    this.PORT = config.wssPort;
    this.AUTHORIZATION = config.auth;
    
    this.evaluator = Evaluator.new(config);
    this.wss = new WS.Server({ port: this.PORT });

    this.wss.on('connection', (client: WS.WebSocket, req: IncomingMessage) => {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const token = url.searchParams.get('auth');
    
      if (!token || !this.validateToken(token)) {
        return client.close(EventCodes.UNAUTHORIZED, 'Unauthorized');
      }

      this.setupListeners(client);
    });
  }

  public static new(config: Config): EvalSocket {
    return this.instance ?? (this.instance = new this(config));
  }

  private setupListeners(client: WS.WebSocket): void {
    client.on('message', (msg: MessageEvent) => {
      let data: EvalMessage;
      try { data = JSON.parse(msg.data); } 
      catch (e) {
        return this.send(
          client, 
          { error: 'Malformed JSON received.' },
          EventCodes.MALFORMED_DATA
        );
      }

      if (!data?.code || typeof data.code !== 'string') {
        return this.send(
          client, 
          { error: 'Invalid or malformed code received.' },
          EventCodes.MALFORMED_DATA
        );
      }

      if (msg && typeof msg !== 'object') {
        return this.send(
          client, 
          { error: 'Invalid or malformed message received.' },
          EventCodes.MALFORMED_DATA
        );
      }

      return this.evaluator
        .add(data.code, data.msg)
        .then((data) => this.send(client, { data }, EventCodes.DISPATCH))
        .catch((error) => this.send(client, { error }, EventCodes.UNKNOWN_ERROR));
    });

    client.on('error', () => {
      client.close(
        EventCodes.UNKNOWN_ERROR,
        'An unknown error occurred.'
      );
    });
  }

  private send(client: WS.WebSocket, data: any, op: EventCodes): void {
    if (client.readyState === WS.OPEN) {
      client.send(
        JSON.stringify({
          opcode: op ?? EventCodes.DISPATCH,
          data
        })
      );
    }
  }

  private validateToken(auth: string): boolean {
    const posessed = Buffer.alloc(5, this.AUTHORIZATION);
    const provided = Buffer.alloc(5, auth);

    return timingSafeEqual(posessed, provided);
  }
}
