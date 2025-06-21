import Redis from 'ioredis';
import Logger from '../util/logger.js';
import config from '../../config.json' with { type: 'json' };

const validateData = (data: unknown): data is 'string' | 'number' | 'boolean' | 'object' => {
  if (typeof data === 'string') {
    return data.length <= 10000;
  } else if (typeof data === 'number') {
    return data.toString().length <= 10000;
  } else if (typeof data === 'boolean') {
    return true;
  } else if (typeof data === 'object') {
    return JSON.stringify(data).length <= 10000;
  } else {
    return false;
  }
};

class PotatStore {
  static #instance: PotatStore;

  #client: Redis;
  #isReady = false;

  get ready() {
    return this.#isReady;
  }

  public constructor() {    
    this.#client = new Redis({
      host: config.redisHost ?? 'localhost',
      port: config.redisPort ?? 6777,
    });

    this.#client.on('close', (err: Error) => {
      this.#isReady = false;
      Logger.error(`Redis Error: ${err}`);
    });
    this.#client.on('error', (err) => Logger.error(`Redis Error: ${err}`));
    this.#client.on('ready', () => this.#isReady = true);
    this.#client.once('ready', () => Logger.debug('Redis Connected'));
  }

  public static get getInstance(): PotatStore {
    if (!this.#instance) {
      this.#instance = new PotatStore();
    }
    return this.#instance;
  }

  public async hset(
    primaryKey: string,
    key: string,
    value: unknown,
  ): Promise<number> {
    if (typeof key !== 'string' || key.length > 100) {
      throw new Error('Key mmust be a string less than 100 characters');
    }
    if (!validateData(value)) {
      throw new Error(`Invalid value input.`);
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

const store = PotatStore.getInstance;

export default store;