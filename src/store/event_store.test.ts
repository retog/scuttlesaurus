import { defineEventStoreTests } from "./event_store_suite.ts";
import { memoryEventStore } from "./test_util.ts";

defineEventStoreTests("memory", async (overrides) => ({
  store: await memoryEventStore(overrides),
}));
