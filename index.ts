
import { ExternalCopy, Isolate, Reference, Copy } from "isolated-vm";
import { Agent, fetch, Pool } from 'undici';
import { Utils } from "./sandbox-utils.js";
import dns from "dns";
import ip from 'ip';
import { EvalSocket } from "server/socket.js";
import { EvalServer } from "server/http.js";

const config = require('./config.json');

EvalServer.new(config);
EvalSocket.new(config);

export interface Config {
  port: number;
  wssPort: number;
  auth: string;
  maxFetchConcurrency: number;
  queueSize: number;
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
export class Evaluator {
  private static instance: Evaluator;
  
  private queue: Waiter[] = [];
  private processing: boolean = false;
  private concurrencyCounter: number = 0;

  private readonly MAX_CONCURRENCY: number;
  private readonly QUEUE_SIZE: number;

  private constructor(config: Config) {
    this.MAX_CONCURRENCY = config.maxFetchConcurrency ?? 5;
    this.QUEUE_SIZE = config.queueSize ?? 20;
  }

  public static new(config: Config): Evaluator {
    return this.instance ?? (this.instance = new this(config));
  }

  public async add(code: string, msg: any): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.queue.length > this.QUEUE_SIZE) reject("Queue is full");
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

              let msg = JSON.parse(${JSON.stringify(JSON.stringify(msg))});
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
      if (this.concurrencyCounter > this.MAX_CONCURRENCY) {
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