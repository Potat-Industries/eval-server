import * as http from 'node:http';
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from 'ws';
import { EvalRequestHandler } from './types';

enum EventCodes {
  MALFORMED_DATA = 4000,
  UNAUTHORIZED = 4001,
  UNKNOWN_ERROR = 4002,
  DISPATCH = 4004
}

interface EvalMessage {
  code: string;
  msg?: string;
  id: number;
}

export class EvalSocket {
  private ws: WebSocketServer;

  public constructor(
    server: http.Server,
    private readonly authToken: string,
    private readonly handleEvalRequest: EvalRequestHandler,
  ) {
    this.ws = new WebSocketServer({
      server: server,
      path: '/socket'
    });

    this.ws.on('connection', (client: WebSocket, req: http.IncomingMessage) => {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const token = url.searchParams.get('auth');

      if (!token || !this.validateToken(token)) {
        console.error('Unauthorized socket connection.', token);
        return client.close(EventCodes.UNAUTHORIZED, 'Unauthorized');
      }

      this.setupListeners(client);
    })
  }

  private setupListeners(client: WebSocket): void {
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
  }

  private send(client: WebSocket, data: any, op: EventCodes): void {
    if (client.readyState === WebSocket.OPEN) {
      client.send(
        JSON.stringify({
          opcode: op ?? EventCodes.DISPATCH,
          data
        })
      );
    }
  }

  private validateToken(auth: string): boolean {
    const posessed = Buffer.alloc(5, this.authToken);
    const provided = Buffer.alloc(5, auth);

    return timingSafeEqual(posessed, provided);
  }
}
