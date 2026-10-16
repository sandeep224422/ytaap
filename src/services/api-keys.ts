import { MongoClient, type Collection } from "mongodb";

type ApiKeyRecord = {
  userId: string;
  digest: string;
  createdAt: Date;
};

let collectionPromise: Promise<Collection<ApiKeyRecord> | null> | null = null;

async function getCollection(): Promise<Collection<ApiKeyRecord> | null> {
  if (collectionPromise) return collectionPromise;

  collectionPromise = (async () => {
    const uri = Deno.env.get("MONGODB_URI")?.trim();
    if (!uri) return null;

    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 5_000,
      connectTimeoutMS: 5_000,
      maxPoolSize: 5,
    });
    try {
      await client.connect();
      const dbName = Deno.env.get("MONGODB_DB")?.trim() || "zefron";
      const collection = client.db(dbName).collection<ApiKeyRecord>("api_keys");
      await collection.createIndex({ digest: 1 }, { unique: true });

      // Older deployments enforced one key per user. Drop only that index
      // (not its documents) so every previously issued key stays valid.
      const userIdIndex = (await collection.listIndexes().toArray()).find(
        (index) => index.key?.userId === 1,
      );
      if (userIdIndex?.unique) {
        await collection.dropIndex(userIdIndex.name);
      }
      await collection.createIndex({ userId: 1 });
      return collection;
    } catch (error) {
      await client.close().catch(() => {});
      console.warn(
        "MongoDB API-key storage unavailable:",
        error instanceof Error ? error.name : "connection error",
      );
      return null;
    }
  })();

  const collection = await collectionPromise;
  if (!collection) collectionPromise = null;
  return collection;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function digestApiKey(apiKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey));
  return hex(new Uint8Array(digest));
}

export async function issueApiKey(userId: string): Promise<string | null> {
  const collection = await getCollection();
  if (!collection) return null;

  const randomBytes = crypto.getRandomValues(new Uint8Array(32));
  const apiKey = `zefronapi_${hex(randomBytes)}`;
  await collection.insertOne({
    userId,
    digest: await digestApiKey(apiKey),
    createdAt: new Date(),
  });
  return apiKey;
}

export async function revokeApiKey(userId: string): Promise<boolean> {
  const collection = await getCollection();
  if (!collection) return false;
  const result = await collection.deleteMany({ userId });
  return result.deletedCount > 0;
}

export async function isValidApiKey(apiKey: string | null): Promise<boolean | null> {
  // Keep already-issued zf_ keys working until each user replaces one via /apikey.
  if (!apiKey || !/^(?:zefronapi_|zf_)[a-f0-9]{64}$/.test(apiKey)) return false;
  const collection = await getCollection();
  if (!collection) return null;
  try {
    return Boolean(await collection.findOne({ digest: await digestApiKey(apiKey) }));
  } catch (error) {
    console.warn(
      "MongoDB API-key lookup failed:",
      error instanceof Error ? error.name : "database error",
    );
    return null;
  }
}
