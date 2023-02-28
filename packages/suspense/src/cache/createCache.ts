import {
  STATUS_NOT_STARTED,
  STATUS_PENDING,
  STATUS_REJECTED,
  STATUS_RESOLVED,
} from "../constants";
import { createDeferred } from "../utils/createDeferred";
import {
  Cache,
  CacheLoadOptions,
  Record,
  Status,
  StatusCallback,
  Thenable,
  UnsubscribeCallback,
} from "../types";
import { assertPendingRecord } from "../utils/assertPendingRecord";
import { isThenable } from "../utils/isThenable";
import { isPendingRecord } from "../utils/isPendingRecord";
import { WeakRefMap } from "../utils/WeakRefMap";

export type CreateCacheOptions<Params extends Array<any>, Value> = {
  config?: {
    useWeakRef?: boolean;
  };
  debugLabel?: string;
  getKey?: (...params: Params) => string;
  load: (...params: [...Params, CacheLoadOptions]) => Thenable<Value> | Value;
};

// Enable to help with debugging in dev
const DEBUG_LOG_IN_DEV = false;

const WearRefMapSymbol = Symbol.for("WearRefMap");

export function createCache<Params extends Array<any>, Value>(
  options: CreateCacheOptions<Params, Value>
): Cache<Params, Value> {
  const { config = {}, debugLabel, getKey = defaultGetKey, load } = options;
  const { useWeakRef = true } = config;

  const debugLogInDev = (debug: string, params?: Params, ...args: any[]) => {
    if (DEBUG_LOG_IN_DEV && process.env.NODE_ENV === "development") {
      const cacheKey = params ? `"${getKey(...params)}"` : "";
      const prefix = debugLabel ? `createCache[${debugLabel}]` : "createCache";

      console.log(
        `%c${prefix}`,
        "font-weight: bold; color: yellow;",
        debug,
        cacheKey,
        ...args
      );
    }
  };

  debugLogInDev("Creating cache ...");

  const recordMap = new Map<string, Record<Value>>();
  const subscriberMap = new Map<string, Set<StatusCallback>>();
  const weakRefMap = new WeakRefMap<string, Value>((cacheKey: string) => {
    recordMap.delete(cacheKey);
    subscriberMap.delete(cacheKey);
  });

  function abort(...params: Params): boolean {
    const cacheKey = getKey(...params);
    const record = recordMap.get(cacheKey);
    if (record && isPendingRecord(record)) {
      debugLogInDev("abort()", params);

      recordMap.delete(cacheKey);
      weakRefMap.delete(cacheKey);

      record.value.abortController.abort();

      notifySubscribers(...params);

      return true;
    }

    return false;
  }

  function cache(value: Value, ...params: Params): void {
    const cacheKey = getKey(...params);
    const record: Record<Value> = {
      status: STATUS_RESOLVED,
      value: null,
    };

    writeRecordValue(record, value, ...params);

    debugLogInDev("cache()", params, value);

    recordMap.set(cacheKey, record);
  }

  function evict(...params: Params): boolean {
    const cacheKey = getKey(...params);

    debugLogInDev(`evict()`, params);

    weakRefMap.delete(cacheKey);

    return recordMap.delete(cacheKey);
  }

  function evictAll(): boolean {
    debugLogInDev(`evictAll()`, undefined, `${recordMap.size} records`);

    const hadRecords = recordMap.size > 0;

    recordMap.clear();

    return hadRecords;
  }

  function getOrCreateRecord(...params: Params): Record<Value> {
    const cacheKey = getKey(...params);

    let record = recordMap.get(cacheKey);
    if (record == null) {
      const abortController = new AbortController();
      const deferred = createDeferred<Value>(
        debugLabel ? `${debugLabel} ${cacheKey}}` : cacheKey
      );

      record = {
        status: STATUS_PENDING,
        value: {
          abortController,
          deferred,
        },
      } as Record<Value>;

      recordMap.set(cacheKey, record);

      notifySubscribers(...params);

      processPendingRecord(abortController.signal, record, ...params);
    }

    return record;
  }

  function getStatus(...params: Params): Status {
    const cacheKey = getKey(...params);
    const record = recordMap.get(cacheKey);

    return record?.status ?? STATUS_NOT_STARTED;
  }

  function getValue(...params: Params): Value {
    const cacheKey = getKey(...params);
    const record = recordMap.get(cacheKey);

    if (record == null) {
      throw Error("No record found");
    } else if (record.status !== STATUS_RESOLVED) {
      throw Error(`Record found with status "${record.status}"`);
    } else {
      return readRecordValue(record, ...params);
    }
  }

  function getValueIfCached(...params: Params): Value | undefined {
    const cacheKey = getKey(...params);
    const record = recordMap.get(cacheKey);

    if (record?.status === STATUS_RESOLVED) {
      return readRecordValue(record, ...params);
    }
  }

  function prefetch(...params: Params): void {
    debugLogInDev(`prefetch()`, params);

    fetchAsync(...params);
  }

  function fetchAsync(...params: Params): Thenable<Value> | Value {
    const record = getOrCreateRecord(...params);
    switch (record.status) {
      case STATUS_PENDING:
        return record.value.deferred;
      case STATUS_RESOLVED:
        return readRecordValue(record, ...params);
      case STATUS_REJECTED:
        throw record.value;
    }
  }

  function fetchSuspense(...params: Params): Value {
    const record = getOrCreateRecord(...params);
    if (record.status === STATUS_RESOLVED) {
      return readRecordValue(record, ...params);
    } else if (isPendingRecord(record)) {
      throw record.value.deferred;
    } else {
      throw record.value;
    }
  }

  function notifySubscribers(...params: Params): void {
    const cacheKey = getKey(...params);
    const set = subscriberMap.get(cacheKey);
    if (set) {
      const status = getStatus(...params);
      set.forEach((callback) => {
        callback(status);
      });
    }
  }

  async function processPendingRecord(
    abortSignal: AbortSignal,
    record: Record<Value>,
    ...params: Params
  ) {
    assertPendingRecord(record);

    const { abortController, deferred } = record.value;

    try {
      const valueOrThenable = load(...params, abortController);
      const value = isThenable(valueOrThenable)
        ? await valueOrThenable
        : valueOrThenable;

      if (!abortSignal.aborted) {
        record.status = STATUS_RESOLVED;

        writeRecordValue(record, value, ...params);

        deferred.resolve(value);
      }
    } catch (error) {
      if (!abortSignal.aborted) {
        record.status = STATUS_REJECTED;
        record.value = error;

        deferred.reject(error);
      }
    } finally {
      if (!abortSignal.aborted) {
        notifySubscribers(...(params as unknown as Params));
      }
    }
  }

  function readRecordValue(record: Record<Value>, ...params: Params): Value {
    const value = record.value;
    if (value === WearRefMapSymbol) {
      const cacheKey = getKey(...params);
      return weakRefMap.get(cacheKey);
    } else {
      return value;
    }
  }

  function subscribeToStatus(
    callback: StatusCallback,
    ...params: Params
  ): UnsubscribeCallback {
    const cacheKey = getKey(...params);
    let set = subscriberMap.get(cacheKey);
    if (set) {
      set.add(callback);
    } else {
      set = new Set([callback]);
      subscriberMap.set(cacheKey, set);
    }

    try {
      const status = getStatus(...params);

      callback(status);
    } finally {
      return () => {
        set!.delete(callback);
        if (set!.size === 0) {
          subscriberMap.delete(cacheKey);
        }
      };
    }
  }

  function writeRecordValue(
    record: Record<Value>,
    value: Value,
    ...params: Params
  ): void {
    if (useWeakRef && value != null && typeof value === "object") {
      record.value = WearRefMapSymbol;

      const cacheKey = getKey(...params);
      weakRefMap.set(cacheKey, value);
    } else {
      record.value = value;
    }
  }

  return {
    abort,
    cache,
    evict,
    evictAll,
    getStatus,
    getValue,
    getValueIfCached,
    fetchAsync,
    fetchSuspense,
    prefetch,
    subscribeToStatus,
  };
}

function defaultGetKey(...params: any[]): string {
  return params.join(",");
}
