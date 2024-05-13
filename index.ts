import express, { Request, Response, Application, NextFunction } from 'express';
import { Isolate } from 'isolated-vm';
import { inspect } from 'node:util';
import { Utils } from './sandbox-utils.js';

interface Config {
  port: number;
  auth: string;
}

new class EvalServer {
  private server: Application;

  private config: Config;

  constructor(config: Config) {
    this.config = config;
    this.server = express();
    this.server.use(express.json());
    this.setupRoute();
    this.startServer();
  }

  private setupRoute() {
    this.server.post(
      '/eval',
      this.authenticate.bind(this),
      async (req: Request, res: Response
    ) => {
      const result = await this
        .eval(req.body.code, req.body.msg)
        .catch(() => res.status(500).send({
          data: [],
          status: 500,
          errors: [{ message: 'Internal server error' }]
        }));

      return res.status(200).send({
        data: [String(result)],
        status: 200
      });
    })
  }

  private async eval(code: string, msg) {
    const isolate = new Isolate({ memoryLimit: 128 }); 

    const result = await isolate
      .createContext()
      .then(async (context) => {
        const jail = context.global;

        await jail.set('global', jail.derefInto());

        await Utils.inject(jail);

        if (/return|await/.test(code)) {
          code = `'use strict'; (async function evaluate() { ${code} })();`;

          context.evalClosure(`
            evaluate = function() {
              return $0.apply(undefined, [], { result: { promise: true } })
            }`,
            [],
            { arguments: { reference: true } }
          )
        } 

        return context.eval(code, { timeout: 5000, promise: true });
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
      return res.status(418).send('elis');
    }

    next();
  }

  private startServer() {
    this.server.listen(this.config.port, () => {
      console.log(`Server listening on port ${this.config.port}`);
    });
  }
}(require('./config.json'));
