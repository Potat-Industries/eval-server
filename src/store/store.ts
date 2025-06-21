import redis from './redis.js';

const MAX_KEYS = 100;

const get = async (
  privateKey: string,
  key: string,
): Promise<unknown | undefined> => {
  if (!redis.ready) {
    throw new Error('Redis store is not initialized');
  }
  const user = await redis.hmget(privateKey, key);

  return user ?? undefined;
};
  
const set = async (
  privateKey: string,
  key: string,
  data: unknown,
  expirySeconds: number,
): Promise<unknown | undefined> => {
  if (!redis.ready) {
    throw new Error('Redis store is not initialized');
  }

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
  if (!redis.ready) {
    throw new Error('Redis store is not initialized');
  }

  return redis.hdel(privateKey, key);
};

const ex = async (
  privateKey: string,
  key: string,
  expiry: number,
  mode: 'NX' | 'XX' | 'GT' | 'LT' = 'NX',
): Promise<unknown | undefined> => {
  if (!redis.ready) {
    throw new Error('Redis store is not initialized');
  }

  return redis.hexpire(privateKey, expiry, key, mode);
};

const len = async (privateKey: string): Promise<number> => {
  if (!redis.ready) {
    throw new Error('Redis store is not initialized');
  }

  return redis.hlen(privateKey);
};

export const store = {
  get,
  set,
  del,
  len,
  ex,
};
