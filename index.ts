import os from "node:os";
import Cluster from "node:cluster";
import { ExternalCopy, Isolate, Reference, Copy } from "isolated-vm";
import { Agent, fetch, Pool } from 'undici';
import dns from "dns";
import ip from 'ip';
import { Utils } from "./sandbox-utils.js";
import { EvalSocket, EvalResponse, EvalServer } from "./server";
import { PotatWorkersPool } from "./workers";
import Logger from "./logger";

const config = require('./config.json');

export interface Config {
  port: number;
  auth: string;
  queueSize: number;

  fetchTimeout: number;
  fetchMaxResponseLength: number;
  maxFetchConcurrency: number;

  workersTimeOut: number;

  vmMemoryLimit: number;
  vmTimeout: number;

  maxChildProcessCount: number;
}

const defaultConfig: Partial<Config> = {
  fetchTimeout: 15000,
  fetchMaxResponseLength: 10000,
  maxFetchConcurrency: 5,
  queueSize: 20,

  workersTimeOut: 6e5,

  vmMemoryLimit: 32,
  vmTimeout: 14000,

  maxChildProcessCount: os.availableParallelism(),
}

interface Waiter {
  code: string;
  msg: any;
  resolve: (value: any) => void;
  reject: (reason: any) => void;
}

interface EvalPotatData {
  parent?: EvalPotatData;
  user: Record<string, any> | undefined;
  channel: Record<string, any> | undefined;
  id: string;
  timestamp: number;
  platform: string;
  isSilent: boolean;
  emotes: Array<MessageFragmentEmote>;
  fragments: Array<MessageFragment>;
};

interface MessageFragment {
  readonly text: string;
  readonly flag?: string;
  readonly value?: 'boolean' |
     'string' |
     'platform' |
     'number' |
     '+int' |
     '-int' |
     '+number' |
     '-number' |
     'regex';
  readonly emote?: MessageFragmentEmote;
  readonly mention?: Mention;
  readonly link?: URL;
  readonly translatable: boolean;
}

interface Mention {
  readonly name: string;
  readonly id: string;
  readonly type: 'user' | 'role' | 'everyone' | 'here';
}

interface MessageFragmentEmote {
  readonly id: string;
  readonly name: string;
  readonly alias?: string;
  readonly url?: string;
}

export class Evaluator {
  private queue: Waiter[] = [];
  private processing: boolean = false;
  private concurrencyCounter: number = 0;

  private readonly pool: PotatWorkersPool<typeof this.add>;

  public constructor(private readonly config: Config) {
    if (Cluster.isPrimary) {
      this.startServer();
    }

    this.pool = new PotatWorkersPool(this.add.bind(this), Math.max(1, config.maxChildProcessCount), {
      maxQueueSizePerWorker: this.config.queueSize,

      workerTimeOut: this.config.workersTimeOut,
      workerExecutionTimeout: this.config.vmTimeout,
    });
  }

  private async startServer() {
    const httpServer = new EvalServer(this.config.auth, this.handleEvalRequests.bind(this));

    const server = httpServer.listen(this.config.port, () => {
      Logger.debug(`Server listening on port ${this.config.port}`);
    });

    new EvalSocket(server, this.config.auth, this.handleEvalRequests.bind(this));
  }

  private async handleEvalRequests(code: string, msg: any): Promise<EvalResponse> {
    const start = performance.now();
    const duration = () => parseFloat((performance.now() - start).toFixed(4));

    Logger.debug(
      `Evaluating code: ${code.length > 30 ? code.slice(0, 30) + '...' : code}`,
    );

    if (!code || typeof code !== "string") {
      Logger.error(`Invalid code supplied: ${code}`);
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
      Logger.error(`Invalid message supplied: ${msg}`);
      return {
        statusCode: 400,
        data: [],
        duration: duration(),
        errors: [{ message: "Invalid message" }],
      };
    }

    try {
      const result = await this.pool.add(code, msg);

      return {
        statusCode: 200,
        duration: duration(),
        data: [String(result)],
        errors: [],
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);

      Logger.error(`Error evaluating code: ${message}`);
      return {
        statusCode: 500,
        data: [],
        duration: duration(),
        errors: [{ message: message || "Internal server error" }],
      }
    }
  }

  private async add(code: string, msg: any): Promise<string> {
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

  private filterMessage(msg: Record<string, any>): EvalPotatData | undefined {
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
      emotes: msg?.emotes ?? [],
      fragments: msg?.fragments ?? [],
    };

    if (msg.parent) {
      potatData.parent = this.filterMessage(msg.parent);
    }

    return potatData;
  }

  private makePotatDataHeaders(potatData: EvalPotatData | undefined, id=0): Record<string, any> | undefined {
    if (!potatData) {
      return;
    }

    const {parent, ...msg} = potatData;

    const name = 'x-potat-data' + (id ? '-' + id : '');
    const value = encodeURIComponent(JSON.stringify(msg));

    return {
      ...this.makePotatDataHeaders(parent, id + 1),
      [name]: value
    };
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

            const potatData = this.filterMessage(msg);

            const prelude = `
              'use strict';

              function toString(value) {
                if (typeof value === 'string') return value;
                if (value instanceof Error) return value.constructor.name.concat(': ', value.message);
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

            return context.eval(code, { timeout: this.config.vmTimeout + 1e3, promise: true });
          })
          .catch((e) => { return '🚫 ' + e.constructor.name + ': ' + e.message; })
          .finally(() => isolate.dispose());

        this.concurrencyCounter = 0;

        resolve((result ?? null)?.slice(0, this.config.fetchMaxResponseLength));
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
          ...(options?.withDataHeaders || url.startsWith('https://fun.joet.me') ? this.makePotatDataHeaders(potatData) : {}),
        }
      })

      return new ExternalCopy({
        body: await this.parseBlob(await res.blob()), status: res.status
      }).copyInto();
    } catch (e) {
      // Promise aborted by timeout.
      if (e.constructor.name === 'DOMException') {
        Logger.warn(`Evaluation request timed out: ${e.message}`);
        return new ExternalCopy({
          body: 'Request timed out.',
          status: 408
        }).copyInto();
      }
      Logger.warn(`Evaluation api request failed: ${e.message}`);
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
    setTimeout(() => controller.abort(), this.config.fetchTimeout);
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

    const ipv6adresss = url.hostname.match(/^\[(.*)\]$/);

    if (ip.isV6Format(ipv6adresss?.[1])) {
      this.throwIfPrivateIP(ipv6adresss?.[1]);
    }

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
}(config);

const configuration = {
  ...defaultConfig,
  ...config
} as Config;

new Evaluator(configuration);
