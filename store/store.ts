import Redis from 'ioredis';
import Logger from '../logger.js';

const config = require('../config.json');

class PotatStore {
  #client: Redis;

  #isReady = false;

  get ready() {
    return this.#isReady;
  }

  public constructor() {
    this.#client = new Redis({
      host: config.redisHost ?? 'localhost',
      port: config.redisPort ?? 6379,
    });

    this.#client.on('close', (err) => {
      this.#isReady = false;
      Logger.error(`Redis Error: ${err}`);
    });
    this.#client.on('error', (err) => Logger.error(`Redis Error: ${err}`));
    this.#client.on('ready', () => this.#isReady = true);

    this.#client.once('ready', () => Logger.debug('Redis Connected'))
  }

  public async hset(
    key: string | Buffer,
    ...args: unknown[]
  ): Promise<number> {
    const stringifiedArgs = [];

    for (const arg of args) {
      if (typeof arg === 'string') {
        stringifiedArgs.push(arg);

        continue;
      }

      stringifiedArgs.push(JSON.stringify(arg));
    }

    return this.#client.hset(key, ...stringifiedArgs);
  }

  public async hdel(key: string | Buffer, ...fields: string[]): Promise<number> {
    return this.#client.hdel(key, ...fields);
  }

  public async hmget<T = unknown>(
    key: string | Buffer,
    ...args: any[]
  ): Promise<T[]> {
    const data = await this.#client.hmget(key, ...args);
    return data.map((d) => {
      if (!d) {
        return null;
      }

      try {
        return JSON.parse(d as string)
      } catch {
        return d;
      }
    }).filter(t => t);
  }

  public async hgetall<T = unknown>(key: string | Buffer): Promise<Map<string, T>> {
    const data = await this.#client.hgetall(key);
    const out = new Map<string, T>();

    for (const k in data) {
      const value = data[k];
      if (!value) {
        continue;
      }

      let parsedValue: T;
      try {
        parsedValue = JSON.parse(value);
      } catch {
        parsedValue = value as T;
      }

      out.set(k, parsedValue);
    }

    return out;
  }

  public async hlen(key: string | Buffer): Promise<number> {
    return this.#client.hlen(key);
  }

  public async hexpire(key: string | Buffer, seconds: number, field: string): Promise<unknown> {
    return this.#client.eval(
      `
        local key = KEYS[1]
        local seconds = ARGV[1]
        local field = ARGV[2]
        local result = redis.call('HEXPIRE', key, seconds, field)
        return result
      `,
      2,
      key,
      seconds,
      field,
    )
  }
}

const redis = new PotatStore();

const MAX_KEYS = 100;

const get = async (
  privateKey: string,
  key: string,
): Promise<unknown | undefined> => {
  const user = await redis.hmget(privateKey, key);
  if (!user[0]) {
    return undefined;
  }

  return user[0];
};
  
const set = async (
  privateKey: string,
  key: string, data: unknown,
  expiry: number,
): Promise<unknown | undefined> => {
  const len = await redis.hlen(key);
  if (len > MAX_KEYS) {
    throw new Error(`Too many keys in store: ${key}`);
  }

  await redis.hset(privateKey, key, data);

  if (expiry > 0) {
    ex(privateKey, key, expiry);
  }

  return get(privateKey, key);
};

const del = async (
  privateKey: string,
  key: string,
): Promise<unknown | undefined> => {
  return redis.hdel(privateKey, key);
}

const ex = async (
  privateKey: string,
  key: string,
  expiry: number,
): Promise<unknown | undefined> => {
  return redis.hexpire(privateKey, expiry, key);
};

export const store = {
  get,
  set,
  del,
  ex,
}
