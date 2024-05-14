import express, { Request, Response, Application, NextFunction, json } from 'express';
import { Isolate, Reference } from 'isolated-vm';
import { inspect } from 'node:util';
import { Utils } from './sandbox-utils.js';

interface Config {
  port: number;
  auth: string;
}

interface Waiter {
  code: string;
  msg: any;
  resolve: (value: any) => void;
  reject: (reason: any) => void;
}

interface EvalResponse {
  data: any[];
  statusCode: number;
  duration: number;
  errors?: { message: string }[];
}

new class EvalServer {
  private server: Application;
  private config: Config;
  private queue: Waiter[] = [];
  private processing: boolean = false;

  constructor(config: Config) {
    this.config = config;
    this.server = express();
    this.server.use(json());
    this.setupRoute();
  }

  private setupRoute() {
    this.server.post(
      '/eval',
      this.authenticate.bind(this),
    async (req: Request, res: Response
  ) => {
    const start = performance.now();
    const result = await this
      .add(req.body.code, req.body.msg)
      .catch(() => res.status(500).send({
        data: [],
        statusCode: 500,
        duration: parseFloat((performance.now() - start).toFixed(4)),
        errors: [{ message: 'Internal server error' }]
      })) as EvalResponse;

      return res.status(200).send({
        data: [String(result)],
        statusCode: 200,
        duration: parseFloat((performance.now() - start).toFixed(4))
      } as EvalResponse);
    });

    this.startServer();
  }

  private async add(code: string, msg: any): Promise<any> {
    return new Promise((resolve, reject) => {
      this.queue.push({ code, msg, resolve, reject } as Waiter);
      this.process();
    });
  }

  private async process() {
    if (this.processing) return;

    this.processing = true;

    while (this.queue.length) {
      const next = this.queue.shift();
      if (!next) continue;

      const { code, msg, resolve, reject } = next as Waiter;
      await this.eval(code, msg).then(resolve).catch(reject);
    }

    this.processing = false;
  }

  private async eval(code: string, msg): Promise<string> {
    const isolate = new Isolate({ memoryLimit: 32 });

    const result = await isolate
      .createContext()
      .then(async (context) => {
        const jail = context.global;

        await jail.set('global', jail.derefInto());

        //if (msg) await jail.set('msg', new Reference(msg, { unsafeInherit: true }));

        await Utils.inject(jail);

        if (/return|await/.test(code)) {
          code = `'use strict'; (async function evaluate() { ${code} })();`;

          await context.evalClosure(`
            evaluate = function() {
              return $0.apply(undefined, [], { result: { promise: true } })
            }`,
            [],
            { arguments: { reference: true } }
          );
        }

        return context.eval(code, { timeout: 2000, promise: true });
      })
      .catch((e) => {return '🚫 ' + e.constructor.name + ': ' + e.message})
      .finally(() => isolate.dispose());

    return this.stringify(result);
  }

  private stringify(result: any): string {
    if (typeof result === 'string') return result;

    if (result instanceof Error) {
      return result.message;
    }

    return inspect(result);
  }

  private authenticate(req: Request, res: Response, next: NextFunction) {
    const auth = req.headers.authorization?.replace(/^Bearer /, '');
    if (auth !== this.config.auth) {
      return res.status(418).send({
        data: [],
        statusCode: 418,
        duration: 0,
        errors: [{ message: 'not today my little bish xqcL' }]
      } as EvalResponse);
    }

    next();
  }

  private startServer() {
    this.server.listen(this.config.port, () => {
      console.log(`Server listening on port ${this.config.port}`);
    });
  }
}(require('./config.json'));
