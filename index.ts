import os from "node:os";
import Cluster from "node:cluster";
import { ExternalCopy, Isolate, Reference, Copy } from "isolated-vm";
import { Agent, fetch, Pool } from 'undici';
import dns from "dns";
import ip from 'ip';
import { Utils } from "./sandbox-utils.js";
import { EvalSocket, EvalResponse, EvalServer } from "./server";

const config = require('./config.json');

export interface Config {
  port: number;
  auth: string;
  queueSize: number;

  fetchTimeout: number;
  fetchMaxResponseLength: number;
  maxFetchConcurrency: number;

  vmMemoryLimit: number;
  vmTimeout: number;

  maxChildProcessCount: number;
}

const defaultConfig: Partial<Config> = {
  fetchTimeout: 5000,
  fetchMaxResponseLength: 10000,
  maxFetchConcurrency: 5,
  queueSize: 20,

  vmMemoryLimit: 32,
  vmTimeout: 10000,

  maxChildProcessCount: os.availableParallelism(),
}

interface Waiter {
  code: string;
  msg: any;
  resolve: (value: any) => void;
  reject: (reason: any) => void;
}

interface EvalPotatData {
  user: Record<string, any> | undefined,
  channel: Record<string, any> | undefined,
  id: string,
  timestamp: number,
  platform: string,
  isSilent: boolean,
};

interface EvalWorker {
  readonly isReady: boolean,
  readonly queueSize: number,
  readonly eval: (code: string, msg: Record<string, any>, timeout: number) => Promise<string>;
};

interface EvalWorkerRequest {
  type: 'EvalRequest';
  code: string;
  msg: Record<string, any>;
  id: number;
}

interface EvalWorkerResponse {
  type: 'EvalResponse';
  data: EvalResponse;
  id: number;
}

export class Evaluator {
  private queue: Waiter[] = [];
  private processing: boolean = false;
  private concurrencyCounter: number = 0;

  private workers: EvalWorker[] = [];

  public constructor(private readonly config: Config) {
    if (Cluster.isPrimary) {
      this.startServer();

      for (let i = 0; i < Math.max(1, this.config.maxChildProcessCount); i++) {
        console.log('Forking new worker', i);
        this.forkWorker();
      }
    } else {
      this.worker();
    }
  }

  private async startServer() {
    const httpServer = new EvalServer(this.config.auth, this.handleEvalRequests.bind(this));

    const server = httpServer.listen(this.config.port, () => {
      console.log(`Server listening on port ${this.config.port}`);
    });

    new EvalSocket(server, this.config.auth, this.handleEvalRequests.bind(this));
  }

  private async forkWorker() {
    this.workers.push(new class {
      private requestsHandler: ((
        code: string,
        msg: Record<string, any>,
        id: number,
        callback: (m: EvalResponse) => void
      ) => void) | undefined;

      private id = 0;

      private queueSizeValue: { value: number } | undefined;

      public get isReady() {
        return typeof this.requestsHandler === 'function';
      }

      public get queueSize() {
        return this.queueSizeValue?.value ?? 0;
      }

      constructor() {
        this.keepWorkerAlive();
      }

      public eval(code: string, msg: Record<string, any>, timeout: number): Promise<string> {
        return new Promise((resolve, reject) => {
          let tm = setTimeout(() => {
            reject(new Error('Worker timed out'));
          }, timeout);

          if (!this.isReady) {
            return reject(new Error('Worker is not ready'));
          }

          const watcher = (m) => {
            resolve(m);
            clearTimeout(tm);
          };

          this.requestsHandler!(code, msg, this.id++, watcher);
        });
      }

      private async keepWorkerAlive() {
        while (true) {
          try {
            const abortController = new AbortController();
            const worker = Cluster.fork();
            const callbacks = new Map<number, (m: EvalResponse) => void>();
            const queueSizeValue = { value: 0 };
            let lastRequest = 0;
            let lastResponse = 0;

            this.queueSizeValue = queueSizeValue;
            this.requestsHandler = (code: string, msg: Record<string, any>, id: number, callback: (m: EvalResponse) => void) => {
              // didn't receive a response for more than 1 minute
              if (lastRequest > lastResponse && Date.now() - lastRequest > 6e4) {
                abortController.abort();

                return callback({
                  data: [],
                  statusCode: 500,
                  duration: 0,
                  errors: [{ message: 'Worker is not responding' }],
                });
              }

              queueSizeValue.value = queueSizeValue.value + 1;
              worker.send({ type: 'EvalRequest', code, msg, id });
              lastRequest = Date.now();
              callbacks.set(id, callback);
            }


            worker.addListener('message', (m: EvalWorkerResponse) => {
              if (m.type === 'EvalResponse') {
                lastResponse = Date.now();
                queueSizeValue.value = queueSizeValue.value - 1;

                callbacks.get(m.id)?.(m.data);
              }
            });

            await new Promise<void>(async (resolve, reject) => {
              worker?.on('exit', (code) => {
                if (code === 0) {
                  resolve();
                } else {
                  reject(`Worker exited with code ${code}`);
                }
              });

              worker?.on('error', reject);

              abortController.signal.addEventListener('abort', () => {
                try {
                  reject(new Error('Worker is not responding'));
                  worker.kill('SIGKILL');
                } catch (e) {
                  console.error('Failed to kill worker:', e);
                }
              })
            });

            this.requestsHandler = undefined;
          } catch (e) {
            console.error('Worker died', e);
          }

          await new Promise((resolve) => setTimeout(resolve, 1000));
          console.error('Forking new worker...');
        }
      }
    });
  }

  private worker() {
    process.addListener('message', async (m: EvalWorkerRequest) => {
      if (m.type === 'EvalRequest') {
        try {
          const result = await this.add(m.code, m.msg);

          process.send({
            type: 'EvalResponse',
            id: m.id,
            data: [String(result)],
            statusCode: 200,
            duration: NaN,
          });
        } catch (e) {
          console.error(e);

          process.send({
            type: 'EvalResponse',
            id: m.id,
            data: [],
            statusCode: 500,
            duration: NaN,
            errors: [{
              message: String(e)
            }],
          });
        }
      }
    });
  }

  private async handleEvalRequests(code: string, msg: any): Promise<EvalResponse> {
    const start = performance.now();
    const duration = () => parseFloat((performance.now() - start).toFixed(4));

    if (!code || typeof code !== "string") {
      return {
        statusCode: 400,
        data: [],
        duration: duration(),
        errors: [{
          message: typeof code !== "string" ? "Invalid code" : "Missing code"
        }],
      };
    }

    if (msg && typeof msg !== "object") {
      return {
        statusCode: 400,
        data: [],
        duration: duration(),
        errors: [{ message: "Invalid message" }],
      };
    }

    try {
      const worker = this.pickWorker();
      const result = await worker.eval(code, msg, this.config.vmTimeout);

      return {
        statusCode: 200,
        data: [result],
        duration: duration(),
      }
    } catch (e) {
      console.error(e);

      return {
        statusCode: 500,
        data: [],
        duration: parseFloat((performance.now() - start).toFixed(4)),
        errors: [{ message: "Internal server error" }],
      }
    }
  }

  private pickWorker() {
    const worker = this.workers
      .filter(w => w.isReady)
      .sort((a, b) => a.queueSize - b.queueSize)[0];

    if (!worker) {
      throw new Error("No workers available");
    }

    return worker;
  }

  private async add(code: string, msg: any): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.queue.length > this.config.queueSize) reject("Queue is full");
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

  private async eval(code: string, msg?: Record<string, any>): Promise<string> {
    return new Promise(async (resolve, reject) => {
      try {
        const isolate = new Isolate({
          memoryLimit: 8,
          onCatastrophicError: (e) => {
            reject(e);
          }
        });

        const result = await isolate
          .createContext()
          .then(async (context) => {
            const jail = context.global;

            await jail.set("global", jail.derefInto());

            delete msg?.channel?.commands;
            delete msg?.command?.description;
            delete msg?.channel?.blocks;

            const potatData: EvalPotatData = {
              user: msg?.user,
              channel: msg?.channel,
              id: `${msg?.id ?? ""}`,
              timestamp: msg?.timestamp ?? Date.now(),
              isSilent: !!msg?.command?.silent,
              platform: msg?.platform ?? "PotatEval",
            };

            const prelude = `
              'use strict';

              function toString(value) {
                if (typeof value === 'string') return value;
                if (value instanceof Error) return value.constructor.name + ': ' + value.message;
                if (value instanceof Promise) return value.then(toString);
                if (Array.isArray(value)) return value.map(toString).join(', ');
                return JSON.stringify(value);
              }

              let msg = JSON.parse(${JSON.stringify(JSON.stringify(msg ?? {}))});
            `;

            await context.evalClosure(`
              global.fetch = (url, options) => $0.apply(undefined, [url, options], {
                  arguments: { copy: true },
                  promise: true,
                  result: { copy: true, promise: true }
                })
              `,
              [new Reference(this.fetchImplement.bind(this, potatData))],
            );

            await Utils.inject(jail);

            if (/return|await/.test(code)) {
              code = prelude + `toString((async function evaluate() { ${code} })());`;

              await context.evalClosure(
                `
                evaluate = function() {
                  return $0.apply(undefined, [], { result: { promise: true } })
                }`,
                [],
                { arguments: { reference: true } }
              );
            } else {
              code = prelude + `toString(eval('${code?.replace(/[\\"']/g, "\\$&")}'))`;
            }

            return context.eval(code, { timeout: 5000, promise: true });
          })
          .catch((e) => { return '🚫 ' + e.constructor.name + ': ' + e.message; })
          .finally(() => isolate.dispose());

        this.concurrencyCounter = 0;

        resolve((result ?? null)?.slice(0, 3000));
      } catch (e) {
        reject(e);
      }
    });
  }

  private async fetchImplement(potatData: EvalPotatData, url: string, options: Record<string, any>): Promise<Copy<any>> {
    this.concurrencyCounter++;

    try {
      if (this.concurrencyCounter > this.config.maxFetchConcurrency) {
        return new ExternalCopy({
          body: 'Too many requests.',
          status: 429
        }).copyInto();
      }

      const res = await fetch(url, {
        ...options ?? {},
        signal: this.timeout(),
        dispatcher: new Agent({
          connect: {
            lookup: this.dnsLookup.bind(this),
          },
          factory: this.dispatcherFactory.bind(this),
        }),
        headers: {
          ...options?.headers ?? {},
          'User-Agent': 'Sandbox Unsafe JavaScript Execution Environment - https://github.com/RyanPotat/eval-server/',
          'x-potat-data': JSON.stringify(potatData),
        }
      })

      return new ExternalCopy({
        body: await this.parseBlob(await res.blob()), status: res.status
      }).copyInto();
    } catch (e) {
      // Promise aborted by timeout.
      if (e.constructor.name === 'DOMException') {
        return new ExternalCopy({
          body: 'Request timed out.',
          status: 408
        }).copyInto();
      }
      return new ExternalCopy({
        body: `Request failed - ${e.constructor.name}: ${e.cause ?? e.message}`,
        status: 400
      }).copyInto();
    } finally {
      this.concurrencyCounter--;
    }
  }

  private timeout() {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5000);
    return controller.signal;
  }

  private dnsLookup(hostname: string, options: dns.LookupOptions, cb: (e: Error | null, address?: string | dns.LookupAddress[], family?: number) => void) {
    dns.lookup(hostname, options, (err, addr, fam) => {
      if (err !== null) {
        return cb(err);
      }

      const addresses = Array.isArray(addr) ? addr : [addr];

      try {
        for (const lookupAddress of addresses) {
          const value = typeof lookupAddress === 'string' ? lookupAddress : lookupAddress.address;

          this.throwIfPrivateIP(value);
        }
      } catch (e) {
        return cb(e);
      }

      cb(null, addr, fam);
    });
  }

  private dispatcherFactory(origin: string, options: Pool.Options) {
    const url = new URL(origin);

    if (ip.isV4Format(url.hostname) || ip.isV6Format(url.hostname)) {
      this.throwIfPrivateIP(url.hostname);
    }

    return new Pool(origin, options);
  }

  private throwIfPrivateIP(i: string) {
    if (ip.isPrivate(i)) {
      throw new Error(`Access to ${i} is disallowed`);
    }
  }

  private async parseBlob(blob: Blob): Promise<string> {
    let data: any;
    try { data = JSON.parse(await blob.text()); }
    catch { data = await blob.text(); }
    return data;
  }
}

new Evaluator({
  ...defaultConfig,
  ...config
});
