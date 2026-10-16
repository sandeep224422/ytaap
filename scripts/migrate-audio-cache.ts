import { MongoClient } from "mongodb";
import postgres from "postgres";

type LegacyAudioCacheRecord = {
  videoId: string;
  format: "original" | "mp3";
  url: string;
  title: string;
  contentType: string;
  size: number;
  provider: "google-drive" | "telegram";
  driveFileId: string | null;
  telegramFileId: string | null;
  telegramMessageId: number | null;
  createdAt: Date;
};

const postgresUrl = Deno.env.get("DATABASE_URL")?.trim();
const mongoUri = Deno.env.get("MONGODB_URI")?.trim();
if (!postgresUrl) throw new Error("DATABASE_URL is required to read the legacy audio cache.");
if (!mongoUri) throw new Error("MONGODB_URI is required to write the MongoDB audio cache.");

const sql = postgres(postgresUrl, {
  max: 1,
  connect_timeout: 10,
  idle_timeout: 10,
  prepare: false,
});
const mongo = new MongoClient(mongoUri, {
  serverSelectionTimeoutMS: 10_000,
  connectTimeoutMS: 10_000,
});

try {
  const [records] = await Promise.all([
    sql<LegacyAudioCacheRecord[]>`
      SELECT
        video_id AS "videoId",
        format,
        url,
        title,
        content_type AS "contentType",
        size::int AS size,
        provider,
        drive_file_id AS "driveFileId",
        telegram_file_id AS "telegramFileId",
        telegram_message_id::int AS "telegramMessageId",
        created_at AS "createdAt"
      FROM audio_cache
    `,
    mongo.connect(),
  ]);

  const dbName = Deno.env.get("MONGODB_DB")?.trim() || "zefron";
  const collection = mongo.db(dbName).collection("audio_cache");
  await collection.createIndex({ videoId: 1, format: 1 }, { unique: true });

  let upserted = 0;
  let matched = 0;
  for (let start = 0; start < records.length; start += 500) {
    const batch = records.slice(start, start + 500);
    const result = await collection.bulkWrite(
      batch.map((record) => {
        const { url: _legacyUrl, ...fields } = record;
        return {
          replaceOne: {
            filter: { videoId: record.videoId, format: record.format },
            replacement: {
              ...fields,
              url: record.provider === "telegram" ? "" : record.url,
              createdAt: new Date(record.createdAt),
            },
            upsert: true,
          },
        };
      }),
      { ordered: false },
    );
    upserted += result.upsertedCount;
    matched += result.matchedCount;
  }

  console.log(JSON.stringify({
    state: "migration_complete",
    database: dbName,
    collection: "audio_cache",
    sourceRecords: records.length,
    inserted: upserted,
    existingRecordsUpdated: matched,
  }));
} catch (error) {
  // Driver exceptions may contain connection details. Keep the console safe.
  console.error("Audio-cache migration failed:", error instanceof Error ? error.name : "unknown error");
  Deno.exitCode = 1;
} finally {
  await Promise.allSettled([sql.end(), mongo.close()]);
}
