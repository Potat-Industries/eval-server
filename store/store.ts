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
    primaryKey: string,
    key: string,
    value: unknown,
  ): Promise<number> {
    const validateData = (data: unknown): boolean => {
      if (typeof data === 'string') {
        return data.length <= 10000;
      } else if (typeof data === 'number') {
        return data.toString().length <= 10000;
      } else if (typeof data === 'boolean') {
        return data.toString().length <= 10000;
      } else if (typeof data === 'object') {
        return JSON.stringify(data).length <= 10000;
      } else {
        return false;
      }
    }
    if (!validateData(value)) {
      throw new Error(`Invalid data type: ${typeof value}`);
    }

    const data = typeof value === 'object' ? JSON.stringify(value) : value.toString();
    if (data.length > 10000) {
      throw new Error('Data too large to store in Redis');
    }

    return this.#client.hset(primaryKey, key, data);
  }

  public async hdel(key: string | Buffer, ...fields: string[]): Promise<number> {
    return this.#client.hdel(key, ...fields);
  }

  public async hmget<T = unknown>(
    primaryKey: string,
    key: string,
  ): Promise<T | undefined> {
    const data = await this.#client.hmget(primaryKey, key);
    
    if (!data[0]){
      return;
    }

    try {
      return JSON.parse(data[0]);
    } catch {
      return data[0] as T;
    }
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

  public async hexpire(
    key: string | Buffer,
    seconds: number,
    field: string,
    mode: 'NX' | 'XX' | 'GT' | 'LT' = 'NX',
  ): Promise<unknown> {
    return this.#client.call('HEXPIRE', key, seconds, mode, 'FIELDS', 1, field);
  }
}

const redis = new PotatStore();

const MAX_KEYS = 100;

const get = async (
  privateKey: string,
  key: string,
): Promise<unknown | undefined> => {
  const user = await redis.hmget(privateKey, key);

  return user ?? undefined;
};
  
const set = async (
  privateKey: string,
  key: string, data: unknown,
  expirySeconds: number,
): Promise<unknown | undefined> => {
  const len = await redis.hlen(key);
  if (len > MAX_KEYS) {
    throw new Error(`Too many keys in store: ${key}`);
  }

  await redis.hset(privateKey, key, data);

  if (expirySeconds > 0) {
    await ex(privateKey, key, expirySeconds);
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
  mode: 'NX' | 'XX' | 'GT' | 'LT' = 'NX',
): Promise<unknown | undefined> => {
  return redis.hexpire(privateKey, expiry, key, mode);
};

export const store = {
  get,
  set,
  del,
  ex,
}
