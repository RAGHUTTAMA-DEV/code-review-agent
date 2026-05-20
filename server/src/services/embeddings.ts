import axios from 'axios';
import { Pinecone } from '@pinecone-database/pinecone';

const MAX_EMBEDDING_INPUT_CHARS = 6000;

const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY!,
});

const PINECONE_INDEX_NAME = process.env.PINECONE_INDEX_NAME || 'code-review';
const PINECONE_DIMENSION = 1024; // qwen3-embedding:latest (0.6B) outputs 1024-dim vectors

let indexReady = false;

async function ensureIndex(): Promise<void> {
  if (indexReady) return;

  try {
    await pinecone.describeIndex(PINECONE_INDEX_NAME);
    console.log(`Pinecone index "${PINECONE_INDEX_NAME}" found.`);
  } catch (err: any) {
    if (err?.name === 'PineconeNotFoundError' || err?.message?.includes('404')) {
      console.log(`Pinecone index "${PINECONE_INDEX_NAME}" not found — creating...`);
      await pinecone.createIndex({
        name: PINECONE_INDEX_NAME,
        dimension: PINECONE_DIMENSION,
        metric: 'cosine',
        spec: {
          serverless: {
            cloud: 'aws',
            region: 'us-east-1',
          },
        },
        waitUntilReady: true,
      });
      console.log(`Pinecone index "${PINECONE_INDEX_NAME}" created and ready.`);
    } else {
      throw err;
    }
  }

  indexReady = true;
}

function getIndex() {
  return pinecone.index(PINECONE_INDEX_NAME);
}

export async function getQwenEmbedding(text: string): Promise<number[]> {
  const truncated = text.length > MAX_EMBEDDING_INPUT_CHARS
    ? text.slice(0, MAX_EMBEDDING_INPUT_CHARS)
    : text;

  const response = await axios.post(
    'http://127.0.0.1:11434/api/embeddings',
    {
      model: 'qwen3-embedding:latest', 
      prompt: truncated
    },
    {
      headers: {
        'Content-Type': 'application/json'
      }
    }
  );

  return response.data.embedding;
}

export async function saveEmbeddings(content: string, fileId: string) {
  await ensureIndex();
  const embedding = await getQwenEmbedding(content);
  const index = getIndex();

  await index.upsert({
    records: [
      {
        id: fileId,
        values: embedding,
        metadata: {
          content: content.slice(0, 40000),
        },
      },
    ],
  });
}

// ─── Search similar documents in Pinecone ─────────────────────────────────────
export async function searchDocuments(queryEmbedding: number[], limit: number) {
  await ensureIndex();
  const index = getIndex();

  const results = await index.query({
    vector: queryEmbedding,
    topK: limit,
    includeMetadata: true,
  });

  return (results.matches || []).map((match) => ({
    id: match.id,
    content: (match.metadata as Record<string, string>)?.content || '',
    distance: 1 - (match.score || 0), 
  }));
}
