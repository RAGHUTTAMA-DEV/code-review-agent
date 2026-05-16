import axios from 'axios';
import prisma from '../prismaClient';
const MAX_EMBEDDING_INPUT_CHARS = 6000;

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
  const codeChunks = await getQwenEmbedding(content);

  await prisma.$executeRaw`
    INSERT INTO "Document" (id, content, embedding)
    VALUES (
      gen_random_uuid(),
      ${content},
      ${JSON.stringify(codeChunks)}::vector
    )
  `;
}

export async function searchDocuments(queryChunks: number[], limit: number) {
  const results = await prisma.$queryRaw`
    SELECT id, content, embedding <=> ${JSON.stringify(queryChunks)}::vector AS distance
    FROM "Document"
    ORDER BY distance ASC
    LIMIT ${limit};
  `;

  //@ts-ignore
  return results.map((row: any) => ({
    id: row.id,
    content: row.content,
    distance: row.distance
  }));
}
