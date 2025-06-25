import redis from './redis.js';

const checkReady = (): void => {
  if (!redis.ready) {
    throw new Error('Redis store is not initialized');
  }
};

const MAX_KEYS = 100;

const get = async (
  privateKey: string,
  key: string,
): Promise<unknown | undefined> => {
  checkReady();

  return redis.hmget(privateKey, key) ?? undefined;
};
  
const set = async (
  privateKey: string,
  key: string,
  data: unknown,
  expirySeconds: number,
): Promise<unknown | undefined> => {
  checkReady();

  const len = await redis.hlen(privateKey);
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
  checkReady();

  return redis.hdel(privateKey, key);
};

const delall = async (
  privateKey: string,
): Promise<number> => {
  checkReady();
  
  return redis.del(privateKey);
};

const ex = async (
  privateKey: string,
  key: string,
  expiry: number,
  mode: 'NX' | 'XX' | 'GT' | 'LT' = 'NX',
): Promise<unknown | undefined> => {
  checkReady();

  return redis.hexpire(privateKey, expiry, key, mode);
};

const len = async (privateKey: string): Promise<number> => {
  checkReady();

  return redis.hlen(privateKey);
};

export const store = {
  get,
  set,
  del,
  delall,
  len,
  ex,
};
